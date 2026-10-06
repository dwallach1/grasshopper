import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  assembleStewardScorecard,
  emptyStewardScorecard,
  hitLabel,
  mapStewardScorecard,
  thesisCalibrationText,
} from './steward-scorecard';

// Shape of the live views (PostgREST returns numerics as numbers or strings).
const RAW = {
  stewards: [
    {
      steward: 'quantanamo', unit: 'USD', trades: 7, priced_trades: 7, wins: 2, losses: 5,
      hit_rate: '0.2857', realized_pnl: '12.9579', avg_win: 542.438, avg_loss: -214.3836,
      expectancy: 1.8511, thin: true, fees_recorded: 0.11, fees_missing: 4, from_fills: 1,
      not_from_fills: 6, unpriced: 0, open_positions: 3, unrealized_pnl: 484.2867,
      skips_logged: 0, skips_resolved: 0, skips_scored: 0, skips_would_have_won: 0, brier_n: 0,
    },
    {
      steward: 'oddsborne', unit: 'USD', trades: 8, priced_trades: 8, wins: 3, losses: 5,
      hit_rate: 0.375, realized_pnl: -156.57, expectancy: -19.5713, thin: true,
      fees_recorded: 1.75, fees_missing: 7, from_fills: 0, not_from_fills: 8, open_positions: 0,
      unrealized_pnl: 0, skips_logged: 7, skips_resolved: 6, skips_scored: 5, skips_would_have_won: 2,
      skip_counterfactual_pnl: -0.3586, brier_mean: 0.1256, brier_n: 7,
    },
    {
      steward: 'bandit', unit: 'SOL', trades: 34, priced_trades: 34, wins: 17, losses: 17,
      hit_rate: 0.5, realized_pnl: -0.0516, expectancy: -0.0015, thin: false,
      fees_recorded: null, fees_missing: 34, from_fills: 34, not_from_fills: 0, open_positions: 1,
      unrealized_pnl: -0.043, skips_logged: 0,
    },
    { steward: null, trades: 1 },
  ],
  weekly: [
    { steward: 'quantanamo', unit: 'USD', week_start: '2026-08-24', iso_week: '2026-W35', trades: 1, priced_trades: 1, wins: 0, hit_rate: 0, realized_pnl: -50.38 },
    { steward: 'quantanamo', unit: 'USD', week_start: '2026-08-31', iso_week: '2026-W36', trades: 4, priced_trades: 4, wins: 2, hit_rate: 0.5, realized_pnl: 904.5559 },
    { steward: 'quantanamo', unit: 'USD', week_start: '2026-09-07', iso_week: '2026-W37', trades: 2, priced_trades: 2, wins: 0, hit_rate: 0, realized_pnl: -841.218 },
    { steward: 'quantanamo', unit: 'USD', week_start: '2026-09-14', iso_week: '2026-W38', trades: 0, priced_trades: 0, wins: 0, hit_rate: null, realized_pnl: 0 },
    { steward: 'quantanamo', unit: 'USD', week_start: '2026-09-21', iso_week: '2026-W39', is_current: true, trades: 0, priced_trades: 0, wins: 0, hit_rate: null, realized_pnl: 0 },
  ],
  trend: [
    { steward: 'bandit', recent_n: 23, prior_n: 11, recent_expectancy: 0.0063, prior_expectancy: -0.0179, thin: false, direction: 'improving' },
    { steward: 'quantanamo', recent_n: 0, prior_n: 6, thin: true, direction: 'bogus' },
  ],
  theses: [
    { thesis_id: 'earnings_gap_structure', name: 'Earnings gap structure', steward: 'quantanamo', stated_confidence: 89, outcome_implied_confidence: '25.0', priced_trades: 4, wins: 1, backtest_tests: 1, backtest_trades: '714', backtest_weight: '10.0000', backtest_mean_ret: '-0.003457', backtest_effect: 'against' },
    { thesis_id: 'nfl-mia-ml-vs-sf-20260920', steward: 'oddsborne', stated_confidence: 15, outcome_implied_confidence: 0, priced_trades: 1, wins: 0 },
    { thesis_id: 'weather_same_day_high', steward: 'oddsborne', stated_confidence: 78, outcome_implied_confidence: 50, priced_trades: 4, wins: 2 },
  ],
};

