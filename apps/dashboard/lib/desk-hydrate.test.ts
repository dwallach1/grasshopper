import { describe, expect, test } from 'bun:test';

import { assembleCrtBoot } from './desk-crt-boot';
import { assembleDeskBookRollup } from './desk-book-rollup';
import { deskFromWire } from './desk-client';
import { assembleDeskFreshness } from './desk-freshness';
import { assembleLeaderboard } from './desk-leaderboard';

/** Shape the live Worker served on 2026-09-10 before hydrate — no `tests`. */
const slimPublicWire = {
  generated_at: '2026-09-10T03:21:34.742Z',
  source: 'snapshot' as const,
  theses: [{
    id: 'neocloud_compute',
    name: 'Neocloud',
    status: 'hardening',
    summary: 'compute',
    confidence: 0.7,
    time_horizon: 'months',
    stance: 'long',
    variant_perception: null,
    falsifier: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    symbols: ['NBIS'],
  }],
  book: {
    current_nav: 5734.4193,
    starting_nav: 5000,
    observed_at: '2026-09-09T20:52:00.000Z',
    cash: 3554.6,
    names: [{ symbol: 'CIFR', quantity: 63, average_cost: 15.82, cost: 1000, mark: 16.91, pnl: 69, note: '', venue: 'equity' }],
  },
  routines: [{ id: 'market_scan', status: 'live' }],
  snapshots: [],
  positions: [],
  exposures: [],
  intents: [],
  fills: [],
  fill_log: [],
  ontology_themes: [],
  ontology_actions: [],
  counts: { sources: 0, symbols: 0, open_research: 0, tests_killed: 0, tests_survived: 0, scenario_cells: 0, open_positions: 0, queued_tasks: 0 },
  prediction_markets: {
    desk: 'ODDSBORNE',
    venue: 'prediction',
    markets: [],
    positions: [{
      id: 'midway',
      market_id: 'tc-temp-mdwhigh-2026-09-09-lt80f',
      account_key: 'polymarket-us-primary',
      thesis_id: null,
      outcome: 'yes',
      status: 'closed',
      quantity: 0,
      average_cost: 0.4,
      mark: 0,
      mark_at: '2026-09-10T01:02:32.492Z',
      opened_at: '2026-09-09T12:00:00.000Z',
      closed_at: '2026-09-10T01:02:32.492Z',
      thesis_text: null,
    }],
    orders: [],
    fills: [],
    pnl: [{
      id: 'latest-pm',
      account_key: 'polymarket-us-primary',
      as_of: '2026-09-10T01:02:32.492Z',
      realized: 0,
      unrealized: 0,
      fees: 0,
      cash: 400,
      equity: 400,
      notes: '',
    }],
    notes: [],
  },
  team: { agents: [], domains: [], stewards: [], accounts: [] },
};

describe('public slim /api/desk hydrate', () => {
  test('missing tests/evidence do not throw on Board boot reads', () => {
    expect('tests' in slimPublicWire).toBe(false);
    const desk = deskFromWire(slimPublicWire);
    expect(desk.tests).toEqual([]);
    expect(desk.evidence).toEqual([]);
    expect(desk.queue).toEqual([]);
    expect(desk.theses[0]?.lots).toEqual([]);
    expect(desk.theses[0]?.id).toBe('neocloud_compute');
    expect(desk.tests[0]?.id).toBeUndefined();

    expect(() => assembleLeaderboard(desk)).not.toThrow();
    expect(() => assembleDeskFreshness(desk)).not.toThrow();
    expect(() => assembleDeskBookRollup(desk)).not.toThrow();
    expect(() => assembleCrtBoot(desk)).not.toThrow();

    const rollup = assembleDeskBookRollup(desk);
    expect(rollup.usd_nav).toBeCloseTo(5734.4193 + 400);
    expect(desk.prediction_markets?.positions[0]?.status).toBe('closed');
  });
});
