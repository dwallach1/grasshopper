import {
  isPublicSnapshot,
  MAX_SNAPSHOT_BYTES,
  PUBLIC_DESK_REDIRECTS,
  publicDeskJsonError,
  SNAPSHOT_KV_KEY,
} from '@quantanamo/contracts/desk-snapshot';
import { secretsEqual } from '@quantanamo/shared/secrets';

import { liveReaderReady, loadPublicDeskLive } from './desk-live';

export const DESK_API_HEADERS = {
  'Cache-Control': 'public, max-age=15, stale-while-revalidate=60',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; connect-src 'self'",
} as const;

export type DeskBindings = {
  DESK_SNAPSHOT: KVNamespace;
  DESK_PUBLISH_TOKEN?: string;
  DESK_SUPABASE_URL?: string;
  DESK_READER_APIKEY?: string;
  DESK_READER_JWT?: string;
};

export type DeskApiContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type DeskLiveLoader = (env: DeskBindings) => Promise<unknown>;

export function jsonResponse(status: number, body: unknown, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...DESK_API_HEADERS,
      ...(status >= 400 ? { 'Cache-Control': 'no-store' } : {}),
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
  ctx?: DeskApiContext,
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

  if (path === '/internal/snapshot') {
    return handlePublish(request, env);
  }

  if (path === '/api/health' && request.method === 'GET') {
    return handleHealth(env, ctx, loadLive);
  }

  if (path === '/api/desk') {
    if (request.method !== 'GET') return publicError(405, 'Method not allowed');
    return handleSnapshotGet(env, ctx, loadLive);
  }

  if (path.startsWith('/api/') || path.startsWith('/internal/')) {
    if (isWriteMethod(request.method)) return publicError(405, 'Method not allowed');
    return publicError(404, 'Not found');
  }

  return publicError(404, 'Not found');
}

async function handleHealth(
  env: DeskBindings,
  ctx?: DeskApiContext,
  loadLive: DeskLiveLoader = loadPublicDeskLive,
): Promise<Response> {
  const served = await handleSnapshotGet(env, ctx, loadLive);
  if (served.status !== 200) return publicError(503);
  try {
    const parsed: unknown = await served.clone().json();
    if (!isPublicSnapshot(parsed)) return publicError(503);
    return jsonResponse(200, {
      ok: true,
      generated_at: parsed.generated_at,
      source: 'snapshot',
      live: liveReaderReady(env),
    });
  } catch {
    return publicError(503);
  }
}

async function readCachedSnapshot(env: DeskBindings): Promise<unknown | null> {
  const raw = await env.DESK_SNAPSHOT.get(SNAPSHOT_KV_KEY);
  if (!raw) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES) {
    console.error(JSON.stringify({ event: 'desk_snapshot_too_large' }));
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPublicSnapshot(parsed)) {
      console.error(JSON.stringify({ event: 'desk_snapshot_rejected' }));
      return null;
    }
    return parsed;
  } catch {
    console.error(JSON.stringify({ event: 'desk_snapshot_parse_failed' }));
    return null;
  }
}

async function persistSnapshot(
  env: DeskBindings,
  payload: unknown,
  ctx?: DeskApiContext,
): Promise<void> {
  const raw = JSON.stringify(payload);
  if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES) {
    console.error(JSON.stringify({ event: 'desk_live_too_large' }));
    return;
  }
  const write = env.DESK_SNAPSHOT.put(SNAPSHOT_KV_KEY, raw).catch((error: unknown) => {
    console.error(JSON.stringify({
      event: 'desk_cache_put_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }));
  });
  if (ctx) ctx.waitUntil(write);
  else await write;
}

async function handleSnapshotGet(
  env: DeskBindings,
  ctx?: DeskApiContext,
  loadLive: DeskLiveLoader = loadPublicDeskLive,
): Promise<Response> {
  const cached = await readCachedSnapshot(env);
  if (liveReaderReady(env)) {
    try {
      const live = await loadLive(env);
      if (!isPublicSnapshot(live)) {
        console.error(JSON.stringify({ event: 'desk_live_rejected' }));
      } else {
        console.error(JSON.stringify({
          event: 'desk_live_read',
          generated_at: live.generated_at,
        }));
        await persistSnapshot(env, live, ctx);
        return jsonResponse(200, live);
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'desk_live_read_failed',
        error: error instanceof Error ? error.message : 'unknown',
      }));
    }
  }
  if (cached) return jsonResponse(200, cached);
  return publicError(503);
}

async function handlePublish(request: Request, env: DeskBindings): Promise<Response> {
  if (request.method !== 'PUT') return publicError(405, 'Method not allowed');
  const expected = env.DESK_PUBLISH_TOKEN?.trim() || '';
  if (!expected) {
    console.error(JSON.stringify({ event: 'desk_publish_token_missing' }));
    return publicError(404, 'Not found');
  }
  const provided = bearerToken(request.headers.get('authorization'));
  if (!(await secretsEqual(provided, expected))) {
    console.error(JSON.stringify({ event: 'desk_publish_unauthorized' }));
    return publicError(404, 'Not found');
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_SNAPSHOT_BYTES) return publicError(404, 'Not found');

  const raw = await readBoundedBody(request);
  if (raw === null) return publicError(404, 'Not found');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return publicError(404, 'Not found');
  }
  if (!isPublicSnapshot(parsed)) {
    console.error(JSON.stringify({ event: 'desk_publish_invalid_payload' }));
    return publicError(404, 'Not found');
  }

  await env.DESK_SNAPSHOT.put(SNAPSHOT_KV_KEY, JSON.stringify(parsed));
  console.error(JSON.stringify({
    event: 'desk_snapshot_published',
    generated_at: parsed.generated_at,
  }));
  return jsonResponse(200, { ok: true, generated_at: parsed.generated_at });
}

function bearerToken(header: string | null): string {
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || '';
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SNAPSHOT_BYTES) {
        await reader.cancel('snapshot size limit exceeded');
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
