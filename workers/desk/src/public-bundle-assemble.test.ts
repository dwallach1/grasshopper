import { describe, expect, test } from 'bun:test';

import { isPublicSnapshot } from '@quantanamo/contracts/desk-snapshot';

import { assemblePublicBundle } from './desk-live';

/**
 * Shape of the live `/bundle/public` cycle row after PR #161: the three
 * small scalars were omitted, and scenarios omit `breach_type`. Zod used
 * to reject that and the worker returned 503.
 */
const SLIM_CYCLE_KEYS = [
  'hypothesis',
  'id',
  'market_regime',
  'preregistered_outcome',
  'stage',
  'status',
  'thesis_id',
] as const;

function slimBundle() {
  const cycle = {
    id: 25,
    thesis_id: 'earnings_gap_structure',
    stage: 'research',
    status: 'open',
    market_regime: null,
    hypothesis: 'A second gap down after a prior dump continues into the print.',
    preregistered_outcome: 'Mean net return per trade is positive after costs.',
  };
  return {
    theses: [{
      id: 'earnings_gap_structure',
      name: 'Earnings gap structure',
      summary: 'Gaps around prints.',
      status: 'forming',
      confidence: 50,
      stated_confidence: null,
      results_confidence: null,
      time_horizon: 'weeks',
      stance: 'watch',
      variant_perception: null,
      falsifier: null,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-10-06T00:00:00.000Z',
    }],
    symbols: [],
    beliefs: [],
    lessons: [],
    cycles: [cycle],
    tests: [{
      id: 16,
      external_key: 'serial-gap-dump-v1-20260903',
      cycle_id: 25,
      variant_label: 'serial-gap-dump-v1',
      status: 'killed',
      total_return: null,
      max_drawdown: null,
      deflated_sharpe: null,
      cost_multiplier: 1,
      stress_regime: null,
      failure_reason: null,
      autopsy: null,
      tested_at: '2026-10-06T23:31:22.389Z',
      price_source: null,
      window_start: null,
      window_end: null,
      symbols: null,
      params_json: null,
      result: 'n=4',
      per_trade: { n: 4, unit: null, mean: null, ci90: null, hit: null, hit_other: null },
      book: null,
    }],
    artifacts: [],
    scenarios: [{
      id: 49,
      test_id: 16,
      scenario_key: 'base-1x',
      market_regime: 'base',
      cost_multiplier: 1,
      outcome: 'killed',
      metric_value: null,
    }],
    accountLatest: [],
    accountFirst: [],
    positions: [],
    exposures: [],
    intents: [],
    fills: [],
    themes: [],
    candidates: [],
    runs: [],
    cloudRuns: [],
    automations: [],
    pm: { markets: [], positions: [], orders: [], fills: [], pnl: [], notes: [] },
    meme: { tokens: [], positions: [], orders: [], fills: [], pnl: [], notes: [] },
    team: { agents: [], domains: [], stewards: [], accounts: [] },
  };
}

