import { describe, expect, test } from 'bun:test';

import {
  DESK_ARRAY_KEYS,
  DESK_PUBLIC_READER_ROLE,
  hydratePublicDesk,
  isPublicSnapshot,
  LIVE_JSON_CACHE_CONTROL,
  parseDeskWire,
  PUBLIC_DESK_REDIRECTS,
  PUBLIC_DESK_REFRESH_FAILED,
  publicDeskJsonError,
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
