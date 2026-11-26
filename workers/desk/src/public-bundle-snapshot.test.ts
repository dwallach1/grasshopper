import { describe, expect, test } from 'bun:test';

import { bundleIsFresh, usableBundlePayload } from '../../../supabase/functions/desk-public-rest/bundle-cache';
import { DESK_REST_CONCURRENCY, handleBundle, resetDeskRestSlots } from '../../../supabase/functions/desk-public-rest/index';

function installDenoEnv(): void {
  (globalThis as { Deno?: { env: { get: (key: string) => string | undefined } } }).Deno = {
    env: {
      get: (key: string) => {
        if (key === 'SUPABASE_URL') return 'https://ledger.test';
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'service-role-test';
        return undefined;
      },
    },
  };
}

function methodOf(init: RequestInit | undefined): string {
  return init?.method || 'GET';
}

describe('desk public bundle snapshot', () => {
  test('a ready payload is a book, and an empty object is not', () => {
    expect(usableBundlePayload({ theses: [], positions: [] })).toBe(true);
    expect(usableBundlePayload({})).toBe(false);
    expect(usableBundlePayload({ theses: [], positions: null })).toBe(false);
    expect(usableBundlePayload([])).toBe(false);
    expect(bundleIsFresh(new Date().toISOString())).toBe(true);
    expect(bundleIsFresh('2020-01-01T00:00:00.000Z')).toBe(false);
    expect(bundleIsFresh('not-a-time')).toBe(false);
  });

  test('a fresh stored bundle is served without reading the ledger', async () => {
    installDenoEnv();
    resetDeskRestSlots();
    const original = globalThis.fetch;
    const generatedAt = new Date().toISOString();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/v1/desk_public_bundle')) {
        return Response.json([{
          id: 'public',
          ready: true,
          generated_at: generatedAt,
          refresh_failed_at: null,
          payload: {
            theses: [{ id: 'semis_photonics' }],
            positions: [{ id: 'lot-nvda', symbol: 'NVDA' }],
          },
        }]);
      }
      throw new Error(`ledger read ${url}`);
    }) as typeof fetch;
    try {
      const response = await handleBundle('public');
      expect(response.status).toBe(200);
      expect(response.headers.get('x-desk-stale')).toBeNull();
      const body = await response.json() as { positions: Array<{ id: string }>; generated_at: string };
      expect(body.positions).toEqual([{ id: 'lot-nvda', symbol: 'NVDA' }]);
      expect(body.generated_at).toBe(generatedAt);
    } finally {
      globalThis.fetch = original;
      resetDeskRestSlots();
    }
  });

  test('a failed refresh serves the same book and does not wait on the ledger', async () => {
    installDenoEnv();
    resetDeskRestSlots();
    const original = globalThis.fetch;
    const previous = (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
    let releaseLedger: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLedger = resolve;
    });
    const scheduled: Array<Promise<unknown>> = [];
    (globalThis as { EdgeRuntime?: { waitUntil: (work: Promise<unknown>) => void } }).EdgeRuntime = {
      waitUntil(work) {
        scheduled.push(work);
      },
    };
    const generatedAt = '2026-11-26T18:05:51.000Z';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = methodOf(init);
      if (url.includes('/rest/v1/desk_public_bundle') && method === 'GET') {
        return Response.json([{
          id: 'public',
          ready: true,
          generated_at: generatedAt,
          refresh_failed_at: '2026-11-26T18:23:03.000Z',
          payload: {
            theses: [],
            positions: [{ id: 'lot-nvda', symbol: 'NVDA', invalidation_price: 90 }],
          },
        }]);
      }
      if (url.includes('/rpc/claim_desk_public_refresh')) return Response.json(true);
      if (url.includes('/rest/v1/')) {
        await gate;
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(url);
    }) as typeof fetch;
    try {
      const response = await Promise.race([
        handleBundle('public'),
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error('blocked on ledger')), 300);
        }),
      ]);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-desk-stale')).toBe('1');
      const body = await response.json() as { positions: Array<{ id: string; invalidation_price: number }> };
      expect(body.positions).toEqual([{ id: 'lot-nvda', symbol: 'NVDA', invalidation_price: 90 }]);
      releaseLedger();
      await Promise.all(scheduled);
    } finally {
      releaseLedger();
      globalThis.fetch = original;
      (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = previous;
      resetDeskRestSlots();
    }
  });

  test('a core miss with no stored book is still 503, and a stored book is not replaced by an empty one', async () => {
    installDenoEnv();
    resetDeskRestSlots();
    const original = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = methodOf(init);
      if (url.includes('/rest/v1/desk_public_bundle') && method === 'GET') {
        reads += 1;
        if (reads === 1) return Response.json([]);
        return Response.json([{
          id: 'public',
          ready: true,
          generated_at: '2026-11-26T18:05:51.000Z',
          refresh_failed_at: null,
          payload: { theses: [], positions: [{ id: 'kept' }] },
        }]);
      }
      if (url.includes('/rest/v1/position_episodes')) {
        return new Response(JSON.stringify({ message: 'statement timeout' }), { status: 500 });
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const response = await handleBundle('public');
      expect(response.status).toBe(200);
      expect(response.headers.get('x-desk-stale')).toBe('1');
      const body = await response.json() as { positions: Array<{ id: string }> };
      expect(body.positions).toEqual([{ id: 'kept' }]);
    } finally {
      globalThis.fetch = original;
      resetDeskRestSlots();
    }
  });

  test('ledger reads stay within the statement-timeout fan-out cap', async () => {
    installDenoEnv();
    resetDeskRestSlots();
    const original = globalThis.fetch;
    let active = 0;
    let max = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/v1/desk_public_bundle') || url.includes('/rpc/claim_desk_public_refresh')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const response = await handleBundle('public');
      expect(response.status).toBe(200);
      expect(max).toBeGreaterThan(1);
      expect(max).toBeLessThanOrEqual(DESK_REST_CONCURRENCY);
      expect(DESK_REST_CONCURRENCY).toBe(4);
    } finally {
      globalThis.fetch = original;
      resetDeskRestSlots();
    }
  });

  test('desk_public_reader is not granted the snapshot table', async () => {
    const migration = await Bun.file(new URL(
      '../../../supabase/migrations/20261126183000_desk_public_bundle.sql',
      import.meta.url,
    )).text();
    const schema = await Bun.file(new URL(
      '../../../supabase/schemas/107_desk_public_bundle.sql',
      import.meta.url,
    )).text();
    expect(schema).toBe(migration);
    expect(migration).toContain(
      'revoke all on table public.desk_public_bundle from public, anon, authenticated, desk_public_reader',
    );
    expect(migration).toContain('grant select, insert, update on table public.desk_public_bundle to service_role');
    const grants = migration.split('\n').filter((line) => line.startsWith('grant '));
    expect(grants).toEqual([
      'grant select, insert, update on table public.desk_public_bundle to service_role;',
      'grant execute on function public.claim_desk_public_refresh(text) to service_role;',
    ]);
    expect(migration).toContain('security invoker');
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain('enable row level security');
    const fn = await Bun.file(new URL(
      '../../../supabase/functions/desk-public-rest/index.ts',
      import.meta.url,
    )).text();
    expect(fn).toContain('DESK_REST_CONCURRENCY = 4');
    const allowed = fn.slice(fn.indexOf('const ALLOWED_TABLES'), fn.indexOf('const TABLE_RE'));
    expect(allowed).not.toContain('desk_public_bundle');
  });
});
