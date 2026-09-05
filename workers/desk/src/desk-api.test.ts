import { describe, expect, test } from 'bun:test';

import { toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';

import { handleDeskApi, isWriteMethod, redirectFor } from './desk-api';

const sample = toPublicDeskSnapshot({
  generated_at: '2026-09-05T12:00:00.000Z',
  source: 'postgres',
  theses: [{ id: 'neocloud_compute', status: 'hardening' }],
  book: { current_nav: null, starting_nav: null, observed_at: null, names: [] },
  routines: [{ id: 'market_scan', status: 'live' }],
  ontology_actions: [{ id: 9, actor_id: 'secret-user', action: 'promote' }],
});

class MemoryKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function env(kv = new MemoryKv(), token = 'publish-token') {
  return {
    DESK_SNAPSHOT: kv as unknown as KVNamespace,
    DESK_PUBLISH_TOKEN: token,
  };
}

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
    expect(redirectFor('/book')).toBe('/');
    expect(redirectFor('/catalysts')).toBe('/events');
    expect(redirectFor('/ontology')).toBe('/theses');
  });
});
