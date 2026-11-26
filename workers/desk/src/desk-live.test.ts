import { describe, expect, test } from 'bun:test';

import { handleBundle } from '../../../supabase/functions/desk-public-rest/index';

import {
  coalesceLiveRead,
  expirePublicDeskLiveCache,
  liveCacheMaxAge,
  loadPublicDeskServe,
  resetPublicDeskLiveCache,
} from './desk-live';

const localAnon =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

function fakeJwt(role: string): string {
  const payload = Buffer.from(JSON.stringify({ iss: 'supabase-demo', role, exp: 1983812996 })).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

const readerEnv = {
  DESK_SUPABASE_URL: 'https://desk.example.test/functions/v1/desk-public-rest',
  DESK_READER_APIKEY: localAnon,
  DESK_READER_JWT: fakeJwt('desk_public_reader'),
};

describe('coalesceLiveRead', () => {
  test('concurrent callers share one read, and a failure can be retried', async () => {
    const state: { pending: Promise<string> | null } = { pending: null };
    let calls = 0;
    const read = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve(`ok-${calls}`), 20);
      });
    };
    const [a, b, c] = await Promise.all([
      coalesceLiveRead(state, read),
      coalesceLiveRead(state, read),
      coalesceLiveRead(state, read),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe('ok-1');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(state.pending).toBeNull();

    const again = await coalesceLiveRead(state, read);
    expect(calls).toBe(2);
    expect(again).toBe('ok-2');

    const failing: { pending: Promise<string> | null } = { pending: null };
    await expect(coalesceLiveRead(failing, () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(failing.pending).toBeNull();
    await expect(coalesceLiveRead(failing, () => Promise.resolve('back'))).resolves.toBe('back');
  });
});

describe('loadPublicDeskServe', () => {
  test('concurrent cold reads fetch /bundle/public once', async () => {
    resetPublicDeskLiveCache();
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(JSON.stringify({ runs: [], cloudRuns: [], automations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const [a, b, c] = await Promise.all([
        loadPublicDeskServe(readerEnv),
        loadPublicDeskServe(readerEnv),
        loadPublicDeskServe(readerEnv),
      ]);
      expect(calls).toBe(1);
      expect(a.json).toBe(b.json);
      expect(c.generated_at).toBe(a.generated_at);
      const before = calls;
      await loadPublicDeskServe(readerEnv);
      expect(calls).toBe(before);
    } finally {
      globalThis.fetch = original;
      resetPublicDeskLiveCache();
    }
  });

  test('bundle run rows join into routines, and a missing list does not invent a time', async () => {
    resetPublicDeskLiveCache();
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        runs: [{
          id: 441,
          run_type: 'market_scan',
          started_at: '2026-10-15T17:07:37.315Z',
          completed_at: '2026-10-15T17:12:37.052Z',
          notes: 'market_scan 2026-10-15',
        }],
        cloudRuns: [],
        automations: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const serve = await loadPublicDeskServe(readerEnv);
      const desk = JSON.parse(serve.json) as {
        routines: Array<{ id: string; last_run_at: string | null; last_outcome: string | null; last_summary: string | null }>;
      };
      const scan = desk.routines.find((row) => row.id === 'market_scan');
      const autopsy = desk.routines.find((row) => row.id === 'missed_swing_autopsy');
      expect(scan?.last_run_at).toBe('2026-10-15T17:07:37.315Z');
      expect(scan?.last_outcome).toBe('passed');
      expect(scan?.last_summary).toBe('market_scan 2026-10-15');
      expect(autopsy?.last_run_at).toBeNull();
      expect(autopsy?.last_summary).toBe('No run recorded');
      expect(urls.every((url) => url.includes('/bundle/public'))).toBe(true);
      expect(urls.some((url) => url.includes('/rest/v1/'))).toBe(false);
    } finally {
      globalThis.fetch = original;
      resetPublicDeskLiveCache();
    }
  });

  test('a failed refresh keeps the last good serve and marks it stale', async () => {
    resetPublicDeskLiveCache();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          runs: [],
          cloudRuns: [],
          automations: [],
          theses: [{
            id: 'semis_photonics',
            name: 'AI semiconductor and photonics',
            summary: 'Second-order compute.',
            status: 'hardening',
            confidence: 70,
            stated_confidence: null,
            results_confidence: null,
            time_horizon: 'quarters',
            stance: 'long',
            variant_perception: null,
            falsifier: null,
            created_at: '2026-09-01T00:00:00.000Z',
            updated_at: '2026-11-24T00:00:00.000Z',
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Desk ledger unavailable' }), { status: 503 });
    }) as typeof fetch;
    try {
      const first = await loadPublicDeskServe(readerEnv);
      expect(first.stale).toBeUndefined();
      const desk = JSON.parse(first.json) as { theses: Array<{ id: string }> };
      expect(desk.theses.map((row) => row.id)).toEqual(['semis_photonics']);
      expirePublicDeskLiveCache();
      const second = await loadPublicDeskServe(readerEnv);
      expect(calls).toBe(2);
      expect(second.stale).toBe(true);
      expect(second.json).toBe(first.json);
      expect(second.generated_at).toBe(first.generated_at);
      expect(JSON.parse(second.json)).toEqual(JSON.parse(first.json));
    } finally {
      globalThis.fetch = original;
      resetPublicDeskLiveCache();
    }
  });

  test('a core table failure keeps the last good book instead of an empty one', async () => {
    resetPublicDeskLiveCache();
    const original = globalThis.fetch;
    const deno = (globalThis as { Deno?: { env: { get: (key: string) => string | undefined } } }).Deno;
    (globalThis as { Deno?: { env: { get: (key: string) => string | undefined } } }).Deno = {
      env: {
        get: (key: string) => {
          if (key === 'SUPABASE_URL') return 'https://ledger.test';
          if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'service-role-test';
          return undefined;
        },
      },
    };
    let bundleCalls = 0;
    const position = {
      id: 'lot-nvda',
      account_key: 'agentic',
      symbol: 'NVDA',
      status: 'open',
      quantity: 2,
      average_cost: 100,
      opened_at: '2026-11-01T14:30:00.000Z',
      closed_at: null,
      next_review_at: null,
      thesis_id: 'semis_photonics',
      invalidation_price: 90,
      invalidation_note: 'below the line',
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/v1/')) {
        if (url.includes('/rest/v1/position_episodes?') || url.endsWith('/rest/v1/position_episodes')) {
          return new Response(JSON.stringify({ message: 'statement timeout' }), { status: 500 });
        }
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      bundleCalls += 1;
      if (bundleCalls === 1) {
        return new Response(JSON.stringify({
          runs: [],
          cloudRuns: [],
          automations: [],
          positions: [position],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return handleBundle('public');
    }) as typeof fetch;
    try {
      const first = await loadPublicDeskServe(readerEnv);
      expect(first.stale).toBeUndefined();
      const saved = JSON.parse(first.json) as { positions: Array<{ id: string; symbol: string }> };
      expect(saved.positions.map((row) => row.id)).toEqual(['lot-nvda']);
      expirePublicDeskLiveCache();
      const second = await loadPublicDeskServe(readerEnv);
      expect(bundleCalls).toBe(2);
      expect(second.stale).toBe(true);
      expect(second.json).toBe(first.json);
      expect(JSON.parse(second.json)).toEqual(JSON.parse(first.json));
      const kept = JSON.parse(second.json) as { positions: Array<{ symbol: string; invalidation_price: number }> };
      expect(kept.positions).toEqual([
        expect.objectContaining({ symbol: 'NVDA', invalidation_price: 90 }),
      ]);
    } finally {
      globalThis.fetch = original;
      (globalThis as { Deno?: unknown }).Deno = deno;
      resetPublicDeskLiveCache();
    }
  });

  test('a stored bundle keeps its generated_at and a stale header stays stale', async () => {
    resetPublicDeskLiveCache();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      generated_at: '2026-11-26T18:05:51.000Z',
      runs: [],
      cloudRuns: [],
      automations: [],
      theses: [],
      positions: [{
        id: 'lot-nvda',
        account_key: 'agentic',
        symbol: 'NVDA',
        status: 'open',
        quantity: 2,
        average_cost: 100,
        opened_at: '2026-11-01T14:30:00.000Z',
        closed_at: null,
        next_review_at: null,
        thesis_id: null,
        invalidation_price: 90,
        invalidation_note: 'below the line',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-desk-stale': '1' },
    })) as typeof fetch;
    try {
      const serve = await loadPublicDeskServe(readerEnv);
      expect(serve.stale).toBe(true);
      expect(serve.generated_at).toBe('2026-11-26T18:05:51.000Z');
      const desk = JSON.parse(serve.json) as { generated_at: string; positions: Array<{ id: string }> };
      expect(desk.generated_at).toBe('2026-11-26T18:05:51.000Z');
      expect(desk.positions.map((row) => row.id)).toEqual(['lot-nvda']);
      expect(liveCacheMaxAge(true)).toBe(5_000);
      expect(liveCacheMaxAge(false)).toBe(45_000);
    } finally {
      globalThis.fetch = original;
      resetPublicDeskLiveCache();
    }
  });

  test('with no last good serve, a bundle failure still throws', async () => {
    resetPublicDeskLiveCache();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    try {
      await expect(loadPublicDeskServe(readerEnv)).rejects.toThrow('desk_bundle_503');
    } finally {
      globalThis.fetch = original;
      resetPublicDeskLiveCache();
    }
  });
});
