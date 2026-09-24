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
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=45, stale-while-revalidate=90',
    );
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
      marks_lagging: false,
      stale_opens: 0,
      resolved_still_open: 0,
      stale_catalog: 0,
      learning: {
        to_review: 0,
        lessons_open: 0,
        lessons_incorporated: 0,
        beliefs_in_force: 0,
        open_books: 0,
        open_books_tagged: 0,
        open_books_gate_ok: 0,
        open_books_legacy_untagged: 0,
        open_books_missing_gate: 0,
      },
    });
    expect(ok.headers.get('cache-control')).toBe('no-store');
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
    expect(source).toContain('/bundle/public');
    expect(source).toContain("response.status === 404");
    expect(source).toContain('assemblePublicDeskFromRestBag');
    expect(source).toContain('beliefs: asJsonRows(bag.beliefs)');
    expect(source).toContain('lessons: asJsonRows(bag.lessons)');
    expect(source).toContain('candidates: asJsonRows(bag.candidates)');
    expect(source).toContain('pnl_start: asObjectRow(bag.pm?.pnl_start)');
    expect(source).toContain('pnl_start: asObjectRow(bag.meme?.pnl_start)');
    expect(source).not.toContain('assembleDeskFromRestBag');
    expect(source).toContain('readBoundedJson');
    expect(source).toContain('LIVE_CACHE_MS = PUBLIC_LIVE_INTERVAL_MS');
    expect(source).toContain('JSON.stringify(published)');
    expect(source).not.toContain('await response.json()');
    expect(source).not.toContain('/rest/v1/');
    const fn = await Bun.file(new URL('../../../supabase/functions/desk-public-rest/index.ts', import.meta.url)).text();
    expect(fn).toContain("path === '/bundle/public'");
    expect(fn).toContain("path === '/bundle'");
    expect(fn).toContain('handleBundle');
    expect(fn).toContain("mode === 'public'");
    expect(fn).toContain("'candidates'");
    expect(fn).toContain('status=eq.pending');
    expect(fn).toContain('PUBLIC_CANDIDATE_FETCH = 72');
    expect(fn).toContain('PUBLIC_PNL_LIMIT = 28');
    expect(fn).toContain('PUBLIC_NOTE_LIMIT = 24');
    expect(fn).toContain('PUBLIC_NOTE_BODY = 200');
    expect(fn).toContain('PUBLIC_ACCOUNT_LIMIT = 56');
    expect(fn).toContain('PUBLIC_TEXT = 220');
    expect(fn).toContain('latest.length < PUBLIC_ACCOUNT_LIMIT');
    expect(fn).toContain("clipRows(asRows(body.beliefs), 'rationale', PUBLIC_TEXT)");
    expect(fn).toContain("clipRows(asRows(body.lessons), 'summary', PUBLIC_TEXT)");
    expect(fn).toContain('status=eq.pending&order=candidate_type.asc,score.desc,source_count.desc,id.desc&limit=${PUBLIC_CANDIDATE_FETCH}');
    expect(fn).toContain('candidate_type.asc,status.asc,score.desc,source_count.desc,id.desc&limit=200');
    expect(fn).toContain("const PM_PNL_PUBLIC_COLS = 'id,account_key,as_of,realized,unrealized,fees,cash,equity'");
    expect(fn).toContain("const MEME_PNL_PUBLIC_COLS = 'id,account_key,as_of,realized,unrealized,fees,cash_sol,equity_sol'");
    expect(fn).toContain('order=as_of.desc,id.desc&limit=${limit}');
    expect(fn).toContain('order=as_of.asc,id.asc&limit=1');
    expect(fn).toContain('attachPnlStart');
    expect(fn).toContain('pnl_start: pmPnl.pnl_start');
    expect(fn).toContain('pnl_start: memePnl.pnl_start');
    expect(fn).not.toContain('order=as_of.desc&limit=${PUBLIC_PNL_LIMIT}');
    expect(fn).toContain('closed_at,untagged:meta->>untagged&order=updated_at.desc&limit=200');
    expect(fn).not.toContain('source_count=gte.2');
    expect(fn).toContain('id.desc&limit=200');
    expect(fn).toContain("req.method !== 'GET'");
    expect(fn).toContain("status: 405");
    expect(fn).toContain("'belief_updates'");
    expect(fn).toContain("'beliefs'");
    expect(fn).toContain("'lessons'");
    expect(fn).toContain('position_episodes?select=');
    expect(fn).toContain('next_review_at,thesis_id,untagged:meta->>untagged');
    expect(fn).toContain('thesis_text,untagged:meta->>untagged');
    expect(fn).toMatch(/PUBLIC_KEYS = new Set\(\[[^\]]*['"]beliefs['"]/);
    expect(fn).toMatch(/PUBLIC_KEYS = new Set\(\[[^\]]*['"]lessons['"]/s);
    expect(fn).toContain('not_allowed');
    expect(fn).not.toContain("key === 'beliefs'");
    const api = await Bun.file(new URL('./desk-api.ts', import.meta.url)).text();
    expect(api).toContain('assembleDeskBookHealth');
    expect(api).toContain('assembleLearningPulse');
    expect(api).toContain('learningPulseSummary');
    expect(api).toContain('waitUntil');
    expect(api).not.toContain('.clone().json()');
    expect(api).not.toContain('served.clone()');
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
