import {
  isPublicSnapshot,
  LIVE_JSON_CACHE_CONTROL,
  MAX_SNAPSHOT_BYTES,
  PUBLIC_DESK_REDIRECTS,
  PUBLIC_DESK_REFRESH_FAILED,
  publicDeskJsonError,
} from '@quantanamo/contracts/desk-snapshot';

import { assembleDeskBookHealth, deskHealthSummary } from '../../../apps/dashboard/lib/desk-book-health';
import { retiredStewardSlugs } from '../../../apps/dashboard/lib/desk-team';
import { watchdogHealthSummary } from '../../../apps/dashboard/lib/ledger-watchdog';
import {
  assembleLearningPulse,
  learningPulseSummary,
} from '../../../apps/dashboard/lib/learning-pulse';
import type { DeskPayload } from '../../../apps/dashboard/lib/ledger-types';

import { errorFields, liveReaderReady, loadPublicDeskServe, type PublicDeskServe } from './desk-live';

export const DESK_API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; connect-src 'self'",
} as const;

export type DeskBindings = {
  DESK_SUPABASE_URL?: string;
  DESK_READER_APIKEY?: string;
  DESK_READER_JWT?: string;
};

export type DeskLiveLoader = (env: DeskBindings) => Promise<unknown>;

export function jsonResponse(status: number, body: unknown, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...DESK_API_HEADERS,
      ...(status >= 400
        ? { 'Cache-Control': 'no-store' }
        : { 'Cache-Control': LIVE_JSON_CACHE_CONTROL }),
      ...extra,
    },
  });
}

export function publicError(status: number, message?: string): Response {
  return jsonResponse(status, publicDeskJsonError(message));
}

export function redirectFor(pathname: string): string | null {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const hit = PUBLIC_DESK_REDIRECTS.find((row) => row.source === normalized);
  return hit?.destination ?? null;
}

export function isWriteMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function isServe(value: unknown): value is PublicDeskServe {
  if (!value || typeof value !== 'object') return false;
  const row = value as { desk?: unknown; json?: unknown; generated_at?: unknown };
  return isPublicSnapshot(row.desk) && typeof row.json === 'string' && typeof row.generated_at === 'string';
}

function asServe(live: unknown): PublicDeskServe | null {
  if (isServe(live)) return live;
  if (!isPublicSnapshot(live)) return null;
  return {
    desk: live,
    json: JSON.stringify(live),
    generated_at: live.generated_at,
  };
}

function edgeCache(): Cache | null {
  try {
    if (typeof caches === 'undefined') return null;
    // Workers expose caches.default; the DOM CacheStorage type in this tsconfig does not declare it.
    const storage = caches as CacheStorage & { default?: Cache };
    return storage.default ?? null;
  } catch {
    return null;
  }
}

export async function handleDeskApi(
  request: Request,
  env: DeskBindings,
  loadLive: DeskLiveLoader = loadPublicDeskServe,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const redirected = redirectFor(path);
  if (redirected && request.method === 'GET') {
    return new Response(null, {
      status: 302,
      headers: { Location: redirected, ...DESK_API_HEADERS, 'Content-Type': 'text/plain' },
    });
  }

  if (path === '/api/health' && request.method === 'GET') {
    return handleHealth(request, env, loadLive);
  }

  if (path === '/api/desk') {
    if (request.method !== 'GET') return publicError(405, 'Method not allowed');
    return handleLiveGet(request, env, loadLive, ctx);
  }

  if (path.startsWith('/api/') || path.startsWith('/internal/')) {
    if (isWriteMethod(request.method)) return publicError(405, 'Method not allowed');
    return publicError(404, 'Not found');
  }

  return publicError(404, 'Not found');
}

function staleHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Desk-Stale': '1',
  };
}

/** Degraded non-core sections on a published snapshot. Empty when the read was complete. */
function partialSections(desk: unknown): string[] {
  if (!desk || typeof desk !== 'object') return [];
  const notes = (desk as { read_notes?: unknown }).read_notes;
  if (!Array.isArray(notes)) return [];
  return notes.filter((note): note is string => typeof note === 'string' && note.length > 0);
}

