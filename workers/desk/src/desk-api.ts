import {
  isPublicSnapshot,
  LIVE_JSON_CACHE_CONTROL,
  MAX_SNAPSHOT_BYTES,
  PUBLIC_DESK_REDIRECTS,
  publicDeskJsonError,
} from '@quantanamo/contracts/desk-snapshot';

import { liveReaderReady, loadPublicDeskLive } from './desk-live';

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

export async function handleDeskApi(
  request: Request,
  env: DeskBindings,
  loadLive: DeskLiveLoader = loadPublicDeskLive,
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
    return handleHealth(env, loadLive);
  }

  if (path === '/api/desk') {
    if (request.method !== 'GET') return publicError(405, 'Method not allowed');
    return handleLiveGet(env, loadLive);
  }

  if (path.startsWith('/api/') || path.startsWith('/internal/')) {
    if (isWriteMethod(request.method)) return publicError(405, 'Method not allowed');
    return publicError(404, 'Not found');
  }

  return publicError(404, 'Not found');
}

async function handleHealth(
  env: DeskBindings,
  loadLive: DeskLiveLoader,
): Promise<Response> {
  const served = await handleLiveGet(env, loadLive);
  if (served.status !== 200) return publicError(503);
  try {
    const parsed: unknown = await served.clone().json();
    if (!isPublicSnapshot(parsed)) return publicError(503);
    return jsonResponse(200, {
      ok: true,
      generated_at: parsed.generated_at,
      source: 'live',
    });
  } catch {
    return publicError(503);
  }
}

async function handleLiveGet(
  env: DeskBindings,
  loadLive: DeskLiveLoader,
): Promise<Response> {
  if (!liveReaderReady(env)) {
    console.error(JSON.stringify({ event: 'desk_reader_unconfigured' }));
    return publicError(503);
  }
  try {
    const live = await loadLive(env);
    if (!isPublicSnapshot(live)) {
      console.error(JSON.stringify({ event: 'desk_live_rejected' }));
      return publicError(503);
    }
    const raw = JSON.stringify(live);
    if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES) {
      console.error(JSON.stringify({ event: 'desk_live_too_large' }));
      return publicError(503);
    }
    console.error(JSON.stringify({
      event: 'desk_live_read',
      generated_at: live.generated_at,
    }));
    return jsonResponse(200, live);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'desk_live_read_failed',
      error: error instanceof Error ? error.message : 'unknown',
      configured: liveReaderReady(env),
    }));
    return publicError(503);
  }
}
