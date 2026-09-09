import { describe, expect, test } from 'bun:test';

import { toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';

import { handleDeskApi, isWriteMethod, redirectFor } from './desk-api';
import { jwtRole, liveReaderReady } from './desk-live';

const liveSample = toPublicDeskSnapshot({
  generated_at: '2026-09-09T14:00:00.000Z',
  source: 'postgrest',
  theses: [{ id: 'neocloud_compute', status: 'hardening' }],
  book: { current_nav: 5120, starting_nav: 5000, observed_at: '2026-09-09T13:55:00.000Z', names: [] },
  routines: [{ id: 'market_scan', status: 'live' }],
  ontology_actions: [],
});

const localAnon =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

function fakeJwt(role: string): string {
  const payload = Buffer.from(JSON.stringify({ iss: 'supabase-demo', role, exp: 1983812996 })).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function env(extra: {
  DESK_SUPABASE_URL?: string;
  DESK_READER_APIKEY?: string;
  DESK_READER_JWT?: string;
} = {}) {
  return extra;
}

const readerEnv = {
  DESK_SUPABASE_URL: 'https://xqungxapqicdmboniezz.supabase.co',
  DESK_READER_APIKEY: localAnon,
  DESK_READER_JWT: fakeJwt('desk_public_reader'),
};

describe('public desk Worker API', () => {
  test('GET /api/desk loads the live ledger only', async () => {
    const response = await handleDeskApi(
      new Request('https://desk.test/api/desk'),
      env(readerEnv),
      async () => liveSample,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      source: string;
      generated_at: string;
      ontology_actions: unknown[];
      book: { current_nav: number | null };
    };
    expect(body.source).toBe('snapshot');
    expect(body.generated_at).toBe('2026-09-09T14:00:00.000Z');
    expect(body.ontology_actions).toEqual([]);
    expect(body.book.current_nav).toBe(5120);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy') || '').toContain("connect-src 'self'");
  });

  test('live read failure is a 503, not a published copy', async () => {
    const response = await handleDeskApi(
      new Request('https://desk.test/api/desk'),
      env(readerEnv),
      async () => {
        throw new Error('postgrest down');
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Desk ledger unavailable' });
  });

  test('missing reader credentials are a 503, not a silent KV fallback', async () => {
    const empty = await handleDeskApi(new Request('https://desk.test/api/desk'), env());
    expect(empty.status).toBe(503);
    expect(await empty.json()).toEqual({ error: 'Desk ledger unavailable' });
  });

  test('write methods never mutate ledger from public routes', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await handleDeskApi(
        new Request('https://desk.test/api/desk', { method }),
        env(readerEnv),
        async () => liveSample,
      );
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: 'Method not allowed' });
    }
    expect(isWriteMethod('GET')).toBe(false);
  });

  test('GET /api/health is live-only too', async () => {
    const ok = await handleDeskApi(
      new Request('https://desk.test/api/health'),
      env(readerEnv),
      async () => liveSample,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      generated_at: '2026-09-09T14:00:00.000Z',
      source: 'live',
    });
    const down = await handleDeskApi(
      new Request('https://desk.test/api/health'),
      env(),
    );
    expect(down.status).toBe(503);
  });

  test('publish ingest is gone', async () => {
    const put = await handleDeskApi(
      new Request('https://desk.test/internal/snapshot', {
        method: 'PUT',
        headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
        body: JSON.stringify(liveSample),
      }),
      env(readerEnv),
      async () => liveSample,
    );
    expect(put.status).toBe(405);
    expect(await put.json()).toEqual({ error: 'Method not allowed' });
  });

  test('retired desk paths redirect', () => {
    expect(redirectFor('/leaderboard')).toBe('/');
    expect(redirectFor('/board')).toBe('/');
    expect(redirectFor('/ranks')).toBe('/');
    expect(redirectFor('/book')).toBeNull();
    expect(redirectFor('/catalysts')).toBe('/events');
    expect(redirectFor('/ontology')).toBe('/theses');
    expect(redirectFor('/mates')).toBe('/team');
    expect(redirectFor('/risk')).toBe('/book');
    expect(redirectFor('/runs')).toBe('/book');
  });
});

describe('public desk reader credentials', () => {
  test('accepts only desk_public_reader JWTs with a publishable apikey', () => {
    expect(jwtRole(fakeJwt('desk_public_reader'))).toBe('desk_public_reader');
    expect(jwtRole(fakeJwt('service_role'))).toBe('service_role');
    expect(liveReaderReady(readerEnv)).toBe(true);
    expect(liveReaderReady({
      ...readerEnv,
      DESK_READER_JWT: fakeJwt('service_role'),
    })).toBe(false);
    expect(liveReaderReady({
      ...readerEnv,
      DESK_READER_APIKEY: 'sb_secret_nope',
    })).toBe(false);
  });

  test('live load uses one /bundle request, not per-table PostgREST', async () => {
    const source = await Bun.file(new URL('./desk-live.ts', import.meta.url)).text();
    expect(source).toContain('/bundle');
    expect(source).toContain('assembleDeskFromRestBag');
    expect(source).not.toContain('/rest/v1/');
    const fn = await Bun.file(new URL('../../../supabase/functions/desk-public-rest/index.ts', import.meta.url)).text();
    expect(fn).toContain("path === '/bundle'");
    expect(fn).toContain('handleBundle');
    expect(fn).toContain("req.method !== 'GET'");
    expect(fn).toContain("status: 405");
  });

  test('wrangler config has no KV snapshot binding', async () => {
    const wrangler = await Bun.file(new URL('../wrangler.jsonc', import.meta.url)).text();
    expect(wrangler).not.toContain('kv_namespaces');
    expect(wrangler).not.toContain('DESK_SNAPSHOT');
    expect(wrangler).not.toContain('DESK_PUBLISH_TOKEN');
    expect(wrangler).not.toContain('"secrets"');
    expect(wrangler).toContain('DESK_READER_APIKEY');
    expect(wrangler).toContain('DESK_READER_JWT');
  });

  test('service_role on the public Worker is refused with an error', async () => {
    let liveCalls = 0;
    const response = await handleDeskApi(
      new Request('https://desk.test/api/desk'),
      env({
        ...readerEnv,
        DESK_READER_JWT: fakeJwt('service_role'),
      }),
      async () => {
        liveCalls += 1;
        return liveSample;
      },
    );
    expect(liveCalls).toBe(0);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Desk ledger unavailable' });
  });
});
