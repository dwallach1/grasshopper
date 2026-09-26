/**
 * Steward scorecard — read-only view of `trade_outcomes` / `decision_candidates`
 * through the v_steward_* and v_thesis_scorecard views. Measurement only: nothing
 * here feeds sizing, gates, or orders. Missing rows stay missing (no invented marks).
 */
import type { MoneyUnit } from './money-units';

export const SCORECARD_THIN_N = 10;
export const THESIS_GAP_FLAG = 15;
export const SCORECARD_WEEKS = 4;

export type StewardScoreRow = {
  steward: string;
  unit: MoneyUnit;
  trades: number;
  priced_trades: number;
  wins: number;
  losses: number;
  hit_rate: number | null;
  realized_pnl: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  expectancy: number | null;
  thin: boolean;
  fees_recorded: number | null;
  fees_missing: number;
  from_fills: number;
  not_from_fills: number;
  unpriced: number;
  open_positions: number;
  unrealized_pnl: number | null;
  unrealized_marked_at: string | null;
  skips_logged: number;
  skips_resolved: number;
  skips_scored: number;
  skips_would_have_won: number;
  skip_counterfactual_pnl: number | null;
  brier_mean: number | null;
  brier_n: number;
};

export type StewardWeekRow = {
  steward: string;
  unit: MoneyUnit;
  week_start: string;
  iso_week: string;
  is_current: boolean;
  trades: number;
  priced_trades: number;
  wins: number;
  hit_rate: number | null;
  realized_pnl: number;
};

export type StewardTrendRow = {
  steward: string;
  recent_n: number;
  prior_n: number;
  recent_expectancy: number | null;
  prior_expectancy: number | null;
  thin: boolean;
  direction: 'thin' | 'improving' | 'worsening' | 'flat';
};

export type ThesisScoreRow = {
  thesis_id: string;
  name: string | null;
  steward: string;
  stated_confidence: number | null;
  outcome_implied_confidence: number | null;
  confidence_gap: number | null;
  priced_trades: number;
  wins: number;
  miscalibrated: boolean;
  thin: boolean;
};

export type StewardScorecardPayload = {
  stewards: StewardScoreRow[];
  weekly: StewardWeekRow[];
  trend: StewardTrendRow[];
  theses: ThesisScoreRow[];
};

export function emptyStewardScorecard(): StewardScorecardPayload {
  return { stewards: [], weekly: [], trend: [], theses: [] };
}

type Bag = Record<string, unknown>;

