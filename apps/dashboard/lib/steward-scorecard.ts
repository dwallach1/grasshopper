/**
 * Steward scorecard — read-only view of `trade_outcomes` / `decision_candidates`
 * through the v_steward_* and v_thesis_scorecard views. Measurement only: nothing
 * here feeds sizing, gates, or orders. Missing rows stay missing (no invented marks).
 */
import type { MoneyUnit } from './money-units';

export const SCORECARD_THIN_N = 10;
export const THESIS_GAP_FLAG = 15;
/** Binary theses: flagged only with this many trades carrying an entry probability (= the thin threshold)... */
export const BINARY_CALIBRATION_MIN_N = SCORECARD_THIN_N;
/** ...and when the realized wins are this unlikely under those probabilities (two-sided). */
export const BINARY_CALIBRATION_P = 0.05;
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
  /** BANDIT: sum(meme_fills.fee_sol) across every fill (open lots too). Null elsewhere. */
  fees_from_fills: number | null;
  fills_missing_fee: number;
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
  /** Decisions with no market, side, or price. Not counted in the skip line. */
  decisions_unscoreable: number;
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

/**
 * Which yardstick a thesis's calibration uses (migration 52, v_thesis_scorecard.calibration_basis).
 * - `stated_vs_hit_rate` (equity, meme, mixed): gap = stated confidence - hit rate; flagged when |gap| > 15.
 * - `entry_probability` (every priced trade a prediction-market binary): gap = expected win rate (each
 *   trade's --p fair value, else its entry price) - hit rate; flagged only with >= 10 such trades and an
 *   exact two-sided Poisson-binomial p-value < 0.05. Stated confidence (that the edge is real) is not a
 *   per-trade win rate, so a 15c longshot is expected to lose ~85% of the time even with a real edge.
 */
export type CalibrationBasis = 'stated_vs_hit_rate' | 'entry_probability';

export type ThesisScoreRow = {
  thesis_id: string;
  name: string | null;
  steward: string;
  stated_confidence: number | null;
  /** Earned results score (migration 41); null = unscored. */
  results_confidence: number | null;
  /** Realized hit rate x 100. */
  outcome_implied_confidence: number | null;
  /** stated - hit rate, or for binaries expected win rate - hit rate (see CalibrationBasis). */
  confidence_gap: number | null;
  priced_trades: number;
  wins: number;
  miscalibrated: boolean;
  thin: boolean;
  calibration_basis: CalibrationBasis;
  /** Binaries: sum of each trade's fair probability (or entry price); null otherwise. */
  expected_wins: number | null;
  /** Binaries: 100 x expected_wins / calibration_trades; null otherwise. */
  expected_win_rate: number | null;
  /** Binaries: priced trades that carry an entry probability; null otherwise. */
  calibration_trades: number | null;
  /** Binaries: two-sided p-value of the wins given the entry probabilities; null otherwise. */
  calibration_p: number | null;
  /** Logged out-of-sample backtests that count (pass or fail; migration 46). */
  backtest_tests: number;
  backtest_trades: number;
  /** Pooled weight in effective trades (capped at 20). */
  backtest_weight: number;
  /** Weight-pooled mean return per trade after costs, before trial deflation; null = none logged. */
  backtest_mean_ret: number | null;
  /** Whether the logged backtests pull the score up or down (after trial deflation). */
  backtest_effect: BacktestEffect;
};

export type BacktestEffect = 'for' | 'against' | null;

function calibrationBasis(value: string | null): CalibrationBasis {
  return value === 'entry_probability' ? 'entry_probability' : 'stated_vs_hit_rate';
}

/**
 * The ledger view is the source of truth for the flag (only it has the per-trade entry probabilities).
 * Rows without a view flag (older payloads, fixtures) fall back: binaries need the minimum sample and a
 * p-value below 0.05, everything else the |gap| > 15 rule. A binary flag is never shown on a thin sample.
 */
function thesisMiscalibrated(
  flag: boolean | null,
  basis: CalibrationBasis,
  gap: number | null,
  calibrationTrades: number | null,
  calibrationP: number | null,
): boolean {
  if (basis === 'entry_probability') {
    if (calibrationTrades === null || calibrationTrades < BINARY_CALIBRATION_MIN_N) return false;
    if (flag !== null) return flag;
    return calibrationP !== null && calibrationP < BINARY_CALIBRATION_P;
  }
  if (flag !== null) return flag;
  return gap !== null && Math.abs(gap) > THESIS_GAP_FLAG;
}