describe('mapStewardScorecard', () => {
  test('coerces view numerics and drops rows without a steward', () => {
    const mapped = mapStewardScorecard(RAW);
    expect(mapped.stewards.map((row) => row.steward)).toEqual(['quantanamo', 'oddsborne', 'bandit']);
    expect(mapped.stewards[0]?.realized_pnl).toBeCloseTo(12.9579, 4);
    expect(mapped.stewards[0]?.hit_rate).toBeCloseTo(0.2857, 4);
    expect(mapped.stewards[2]?.unit).toBe('SOL');
    expect(mapped.stewards[2]?.fees_recorded).toBeNull();
    expect(mapped.trend[1]?.direction).toBe('thin');
  });

  test('flags a thesis only when stated and outcome-implied are more than 15 apart', () => {
    const mapped = mapStewardScorecard(RAW);
    const byId = new Map(mapped.theses.map((row) => [row.thesis_id, row]));
    expect(byId.get('earnings_gap_structure')?.confidence_gap).toBe(64);
    expect(byId.get('earnings_gap_structure')?.miscalibrated).toBe(true);
    expect(byId.get('nfl-mia-ml-vs-sf-20260920')?.miscalibrated).toBe(false);
    expect(byId.get('weather_same_day_high')?.miscalibrated).toBe(true);
  });

  test('logged backtests come through as numbers; none logged stays zero and null', () => {
    const byId = new Map(mapStewardScorecard(RAW).theses.map((row) => [row.thesis_id, row]));
    const gap = byId.get('earnings_gap_structure');
    expect(gap?.backtest_tests).toBe(1);
    expect(gap?.backtest_trades).toBe(714);
    expect(gap?.backtest_weight).toBe(10);
    expect(gap?.backtest_mean_ret).toBeCloseTo(-0.003457, 6);
    expect(gap?.backtest_effect).toBe('against');
    const weather = byId.get('weather_same_day_high');
    expect(weather?.backtest_tests).toBe(0);
    expect(weather?.backtest_mean_ret).toBeNull();
    expect(weather?.backtest_effect).toBeNull();
  });

  test('garbage in stays empty, never invented', () => {
    expect(mapStewardScorecard(null)).toEqual(emptyStewardScorecard());
    expect(mapStewardScorecard({ stewards: 'x' })).toEqual(emptyStewardScorecard());
  });
});

// v_thesis_scorecard rows as served live on 2026-10-06 after migration 52 (values copied from the view).
const LIVE_THESES = [
  { thesis_id: 'earnings_gap_structure', steward: 'quantanamo', stated_confidence: 54, priced_trades: 6, wins: 2, outcome_implied_confidence: 33.3, confidence_gap: 20.7, miscalibrated: true, thin: true, results_confidence: 54, calibration_basis: 'stated_vs_hit_rate', expected_wins: null, expected_win_rate: null, calibration_trades: null, calibration_p: null },
  { thesis_id: 'neocloud_compute', steward: 'quantanamo', stated_confidence: 60, priced_trades: 2, wins: 1, outcome_implied_confidence: 50, confidence_gap: 10, miscalibrated: false, thin: true, results_confidence: null, calibration_basis: 'stated_vs_hit_rate', expected_wins: null, expected_win_rate: null, calibration_trades: null, calibration_p: null },
  { thesis_id: 'meme_4h_momentum_clip', steward: 'bandit', stated_confidence: 40, priced_trades: 4, wins: 1, outcome_implied_confidence: 25, confidence_gap: 15, miscalibrated: false, thin: true, results_confidence: 60, calibration_basis: 'stated_vs_hit_rate', expected_wins: null, expected_win_rate: null, calibration_trades: null, calibration_p: null },
  { thesis_id: 'sports_devig_maker_edge', steward: 'oddsborne', stated_confidence: 38, priced_trades: 2, wins: 0, outcome_implied_confidence: 0, confidence_gap: 17.4, miscalibrated: false, thin: true, results_confidence: null, calibration_basis: 'entry_probability', expected_wins: 0.3476, expected_win_rate: 17.4, calibration_trades: 2, calibration_p: 1 },
  { thesis_id: 'weather_same_day_high', steward: 'oddsborne', stated_confidence: 80, priced_trades: 4, wins: 2, outcome_implied_confidence: 50, confidence_gap: -4.2, miscalibrated: false, thin: true, results_confidence: 79, calibration_basis: 'entry_probability', expected_wins: 1.83, expected_win_rate: 45.8, calibration_trades: 4, calibration_p: 1 },
  { thesis_id: 'nfl-andrews-2td-no-bal-20260920', steward: 'oddsborne', stated_confidence: 55, priced_trades: 1, wins: 0, outcome_implied_confidence: 0, confidence_gap: 10, miscalibrated: false, thin: true, results_confidence: null, calibration_basis: 'entry_probability', expected_wins: 0.1, expected_win_rate: 10, calibration_trades: 1, calibration_p: 1 },
];

