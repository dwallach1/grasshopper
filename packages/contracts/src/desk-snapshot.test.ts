import { describe, expect, test } from 'bun:test';

import {
  DESK_ARRAY_KEYS,
  DESK_PUBLIC_READER_ROLE,
  hydratePublicDesk,
  isJunkOntologyLabel,
  isPublicSnapshot,
  LIVE_JSON_CACHE_CONTROL,
  ONTOLOGY_JUNK_LABELS,
  parseDeskWire,
  PUBLIC_CANDIDATE_CAP,
  PUBLIC_CANDIDATE_FETCH,
  PUBLIC_DESK_REDIRECTS,
  PUBLIC_DESK_REFRESH_FAILED,
  publicDeskJsonError,
  publicPendingCandidates,
  toPublicDeskSnapshot,
} from './desk-snapshot';

const sample = {
  generated_at: '2026-09-05T00:00:00.000Z',
  source: 'postgres' as const,
  theses: [{ id: 'neocloud_compute', status: 'hardening' }],
  book: {
    current_nav: null,
    starting_nav: null,
    observed_at: null,
    names: [],
  },
  routines: [{ id: 'market_scan', status: 'live' }],
  ontology_actions: [{ id: 1, actor_id: 'user-uuid', action: 'promote' }],
  evidence: [{ id: 1 }],
  runs: [{ id: 1 }],
  prediction_markets: { markets: [] },
  meme_coins: { tokens: [] },
  team: {
    agents: [{ slug: 'grasshopper', display_name: 'GRASSHOPPER', heartbeat_at: null }],
    domains: [{ slug: 'ledger', name: 'Ledger' }],
    stewards: [],
    accounts: [],
  },
};