function rows(value: unknown): Bag[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Bag => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number {
  const parsed = num(value);
  return parsed === null ? 0 : Math.trunc(parsed);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function unit(value: unknown): MoneyUnit {
  return value === 'SOL' ? 'SOL' : 'USD';
}

const DIRECTIONS = new Set(['thin', 'improving', 'worsening', 'flat']);

export function mapStewardScorecard(raw: unknown): StewardScorecardPayload {
  const bag: Bag = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Bag) : {};
  return {
    stewards: rows(bag.stewards).flatMap((row) => {
      const steward = str(row.steward);
      if (!steward) return [];
      return [{
        steward,
        unit: unit(row.unit),
        trades: int(row.trades),
        priced_trades: int(row.priced_trades),
        wins: int(row.wins),
        losses: int(row.losses),
        hit_rate: num(row.hit_rate),
        realized_pnl: num(row.realized_pnl),
        avg_win: num(row.avg_win),
        avg_loss: num(row.avg_loss),
        expectancy: num(row.expectancy),
        thin: row.thin === true || int(row.priced_trades) < SCORECARD_THIN_N,
        fees_recorded: num(row.fees_recorded),
        fees_missing: int(row.fees_missing),
        from_fills: int(row.from_fills),
        not_from_fills: int(row.not_from_fills),
        unpriced: int(row.unpriced),
        open_positions: int(row.open_positions),
        unrealized_pnl: num(row.unrealized_pnl),
        unrealized_marked_at: str(row.unrealized_marked_at),
        skips_logged: int(row.skips_logged),
        skips_resolved: int(row.skips_resolved),
        skips_scored: int(row.skips_scored),
        skips_would_have_won: int(row.skips_would_have_won),
        skip_counterfactual_pnl: num(row.skip_counterfactual_pnl),
        brier_mean: num(row.brier_mean),
        brier_n: int(row.brier_n),
      }];
    }),
    weekly: rows(bag.weekly).flatMap((row) => {
      const steward = str(row.steward);
      const weekStart = str(row.week_start);
      if (!steward || !weekStart) return [];
      return [{
        steward,
        unit: unit(row.unit),
        week_start: weekStart,
        iso_week: str(row.iso_week) ?? weekStart,
        is_current: row.is_current === true,
        trades: int(row.trades),
        priced_trades: int(row.priced_trades),
        wins: int(row.wins),
        hit_rate: num(row.hit_rate),
        realized_pnl: num(row.realized_pnl) ?? 0,
      }];
    }),
    trend: rows(bag.trend).flatMap((row) => {
      const steward = str(row.steward);
      if (!steward) return [];
      const direction = str(row.direction);
      return [{
        steward,
        recent_n: int(row.recent_n),
        prior_n: int(row.prior_n),
        recent_expectancy: num(row.recent_expectancy),
        prior_expectancy: num(row.prior_expectancy),
        thin: row.thin === true,
        direction: (direction && DIRECTIONS.has(direction) ? direction : 'thin') as StewardTrendRow['direction'],
      }];
    }),
    theses: rows(bag.theses).flatMap((row) => {
      const thesisId = str(row.thesis_id);
      const steward = str(row.steward);
      if (!thesisId || !steward) return [];
      const stated = num(row.stated_confidence);
      const implied = num(row.outcome_implied_confidence);
      const gap = stated !== null && implied !== null ? stated - implied : num(row.confidence_gap);
      return [{
        thesis_id: thesisId,
        name: str(row.name),
        steward,
        stated_confidence: stated,
        outcome_implied_confidence: implied,
        confidence_gap: gap,
        priced_trades: int(row.priced_trades),
        wins: int(row.wins),
        miscalibrated: gap !== null && Math.abs(gap) > THESIS_GAP_FLAG,
        thin: int(row.priced_trades) < SCORECARD_THIN_N,
      }];
    }),
  };
}

export type ScorecardWeek = {
  label: string;
  trades: number;
  pnl: number;
  hit_rate: number | null;
  current: boolean;
};

export type StewardScorecardCard = {
  steward: string;
  unit: MoneyUnit;
  weeks: ScorecardWeek[];
  trades: number;
  priced: number;
  expectancy: number | null;
  thin: boolean;
  realized: number | null;
  unrealized: number | null;
  open_positions: number;
  /** BANDIT: fees line. Null for other stewards. */
  fees: { recorded: number | null; missing: number; trades: number } | null;
  theses: ThesisScoreRow[];
  skips: { logged: number; resolved: number; scored: number; would_have_won: number } | null;
  /** Trades not priced from venue fills (cash delta, settlement, manual, unpriced). */
  not_from_fills: number;
  trend: StewardTrendRow | null;
};

function weekLabel(weekStart: string): string {
  const [, month, day] = weekStart.slice(0, 10).split('-').map(Number);
  if (!month || !day) return weekStart;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[month - 1]} ${day}`;
}

/** One steward's card, or null when the ledger has no scorecard row for it. */
export function assembleStewardScorecard(
  payload: StewardScorecardPayload | null | undefined,
  steward: string,
): StewardScorecardCard | null {
  if (!payload) return null;
  // Re-map so a cached or pass-through payload still gets thin / miscalibrated flags.
  payload = mapStewardScorecard(payload);
  const slug = steward.trim().toLowerCase();
  const row = payload.stewards.find((item) => item.steward === slug);
  if (!row) return null;
  const weeks = payload.weekly
    .filter((item) => item.steward === slug)
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .slice(-SCORECARD_WEEKS)
    .map((item) => ({
      label: weekLabel(item.week_start),
      trades: item.trades,
      pnl: item.realized_pnl,
      hit_rate: item.hit_rate,
      current: item.is_current,
    }));
  const theses = payload.theses
    .filter((item) => item.steward === slug)
    .sort((a, b) => Math.abs(b.confidence_gap ?? 0) - Math.abs(a.confidence_gap ?? 0));
  return {
    steward: slug,
    unit: row.unit,
    weeks,
    trades: row.trades,
    priced: row.priced_trades,
    expectancy: row.expectancy,
    thin: row.thin,
    realized: row.realized_pnl,
    unrealized: row.unrealized_pnl,
    open_positions: row.open_positions,
    fees: slug === 'bandit'
      ? { recorded: row.fees_recorded, missing: row.fees_missing, trades: row.trades }
      : null,
    theses,
    skips: row.skips_logged > 0
      ? {
        logged: row.skips_logged,
        resolved: row.skips_resolved,
        scored: row.skips_scored,
        would_have_won: row.skips_would_have_won,
      }
      : null,
    not_from_fills: row.not_from_fills,
    trend: payload.trend.find((item) => item.steward === slug) ?? null,
  };
}

/** `83%` style; null stays an em dash. */
export function hitLabel(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value * 100)}%`;
}