describe('thesis calibration: binaries are judged against their entry odds', () => {
  const byId = new Map(mapStewardScorecard({ theses: LIVE_THESES }).theses.map((row) => [row.thesis_id, row]));

  test('ODDSBORNE longshots: 0 for 2 at ~15c is not miscalibrated against stated 38', () => {
    const devig = byId.get('sports_devig_maker_edge');
    expect(devig?.calibration_basis).toBe('entry_probability');
    expect(devig?.miscalibrated).toBe(false);
    expect(devig?.confidence_gap).toBe(17.4);
    expect(devig?.expected_win_rate).toBe(17.4);
    expect(devig?.calibration_trades).toBe(2);
    expect(byId.get('weather_same_day_high')?.miscalibrated).toBe(false);
    expect(byId.get('nfl-andrews-2td-no-bal-20260920')?.miscalibrated).toBe(false);
  });

  test('QUANTANAMO and BANDIT keep stated vs hit rate, |gap| > 15', () => {
    expect(byId.get('earnings_gap_structure')).toMatchObject({ calibration_basis: 'stated_vs_hit_rate', confidence_gap: 20.7, miscalibrated: true, expected_win_rate: null });
    expect(byId.get('neocloud_compute')).toMatchObject({ confidence_gap: 10, miscalibrated: false });
    expect(byId.get('meme_4h_momentum_clip')).toMatchObject({ confidence_gap: 15, miscalibrated: false });
  });

  test('a binary flag needs >= 10 trades even if a payload says otherwise', () => {
    const [row] = mapStewardScorecard({ theses: [{ ...LIVE_THESES[3], miscalibrated: true, calibration_p: 0.001 }] }).theses;
    expect(row?.miscalibrated).toBe(false);
  });

  test('a binary with 10+ trades: the view flag wins; without one, p < 0.05 decides', () => {
    const big = { ...LIVE_THESES[3], priced_trades: 20, wins: 0, calibration_trades: 20, confidence_gap: 15, expected_win_rate: 15 };
    const flagged = mapStewardScorecard({ theses: [{ ...big, miscalibrated: true, calibration_p: 0.0775 }] }).theses[0];
    expect(flagged?.miscalibrated).toBe(true);
    const fallbackOk = mapStewardScorecard({ theses: [{ ...big, miscalibrated: undefined, calibration_p: 0.0775 }] }).theses[0];
    expect(fallbackOk?.miscalibrated).toBe(false);
    const fallbackOff = mapStewardScorecard({ theses: [{ ...big, miscalibrated: undefined, calibration_p: 0.01 }] }).theses[0];
    expect(fallbackOff?.miscalibrated).toBe(true);
  });

  test('binary gap is recomputed as expected - hit rate when the view omits it', () => {
    const [row] = mapStewardScorecard({ theses: [{ ...LIVE_THESES[4], confidence_gap: null }] }).theses;
    expect(row?.confidence_gap).toBe(-4.2);
  });

  test('re-mapping a mapped payload keeps the flags (cached / pass-through payloads)', () => {
    const once = mapStewardScorecard({ theses: LIVE_THESES });
    expect(mapStewardScorecard(once).theses).toEqual(once.theses);
  });

  test('chip text: binaries show expected→realized and say why they are not tested', () => {
    const devig = byId.get('sports_devig_maker_edge');
    const chip = devig ? thesisCalibrationText(devig) : null;
    expect(chip?.value).toBe('exp 17→0');
    expect(chip?.title).toContain('stated 38');
    expect(chip?.title).toContain('not tested below 10 trades');
    const gap = byId.get('earnings_gap_structure');
    expect(gap ? thesisCalibrationText(gap).value : null).toBe('54→33');
    expect(gap ? thesisCalibrationText(gap).title : null).toContain('more than 15 apart');
  });
});