describe('public bundle assemble', () => {
  test('slim cycles and scenarios pass worker Zod and publish', () => {
    const bundle = slimBundle();
    const cycle = bundle.cycles[0]!;
    expect(Object.keys(cycle).sort()).toEqual([...SLIM_CYCLE_KEYS].sort());
    expect(cycle).not.toHaveProperty('external_key');
    expect(cycle).not.toHaveProperty('preregistered_at');
    expect(cycle).not.toHaveProperty('iteration');
    expect(bundle.scenarios[0]).not.toHaveProperty('breach_type');

    const serve = assemblePublicBundle(bundle);
    expect(isPublicSnapshot(serve.desk)).toBe(true);
    const desk = serve.desk as {
      cycles: Array<Record<string, unknown>>;
      tests: Array<{ id: number; result?: string | null }>;
      scenarios: Array<Record<string, unknown>>;
    };
    expect(desk.cycles).toHaveLength(1);
    expect(desk.cycles[0]).toMatchObject({
      id: 25,
      thesis_id: 'earnings_gap_structure',
      stage: 'research',
      status: 'open',
      market_regime: null,
    });
    expect(desk.cycles[0]).not.toHaveProperty('external_key');
    expect(desk.tests.find((row) => row.id === 16)?.result).toBe('n=4');
    expect(desk.scenarios).toHaveLength(1);
    expect(serve.json).not.toContain('payload_json');
  });

  test('an earnings row on the public bundle stays on the phone snapshot', () => {
    const bundle = slimBundle() as Record<string, unknown>;
    bundle.earnings = [{
      lot_id: 'fixture-lot',
      symbol: 'NFLX',
      report_date: '2026-10-20',
      report_timing: 'pm',
      reported: false,
      straddle_price: '9.70',
      underlying_price: '100',
      expiry_date: '2026-10-23',
      expiry_gap_days: 3,
      expiry_loose: false,
      realized_close_to_close: null,
      score_missing_reason: null,
    }];
    const serve = assemblePublicBundle(bundle);
    const desk = serve.desk as { earnings?: Array<{ symbol: string; straddle_price: number | null }> };
    expect(desk.earnings).toEqual([
      expect.objectContaining({ symbol: 'NFLX', straddle_price: 9.7, underlying_price: 100 }),
    ]);
  });

  test('an open lesson wait survives the public bundle with its age', () => {
    const bundle = slimBundle() as Record<string, unknown>;
    bundle.lesson_waits = [
      {
        lesson_id: '134',
        thesis_id: 'earnings_gap_structure',
        test_id: 41,
        test_status: 'queued',
        age_days: '4',
      },
      { lesson_id: 0, thesis_id: 'earnings_gap_structure', test_id: 1 },
    ];
    const serve = assemblePublicBundle(bundle);
    const desk = serve.desk as {
      lesson_waits?: Array<{ lesson_id: number; test_id: number | null; test_status: string | null; age_days: number | null }>;
    };
    expect(desk.lesson_waits).toEqual([{
      lesson_id: 134,
      thesis_id: 'earnings_gap_structure',
      test_id: 41,
      test_status: 'queued',
      age_days: 4,
    }]);
    expect(serve.json).toContain('"age_days":4');
    expect(serve.json).not.toContain('tested_at');
  });

  test('the public bundle fetches earnings and lesson waits as optional reads', async () => {
    const fn = await Bun.file(new URL('../../../supabase/functions/desk-public-rest/index.ts', import.meta.url)).text();
    expect(fn).toContain("'equity_implied_moves'");
    expect(fn).toContain('restGet(EARNINGS_QUERY, true)');
    expect(fn).toContain('realized_close_to_close');
    expect(fn).toContain("'v_open_lesson_tests'");
    expect(fn).toContain('restGet(LESSON_WAITS_QUERY, true)');
    expect(fn).toContain('lesson_waits: lessonWaits');
    expect(fn).toContain('v_open_lesson_tests?select=lesson_id,thesis_id,test_id,test_status,age_days');
  });

  test('the public cycle query selects the three small scalars and quotes cost key 10', async () => {
    const fn = await Bun.file(new URL('../../../supabase/functions/desk-public-rest/index.ts', import.meta.url)).text();
    const tests = await Bun.file(new URL('../../../supabase/functions/desk-public-rest/public-tests.ts', import.meta.url)).text();
    expect(fn).toContain(
      'research_cycles?select=id,external_key,thesis_id,hypothesis,preregistered_outcome,preregistered_at,stage,status,iteration,market_regime&id=in.',
    );
    expect(fn).not.toContain(
      'research_cycles?select=id,thesis_id,stage,status,market_regime,hypothesis,preregistered_outcome&id=in.',
    );
    expect(tests).toContain('payload_json->by_cost->"10"->mean_net_pct');
    expect(tests).not.toContain('payload_json->by_cost->10->mean_net_pct');
  });
});