function backtestEffect(value: string | null): BacktestEffect {
  if (value === 'for') return 'for';
  if (value === 'against') return 'against';
  return null;
}

/** One rollup from `v_decision_brier_vs_market`. Measurement only. */
export type ForecastSkillRow = {
  steward: string;
  decision: 'enter' | 'skip' | 'all';
  /** Null on the all-theses rollup and on decisions that never named a thesis. */
  thesis_id: string | null;
  /** True when this row rolls every thesis up. A null thesis_id with this false is the untagged bucket. */
  all_theses: boolean;
  n: number;
  /** Steward Brier, side terms. Lower is closer. */
  brier: number | null;
  /** Market Brier on the same rows. */
  market_brier: number | null;
  /** brier − market_brier. Negative means the steward was closer than the price. */
  brier_gap: number | null;
  /** 1 − brier/market_brier. Positive means the steward was closer than the price. */
  skill: number | null;
  thin: boolean;
  /** Resolved rows with no book price. Not included in n. */
  excluded_no_book: number;
};

export type StewardScorecardPayload = {
  stewards: StewardScoreRow[];
  weekly: StewardWeekRow[];
  trend: StewardTrendRow[];
  theses: ThesisScoreRow[];
  forecast: ForecastSkillRow[];
};

export function emptyStewardScorecard(): StewardScorecardPayload {
  return { stewards: [], weekly: [], trend: [], theses: [], forecast: [] };
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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function unit(value: unknown): MoneyUnit {
  return value === 'SOL' ? 'SOL' : 'USD';
}

const DIRECTIONS = new Set(['thin', 'improving', 'worsening', 'flat']);
const FORECAST_DECISIONS = new Set(['enter', 'skip', 'all']);
/** |skill| inside this band reads as even with the market. A negative skip is still said plainly. */
const FORECAST_EVEN = 0.02;
const FORECAST_NAMES: Record<string, string> = {
  oddsborne: 'ODDSBORNE',
  quantanamo: 'QUANTANAMO',
  bandit: 'BANDIT',
};

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
        fees_from_fills: num(row.fees_from_fills),
        fills_missing_fee: int(row.fills_missing_fee),
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
        decisions_unscoreable: int(row.decisions_unscoreable),
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
      const basis = calibrationBasis(str(row.calibration_basis));
      const expectedRate = num(row.expected_win_rate);
      const calibrationTrades = basis === 'entry_probability' ? num(row.calibration_trades) : null;
      const calibrationP = num(row.calibration_p);
      // The view's own flag; null when the payload doesn't carry one.
      const flag = row.miscalibrated === true ? true : row.miscalibrated === false ? false : null;
      // The view's gap first; recompute only when it is missing (stated - hit rate, or expected - hit rate).
      const gap = num(row.confidence_gap) ?? (basis === 'entry_probability'
        ? (expectedRate !== null && implied !== null ? round1(expectedRate - implied) : null)
        : (stated !== null && implied !== null ? round1(stated - implied) : null));
      return [{
        thesis_id: thesisId,
        name: str(row.name),
        steward,
        stated_confidence: stated,
        results_confidence: num(row.results_confidence),
        outcome_implied_confidence: implied,
        confidence_gap: gap,
        priced_trades: int(row.priced_trades),
        wins: int(row.wins),
        miscalibrated: thesisMiscalibrated(flag, basis, gap, calibrationTrades, calibrationP),
        thin: int(row.priced_trades) < SCORECARD_THIN_N,
        calibration_basis: basis,
        expected_wins: basis === 'entry_probability' ? num(row.expected_wins) : null,
        expected_win_rate: basis === 'entry_probability' ? expectedRate : null,
        calibration_trades: calibrationTrades,
        calibration_p: basis === 'entry_probability' ? calibrationP : null,
        backtest_tests: int(row.backtest_tests),
        backtest_trades: int(row.backtest_trades),
        backtest_weight: num(row.backtest_weight) ?? 0,
        backtest_mean_ret: num(row.backtest_mean_ret),
        backtest_effect: backtestEffect(str(row.backtest_effect)),
      }];
    }),
    forecast: rows(bag.forecast).flatMap((row) => {
      const steward = str(row.steward)?.toLowerCase() ?? '';
      const decision = str(row.decision);
      if (!steward || !decision || !FORECAST_DECISIONS.has(decision)) return [];
      const n = int(row.n);
      const allTheses = row.all_theses === true || row.all_theses === 'true';
      return [{
        steward,
        decision: decision as ForecastSkillRow['decision'],
        thesis_id: allTheses ? null : str(row.thesis_id),
        all_theses: allTheses,
        n,
        brier: num(row.brier),
        market_brier: num(row.market_brier),
        brier_gap: num(row.brier_gap),
        skill: num(row.skill),
        thin: row.thin === true || row.thin === 'true' || n < SCORECARD_THIN_N,
        excluded_no_book: int(row.excluded_no_book),
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
  fees: { recorded: number | null; missing: number; of: number; noun: 'fills' | 'trades' } | null;
  theses: ThesisScoreRow[];
  skips: {
    logged: number;
    resolved: number;
    scored: number;
    would_have_won: number;
    /** Sum of one-unit counterfactual P/L. Null when nothing has been scored. */
    pnl: number | null;
    unscoreable: number;
  } | null;
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

/** BANDIT fees line: real fee_sol from meme_fills when present, else closed-trade fees. */
function banditFees(row: StewardScoreRow): NonNullable<StewardScorecardCard['fees']> {
  if (row.fees_from_fills !== null) {
    return { recorded: row.fees_from_fills, missing: row.fills_missing_fee, of: 0, noun: 'fills' };
  }
  return { recorded: row.fees_recorded, missing: row.fees_missing, of: row.trades, noun: 'trades' };
}

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
    fees: slug === 'bandit' ? banditFees(row) : null,
    theses,
    skips: row.skips_logged > 0 || row.decisions_unscoreable > 0
      ? {
        logged: row.skips_logged,
        resolved: row.skips_resolved,
        scored: row.skips_scored,
        would_have_won: row.skips_would_have_won,
        pnl: row.skip_counterfactual_pnl,
        unscoreable: row.decisions_unscoreable,
      }
      : null,
    not_from_fills: row.not_from_fills,
    trend: payload.trend.find((item) => item.steward === slug) ?? null,
  };
}

/**
 * Scorecard chip for one thesis: `stated→hit` for the hit-rate yardstick, `exp X→hit` for binaries
 * (expected win rate from entry odds vs realized), with a tooltip that says how the flag is decided.
 */
export type ThesisCalibrationText = {
  /** Chip text, e.g. `54→33` or `exp 17→0`. */
  value: string;
  /** Tooltip: what was compared and how the flag is decided. */
  title: string;
};

export function thesisCalibrationText(row: ThesisScoreRow): ThesisCalibrationText {
  const pct = (value: number | null) => (value === null ? '—' : String(Math.round(value)));
  const hit = pct(row.outcome_implied_confidence);
  if (row.calibration_basis === 'entry_probability') {
    const p = row.calibration_p === null ? '' : `, p=${row.calibration_p < 0.001 ? '<0.001' : row.calibration_p.toFixed(3)}`;
    const verdict = row.miscalibrated
      ? ' (wins this far from the entry odds are unlikely by chance)'
      : (row.calibration_trades ?? 0) < BINARY_CALIBRATION_MIN_N
        ? ` (not tested below ${BINARY_CALIBRATION_MIN_N} trades)`
        : '';
    return {
      value: `exp ${pct(row.expected_win_rate)}→${hit}`,
      title: `${row.thesis_id}: stated ${row.stated_confidence ?? '—'} (edge is real). Expected win rate ${pct(row.expected_win_rate)}% `
        + `from each trade's fair value or entry price vs realized ${hit}% over ${row.calibration_trades ?? 0} trades${p}${verdict}`,
    };
  }
  return {
    value: `${row.stated_confidence ?? '—'}→${hit}`,
    title: `${row.thesis_id}: stated ${row.stated_confidence ?? '—'} vs outcome-implied ${row.outcome_implied_confidence ?? '—'} `
      + `over ${row.priced_trades} trades${row.miscalibrated ? ` (more than ${THESIS_GAP_FLAG} apart)` : ''}`,
  };
}

/** `83%` style; null stays an em dash. */
export function hitLabel(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value * 100)}%`;
}

export type PassedBetCopy = {
  /** `5 passed bets scored`, or `No passed bets scored yet` while some are still open. */
  lead: string | null;
  /** `2 would have won` once at least one pass has a result. */
  won: string | null;
  /** One-unit counterfactual P/L. Null when nothing is scored, so the desk never invents a figure. */
  pnl: number | null;
  /** `per contract`, `per share`, or `per token`. */
  unitNote: string | null;
  /** Decisions the ledger cannot score. */
  missing: string | null;
};

/** Plain scorecard line for passes. One unit of the instrument, in the steward's own currency. */
export function passedBetCopy(
  skips: StewardScorecardCard['skips'],
  steward: string,
): PassedBetCopy | null {
  if (!skips) return null;
  if (skips.scored <= 0 && skips.logged <= 0 && skips.unscoreable <= 0) return null;
  const slug = steward.trim().toLowerCase();
  const unitNote = slug === 'bandit' ? 'per token' : slug === 'quantanamo' ? 'per share' : 'per contract';
  const scored = skips.scored > 0;
  return {
    lead: scored
      ? `${skips.scored} passed ${skips.scored === 1 ? 'bet' : 'bets'} scored`
      : skips.logged > 0 ? 'No passed bets scored yet' : null,
    won: scored ? `${skips.would_have_won} would have won` : null,
    pnl: scored ? skips.pnl : null,
    unitNote: scored && skips.pnl !== null ? unitNote : null,
    missing: skips.unscoreable > 0
      ? `${skips.unscoreable} missing a market or a price`
      : null,
  };
}

function forecastCount(row: ForecastSkillRow, withSettled: boolean): string {
  const thin = row.thin ? ', too few to trust' : '';
  return withSettled ? `(${row.n} settled${thin})` : `(${row.n}${thin})`;
}

function headlineVerdict(row: ForecastSkillRow): string {
  const skill = row.skill;
  const count = forecastCount(row, true);
  if (skill === null || Math.abs(skill) < FORECAST_EVEN) return `about even ${count}`;
  return skill > 0 ? `better than the market ${count}` : `worse than the market ${count}`;
}

/** Sign of the slice, including a small negative. The even band is only for the whole-book line. */
function sliceVerdict(row: ForecastSkillRow | undefined, phrase: string): string | null {
  if (!row || row.n <= 0 || row.skill === null || row.skill === 0) return null;
  const word = row.skill < 0 ? 'Worse' : 'Better';
  return `${word} than the market on ${phrase} ${forecastCount(row, false)}`;
}

function excludedPhrase(n: number): string | null {
  if (n <= 0) return null;
  const bet = n === 1 ? 'bet' : 'bets';
  return `${n} settled ${bet} had no market price, left out`;
}

/**
 * One parchment sentence: how this steward's probabilities compared with the price
 * they were looking at. Null when nothing has settled with both a probability and a price.
 */
export function forecastVsMarketLine(
  rows: readonly ForecastSkillRow[],
  steward: string,
  name?: string,
): string | null {
  const slug = steward.trim().toLowerCase();
  const label = name?.trim() || FORECAST_NAMES[slug] || slug.toUpperCase();
  const mine = rows.filter((row) => row.steward === slug && row.all_theses);
  const all = mine.find((row) => row.decision === 'all');
  if (!all || (all.n <= 0 && all.excluded_no_book <= 0)) return null;
  if (all.n <= 0) {
    const left = excludedPhrase(all.excluded_no_book);
    return left ? `${label}'s odds vs the market's: ${left}.` : null;
  }
  const sentences = [
    `${label}'s odds vs the market's: ${headlineVerdict(all)}`,
    sliceVerdict(mine.find((row) => row.decision === 'skip'), 'bets it passed up'),
    sliceVerdict(mine.find((row) => row.decision === 'enter'), 'bets taken'),
    excludedPhrase(all.excluded_no_book),
  ].filter((part): part is string => Boolean(part));
  return `${sentences.join('. ')}.`;
}

const FORECAST_ORDER = ['oddsborne', 'quantanamo', 'bandit'];

/** Steward rollups, ODDSBORNE first. Thesis rows stay on the scorecard and out of this sentence. */
export function forecastVsMarketLines(rows: readonly ForecastSkillRow[]): string | null {
  const present = [...new Set(rows.map((row) => row.steward))];
  const ordered = [
    ...FORECAST_ORDER.filter((slug) => present.includes(slug)),
    ...present.filter((slug) => !FORECAST_ORDER.includes(slug)).sort(),
  ];
  const lines = ordered.flatMap((slug) => {
    const line = forecastVsMarketLine(rows, slug);
    return line ? [line] : [];
  });
  return lines.length ? lines.join(' · ') : null;
}