describe('binary calibration SQL (migration 52)', () => {
  const root = join(import.meta.dir, '../../..');

  test('schema files equal the applied migrations', async () => {
    for (const [schema, migration] of [
      ['52_scorecard_binary_calibration.sql', '20261006134819_scorecard_binary_calibration.sql'],
      ['53_entry_odds_never_blocks.sql', '20261006134940_entry_odds_never_blocks.sql'],
    ]) {
      expect(await readFile(join(root, 'supabase/migrations', migration), 'utf8'))
        .toBe(await readFile(join(root, 'supabase/schemas', schema), 'utf8'));
    }
  });

  test('binaries: fair value else entry price, exact test, minimum 10; others unchanged', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/52_scorecard_binary_calibration.sql'), 'utf8');
    expect(sql).toContain('coalesce(t.probability_at_entry, t.price_at_entry) as win_p');
    expect(sql).toContain("bool_and(o.venue = 'prediction')");
    expect(sql).toContain('coalesce(c.cal_trades >= 10 and c.calibration_p < 0.05, false)');
    expect(sql).toContain('else coalesce(abs(c.stated - c.implied) > 15::numeric, false) end as miscalibrated');
    expect(sql).toContain('else c.stated - c.implied end as confidence_gap');
    expect(sql).toContain('create or replace view public.v_thesis_scorecard\nwith (security_invoker = true)');
    // The p-value function is callable by readers of the view, not by anon.
    expect(sql).toContain('revoke all on function public.poisson_binomial_two_sided_p(double precision[], integer) from public, anon;');
  });

  test('measurement only: no sizing, gate or score function is touched', async () => {
    for (const f of ['52_scorecard_binary_calibration.sql', '53_entry_odds_never_blocks.sql']) {
      const sql = await readFile(join(root, 'supabase/schemas', f), 'utf8');
      expect(sql).not.toMatch(/create (or replace )?function private\.(edge_max_stake|thesis_results_score|thesis_edge_evidence|steward_sizing_guidance)/);
      expect(sql).not.toMatch(/rescore_all_thesis_confidence|update public\.theses/);
      for (const table of ['trade_intents', 'pm_orders', 'meme_orders', 'risk_controls', 'theses', 'thesis_scores']) {
        expect(sql).not.toMatch(new RegExp(`(insert into|update|delete from) public\\.${table}\\b`));
      }
    }
    // The backfill sets only the new column, so the re-score trigger (realized_pnl / thesis_id / is_paper) stays quiet.
    const sql = await readFile(join(root, 'supabase/schemas/52_scorecard_binary_calibration.sql'), 'utf8');
    expect(sql).toContain('update public.trade_outcomes set price_at_entry = price_at_entry');
    const safe = await readFile(join(root, 'supabase/schemas/53_entry_odds_never_blocks.sql'), 'utf8');
    expect(safe).toMatch(/exception when others then\s+raise warning/);
  });
});

