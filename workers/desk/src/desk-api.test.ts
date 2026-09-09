import { describe, expect, test } from 'bun:test';

import { toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';

import { handleDeskApi, isWriteMethod, redirectFor } from './desk-api';
import { jwtRole, liveReaderReady } from './desk-live';

const sample = toPublicDeskSnapshot({
  generated_at: '2026-09-05T12:00:00.000Z',
  source: 'postgres',
  theses: [{ id: 'neocloud_compute', status: 'hardening' }],
  book: { current_nav: null, starting_nav: null, observed_at: null, names: [] },
  routines: [{ id: 'market_scan', status: 'live' }],
  ontology_actions: [{ id: 9, actor_id: 'secret-user', action: 'promote' }],
});

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

class MemoryKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function env(kv = new MemoryKv(), token = 'publish-token', extra: {
  DESK_SUPABASE_URL?: string;
  DESK_READER_APIKEY?: string;
  DESK_READER_JWT?: string;
} = {}) {
  return {
    DESK_SNAPSHOT: kv as unknown as KVNamespace,
    DESK_PUBLISH_TOKEN: token,
    ...extra,
  };
}

const readerEnv = {
  DESK_SUPABASE_URL: 'https://xqungxapqicdmboniezz.supabase.co',
  DESK_READER_APIKEY: localAnon,
  DESK_READER_JWT: fakeJwt('desk_public_reader'),
};

describe('public desk Worker API', () => {
  test('GET /api/desk serves only a curated snapshot', async () => {
    const kv = new MemoryKv();
    await kv.put('current', JSON.stringify(sample));
    const response = await handleDeskApi(new Request('https://desk.test/api/desk'), env(kv));
    expect(response.status).toBe(200);
    const body = await response.json() as { source: string; ontology_actions: unknown[]; book: { current_nav: number | null } };
    expect(body.source).toBe('snapshot');
    expect(body.ontology_actions).toEqual([]);
    expect(body.book.current_nav).toBeNull();
    expect(response.headers.get('content-security-policy') || '').toContain("connect-src 'self'");
  });

  test('missing or live-shaped payloads stay generic 503', async () => {
    const empty = await handleDeskApi(new Request('https://desk.test/api/desk'), env());
    expect(empty.status).toBe(503);
    expect(await empty.json()).toEqual({ error: 'Desk snapshot unavailable' });

    const kv = new MemoryKv();
    await kv.put('current', JSON.stringify({
      ...sample,
      source: 'postgres',
    }));
    const live = await handleDeskApi(new Request('https://desk.test/api/desk'), env(kv));
    expect(live.status).toBe(503);
    const text = await live.text();
    expect(text).not.toContain('postgres');
    expect(text).not.toContain('theses');
  });

  test('GET /api/desk returns live ledger without a prior snapshot PUT', async () => {
    const kv = new MemoryKv();
    const response = await handleDeskApi(
      new Request('https://desk.test/api/desk'),
      env(kv, 'publish-token', readerEnv),
      undefined,
      async () => liveSample,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { source: string; generated_at: string; book: { current_nav: number | null } };
    expect(body.source).toBe('snapshot');
    expect(body.generated_at).toBe('2026-09-09T14:00:00.000Z');
    expect(body.book.current_nav).toBe(5120);
    expect(JSON.parse(kv.store.get('current') || '{}').generated_at).toBe('2026-09-09T14:00:00.000Z');
  });

  test('live read failure serves last-good cache and never a blank desk', async () => {
    const kv = new MemoryKv();
    await kv.put('current', JSON.stringify(sample));
    const response = await handleDeskApi(
      new Request('https://desk.test/api/desk'),
      env(kv, 'publish-token', readerEnv),
      undefined,
      async () => {
        throw new Error('postgrest down');
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { generated_at: string };
    expect(body.generated_at).toBe(sample.generated_at);
  });

  test('write methods never mutate the snapshot from public routes', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await handleDeskApi(
        new Request('https://desk.test/api/desk', { method }),
        env(),
      );
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: 'Method not allowed' });
    }
    expect(isWriteMethod('GET')).toBe(false);
  });

  test('publish ingest is token-gated and hidden on failure', async () => {
    const kv = new MemoryKv();
    const denied = await handleDeskApi(
      new Request('https://desk.test/internal/snapshot', {
        method: 'PUT',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: JSON.stringify(sample),
      }),
      env(kv),
    );
    expect(denied.status).toBe(404);
    expect(kv.store.size).toBe(0);

    const ok = await handleDeskApi(
      new Request('https://desk.test/internal/snapshot', {
        method: 'PUT',
        headers: { authorization: 'Bearer publish-token', 'content-type': 'application/json' },
        body: JSON.stringify(sample),
      }),
      env(kv),
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(kv.store.get('current') || '{}').source).toBe('snapshot');
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

  test('service_role on the public Worker is refused and last-good cache still serves', async () => {
    const kv = new MemoryKv();
    await kv.put('current', JSON.stringify(sample));
    let liveCalls = 0;
    const response = await handleDeskApi(
      new Request('https://desk.test/api/desk'),
      env(kv, 'publish-token', {
        ...readerEnv,
        DESK_READER_JWT: fakeJwt('service_role'),
      }),
      undefined,
      async () => {
        liveCalls += 1;
        return liveSample;
      },
    );
    expect(liveCalls).toBe(0);
    expect(response.status).toBe(200);
    const body = await response.json() as { generated_at: string };
    expect(body.generated_at).toBe(sample.generated_at);
  });
});
