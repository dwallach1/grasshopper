import { describe, expect, test } from 'bun:test';

import {
  isPublicSnapshot,
  parseDeskWire,
  PUBLIC_DESK_REDIRECTS,
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
    expect(published.prediction_markets).toEqual({ markets: [] });
    expect(published.meme_coins).toEqual({ tokens: [] });
    expect(published.team).toEqual(sample.team);
    expect(published.book.current_nav).toBeNull();
    expect(isPublicSnapshot(published)).toBe(true);
  });

  test('public errors stay generic', () => {
    expect(publicDeskJsonError()).toEqual({ error: 'Desk snapshot unavailable' });
    expect(publicDeskJsonError('permission denied for table theses')).toEqual({
      error: 'Desk snapshot unavailable',
    });
  });

  test('retired paths match the operator desk redirects', () => {
    expect(PUBLIC_DESK_REDIRECTS.map((row) => row.source)).toEqual([
      '/book', '/catalysts', '/ontology', '/risk', '/runs', '/learnings', '/mates',
    ]);
  });
});