describe('assembleStewardScorecard', () => {
  const payload = mapStewardScorecard(RAW);

  test('four-week strip ends on the current week', () => {
    const card = assembleStewardScorecard(payload, 'QUANTANAMO');
    expect(card?.weeks.map((week) => week.label)).toEqual(['Aug 31', 'Sep 7', 'Sep 14', 'Sep 21']);
    expect(card?.weeks.at(-1)?.current).toBe(true);
    expect(card?.thin).toBe(true);
    expect(card?.not_from_fills).toBe(6);
    expect(card?.fees).toBeNull();
    expect(card?.skips).toBeNull();
  });

  test('BANDIT fees line prefers sum(meme_fills.fee_sol) over closed-trade fees', () => {
    const raw = structuredClone(RAW) as { stewards: Record<string, unknown>[] };
    raw.stewards[2] = { ...raw.stewards[2], fees_recorded: 0.0025, fees_missing: 0, fees_from_fills: 0.002521, fills_missing_fee: 0 };
    const bandit = assembleStewardScorecard(mapStewardScorecard(raw), 'BANDIT');
    expect(bandit?.fees).toEqual({ recorded: 0.002521, missing: 0, of: 0, noun: 'fills' });
  });

  test('BANDIT carries the fees line; ODDSBORNE carries skips', () => {
    const bandit = assembleStewardScorecard(payload, 'bandit');
    expect(bandit?.fees).toEqual({ recorded: null, missing: 34, of: 34, noun: 'trades' });
    expect(bandit?.thin).toBe(false);
    const odds = assembleStewardScorecard(payload, 'oddsborne');
    expect(odds?.skips).toEqual({ logged: 7, resolved: 6, scored: 5, would_have_won: 2 });
    expect(odds?.theses[0]?.thesis_id).toBe('weather_same_day_high');
  });

  test('no scorecard row → no card', () => {
    expect(assembleStewardScorecard(payload, 'grasshopper')).toBeNull();
    expect(assembleStewardScorecard(undefined, 'bandit')).toBeNull();
  });

  test('hit label', () => {
    expect(hitLabel(0.2857)).toBe('29%');
    expect(hitLabel(null)).toBe('—');
  });
});

describe('outcome ledger SQL', () => {
  const schema = join(import.meta.dir, '../../../supabase/schemas/10_trade_outcomes.sql');

  test('RLS on, views are security invoker, anon gets nothing', async () => {
    const sql = await readFile(schema, 'utf8');
    expect(sql).toContain('alter table public.trade_outcomes enable row level security');
    expect(sql).toContain('alter table public.decision_candidates enable row level security');
    for (const view of ['v_steward_scorecard', 'v_steward_scorecard_weekly', 'v_steward_trend', 'v_thesis_scorecard']) {
      expect(sql).toContain(`create or replace view public.${view}\nwith (security_invoker = true)`);
    }
    expect(sql).toContain('revoke all on table public.trade_outcomes from public, anon, authenticated');
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*trade_outcomes[^;]*desk_public_reader/);
    expect(sql).not.toMatch(/grant[^;]*(insert|update)[^;]*on table public\.trade_outcomes[^;]*_worker/);
  });

  test('measurement only: never writes trading tables', async () => {
    const sql = await readFile(schema, 'utf8');
    for (const table of ['trade_intents', 'pm_orders', 'meme_orders', 'risk_controls', 'theses', 'thesis_scores']) {
      expect(sql).not.toMatch(new RegExp(`(insert into|update|delete from) public\\.${table}\\b`));
    }
    // Capture triggers swallow their own errors so a steward write is never blocked.
    expect(sql.match(/exception when others then\s+raise warning/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test('backfill migration is keyed and idempotent', async () => {
    const sql = await readFile(
      join(import.meta.dir, '../../../supabase/migrations/20260926165149_trade_outcomes_backfill.sql'),
      'utf8',
    );
    expect(sql.match(/on conflict \(source_table, source_id\) do nothing/g)?.length).toBe(4);
    expect(sql).not.toMatch(/'intent'|'estimate'/);
  });
});
