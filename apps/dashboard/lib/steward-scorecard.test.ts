import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  assembleStewardScorecard,
  emptyStewardScorecard,
  hitLabel,
  mapStewardScorecard,
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
    { thesis_id: 'earnings_gap_structure', name: 'Earnings gap structure', steward: 'quantanamo', stated_confidence: 89, outcome_implied_confidence: '25.0', priced_trades: 4, wins: 1 },
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

  test('garbage in stays empty, never invented', () => {
    expect(mapStewardScorecard(null)).toEqual(emptyStewardScorecard());
    expect(mapStewardScorecard({ stewards: 'x' })).toEqual(emptyStewardScorecard());
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

  test('BANDIT carries the fees line; ODDSBORNE carries skips', () => {
    const bandit = assembleStewardScorecard(payload, 'bandit');
    expect(bandit?.fees).toEqual({ recorded: null, missing: 34, trades: 34 });
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
      join(import.meta.dir, '../../../supabase/migrations/20260926170100_trade_outcomes_backfill.sql'),
      'utf8',
    );
    expect(sql.match(/on conflict \(source_table, source_id\) do nothing/g)?.length).toBe(4);
    expect(sql).not.toMatch(/'intent'|'estimate'/);
  });
});