function healthResponse(served: PublicDeskServe): Response {
  const payload = served.desk as DeskPayload;
  const retired = retiredStewardSlugs(payload);
  const health = deskHealthSummary(assembleDeskBookHealth(payload, Date.now()));
  const learning = learningPulseSummary(assembleLearningPulse(payload));
  const watchdog = watchdogHealthSummary(payload.watchdog, retired);
  const partial = partialSections(served.desk);
  return jsonResponse(200, {
    ok: true,
    generated_at: served.generated_at,
    source: 'live',
    ...health,
    watchdog,
    learning,
    ...(partial.length ? { partial } : {}),
    ...(served.stale ? { stale: true, notice: PUBLIC_DESK_REFRESH_FAILED } : {}),
  }, served.stale ? staleHeaders() : { 'Cache-Control': 'no-store' });
}

function deskResponse(served: PublicDeskServe): Response {
  return new Response(served.json, {
    status: 200,
    headers: {
      ...DESK_API_HEADERS,
      'Cache-Control': served.stale ? 'no-store' : LIVE_JSON_CACHE_CONTROL,
      ...(served.stale ? { 'X-Desk-Stale': '1' } : {}),
    },
  });
}

/** Last published /api/desk body in this colo, ignoring a cache-busting query. */
async function cachedDeskServe(request: Request): Promise<PublicDeskServe | null> {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const url = new URL(request.url);
    url.pathname = '/api/desk';
    url.search = '';
    const hit = await cache.match(new Request(url, { method: 'GET' }));
    if (!hit) return null;
    const json = await hit.text();
    const desk = JSON.parse(json) as unknown;
    if (!isPublicSnapshot(desk)) return null;
    return { desk, json, generated_at: desk.generated_at, stale: true };
  } catch {
    return null;
  }
}

async function handleHealth(
  request: Request,
  env: DeskBindings,
  loadLive: DeskLiveLoader,
): Promise<Response> {
  if (!liveReaderReady(env) && loadLive === loadPublicDeskServe) {
    return publicError(503);
  }
  try {
    const served = asServe(await loadLive(env));
    if (!served) {
      console.error(JSON.stringify({ event: 'desk_live_rejected' }));
      return publicError(503);
    }
    return healthResponse(served);
  } catch (error) {
    const cached = await cachedDeskServe(request);
    const fields = errorFields(error);
    if (cached) {
      console.error(JSON.stringify({
        event: 'desk_live_stale',
        error: fields.error,
        name: fields.name,
        generated_at: cached.generated_at,
      }));
      return healthResponse(cached);
    }
    console.error(JSON.stringify({
      event: 'desk_health_failed',
      error: fields.error,
      name: fields.name,
    }));
    return publicError(503);
  }
}

async function handleLiveGet(
  request: Request,
  env: DeskBindings,
  loadLive: DeskLiveLoader,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!liveReaderReady(env)) {
    console.error(JSON.stringify({ event: 'desk_reader_unconfigured' }));
    return publicError(503);
  }
  const cache = edgeCache();
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) return hit;
    } catch {
      // isolate cache is enough when Cache API is unavailable
    }
  }
  try {
    const served = asServe(await loadLive(env));
    if (!served) {
      console.error(JSON.stringify({ event: 'desk_live_rejected' }));
      return publicError(503);
    }
    if (new TextEncoder().encode(served.json).byteLength > MAX_SNAPSHOT_BYTES) {
      console.error(JSON.stringify({ event: 'desk_live_too_large' }));
      return publicError(503);
    }
    if (!served.stale) {
      console.error(JSON.stringify({
        event: 'desk_live_read',
        generated_at: served.generated_at,
      }));
    }
    const response = deskResponse(served);
    if (cache && ctx && !served.stale) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  } catch (error) {
    const cached = await cachedDeskServe(request);
    const fields = errorFields(error);
    if (cached) {
      console.error(JSON.stringify({
        event: 'desk_live_stale',
        error: fields.error,
        name: fields.name,
        generated_at: cached.generated_at,
        configured: liveReaderReady(env),
      }));
      return deskResponse(cached);
    }
    console.error(JSON.stringify({
      event: 'desk_live_read_failed',
      error: fields.error,
      name: fields.name,
      configured: liveReaderReady(env),
    }));
    return publicError(503);
  }
}