describe('public desk snapshot contract', () => {
  test('accepts a curated envelope and rejects a live source for public serve', () => {
    const live = parseDeskWire(sample);
    expect(isPublicSnapshot(live)).toBe(false);
    const published = toPublicDeskSnapshot(live);
    expect(published.source).toBe('snapshot');
    expect(published.ontology_actions).toEqual([]);
    expect(published.evidence).toEqual([]);
    expect(published.runs).toEqual([]);
    expect(published.tests).toEqual([]);
    expect(published.queue).toEqual([]);
    expect(published.proposals).toEqual([]);
    expect(published.tests[0]).toBeUndefined();
    expect(published.prediction_markets).toEqual({
      markets: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [],
      notes: [],
    });
    expect(LIVE_JSON_CACHE_CONTROL).toContain('s-maxage=15');
    expect(PUBLIC_DESK_REFRESH_FAILED).toContain('last good ledger');
    expect(published.meme_coins).toEqual({
      tokens: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [],
      notes: [],
    });
    expect(published.team).toEqual(sample.team);
    expect(published.book.current_nav).toBeNull();
    expect(isPublicSnapshot(published)).toBe(true);
    expect(published.beliefs).toEqual([]);
    expect(published.lessons).toEqual([]);
  });

  test('public snapshot keeps lean pending candidates and drops actions', () => {
    const published = toPublicDeskSnapshot({
      ...sample,
      ontology_candidates: [
        { id: 3, status: 'promoted', score: 99, source_count: 8, proposed_label: 'old', candidate_type: 'term' },
        { id: 1, status: 'pending', score: 40, source_count: 9, proposed_label: 'low', candidate_type: 'term' },
        { id: 2, status: 'pending', score: 100, source_count: 2, proposed_label: 'DOCN', candidate_type: 'membership' },
      ],
    });
    expect(published.ontology_candidates).toEqual([
      { id: 2, status: 'pending', score: 100, source_count: 2, proposed_label: 'DOCN', candidate_type: 'membership' },
      { id: 1, status: 'pending', score: 40, source_count: 9, proposed_label: 'low', candidate_type: 'term' },
    ]);
    expect(published.ontology_actions).toEqual([]);
  });

  test('review ranking prefers memberships, drops deny-list junk, keeps ledger scores', () => {
    expect(PUBLIC_CANDIDATE_CAP).toBe(40);
    expect(PUBLIC_CANDIDATE_FETCH).toBe(200);
    expect(ONTOLOGY_JUNK_LABELS).toContain('https');
    expect(ONTOLOGY_JUNK_LABELS).toContain('stocks');
    expect(isJunkOntologyLabel('https t.co', 'term')).toBe(true);
    expect(isJunkOntologyLabel('STOCKS', 'membership')).toBe(true);
    expect(isJunkOntologyLabel('DOCN', 'membership')).toBe(false);
    expect(isJunkOntologyLabel('power', 'term')).toBe(false);

    const ranked = publicPendingCandidates([
      { id: 351, status: 'pending', score: 95, source_count: 3, proposed_label: 'https', candidate_type: 'term' },
      { id: 402, status: 'pending', score: 95, source_count: 2, proposed_label: 'stocks', candidate_type: 'term' },
      { id: 444, status: 'pending', score: 85, source_count: 2, proposed_label: 'STOCKS', candidate_type: 'membership' },
      { id: 448, status: 'pending', score: 95, source_count: 2, proposed_label: 'price', candidate_type: 'term' },
      { id: 960, status: 'pending', score: 85, source_count: 2, proposed_label: 'URL', candidate_type: 'membership' },
      { id: 1947, status: 'pending', score: 65, source_count: 4, proposed_label: 'Another', candidate_type: 'theme' },
      { id: 1771, status: 'pending', score: 84, source_count: 5, proposed_label: 'power', candidate_type: 'term' },
      { id: 4667, status: 'pending', score: 100, source_count: 2, proposed_label: 'DOCN', candidate_type: 'membership' },
      { id: 458, status: 'pending', score: 100, source_count: 2, proposed_label: 'AEHR', candidate_type: 'membership' },
      { id: 9, status: 'rejected', score: 90, source_count: 2, proposed_label: 'popular', candidate_type: 'term' },
      { id: 10, status: 'pending', score: 90, source_count: 2, proposed_label: 'popular', candidate_type: 'term' },
    ], 5);
    expect(ranked.map((row) => (row as { proposed_label: string }).proposed_label)).toEqual([
      'DOCN',
      'AEHR',
      'power',
      'Another',
    ]);
    expect((ranked[0] as { score: number }).score).toBe(100);
  });

  test('public snapshot keeps lean beliefs and lessons', () => {
    const published = toPublicDeskSnapshot({
      ...sample,
      beliefs: [{
        id: '645c3ea2-eb0d-4b4b-b329-7ac69b302ff1',
        thesis_id: 'earnings_gap_structure',
        kind: 'playbook_rule',
        rules: ['never_pltr'],
      }],
      lessons: [{ id: 36, thesis_id: 'earnings_gap_structure', summary: 'Soft RTH is not confirmation.' }],
    });
    expect(published.beliefs).toEqual([{
      id: '645c3ea2-eb0d-4b4b-b329-7ac69b302ff1',
      thesis_id: 'earnings_gap_structure',
      kind: 'playbook_rule',
      rules: ['never_pltr'],
    }]);
    expect(published.lessons).toEqual([{
      id: 36,
      thesis_id: 'earnings_gap_structure',
      summary: 'Soft RTH is not confirmation.',
    }]);
    expect(published.evidence).toEqual([]);
    expect(isPublicSnapshot(published)).toBe(true);
  });

  test('hydrate fills missing arrays so tests[0] does not throw', () => {
    const slim = parseDeskWire({
      generated_at: '2026-09-10T00:00:00.000Z',
      source: 'snapshot',
      theses: [{ id: 'neocloud_compute', status: 'hardening' }],
      book: { current_nav: 5734.4193, starting_nav: 5000, observed_at: '2026-09-09T20:52:00.000Z' },
      routines: [{ id: 'market_scan', status: 'live' }],
    });
    expect(slim.tests).toBeUndefined();
    const hydrated = hydratePublicDesk(slim);
    for (const key of DESK_ARRAY_KEYS) {
      expect(Array.isArray(hydrated[key])).toBe(true);
    }
    expect(hydrated.tests[0]).toBeUndefined();
    expect(hydrated.theses[0]).toMatchObject({
      id: 'neocloud_compute',
      symbols: [],
      lots: [],
    });
    expect(hydrated.book.names).toEqual([]);
    expect(hydrated.counts).toMatchObject({ open_research: 0, open_positions: 0 });
  });

  test('public errors stay generic', () => {
    expect(publicDeskJsonError()).toEqual({ error: 'Desk ledger unavailable' });
    expect(publicDeskJsonError('permission denied for table theses')).toEqual({
      error: 'Desk ledger unavailable',
    });
    expect(DESK_PUBLIC_READER_ROLE).toBe('desk_public_reader');
  });

  test('retired paths match the operator desk redirects', () => {
    expect(PUBLIC_DESK_REDIRECTS.map((row) => row.source)).toEqual([
      '/leaderboard', '/board', '/ranks', '/catalysts', '/ontology', '/risk', '/runs', '/learnings', '/mates',
    ]);
    expect(PUBLIC_DESK_REDIRECTS.find((row) => row.source === '/leaderboard')?.destination).toBe('/');
    expect(PUBLIC_DESK_REDIRECTS.find((row) => row.source === '/risk')?.destination).toBe('/book');
  });
});
