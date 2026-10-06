/**
 * Ledger watchdog: read-only backstop for the retired position monitor.
 * Reads public.v_ledger_watchdog (counts), v_invalidation_breaches and
 * v_open_lots_missing_invalidation. Never invents a mark: a lot without a
 * ledger mark is never a breach. Missing views serve an unavailable, zeroed payload.
 */
import {
  isEquityMarkSession,
  usEquityMarkSession,
  type EquityMarkSession,
} from '@quantanamo/contracts/market-calendar';

import type { MoneyUnit } from './money-units';

export const WATCHDOG_LIST_LIMIT = 50;

/** PostgREST reads (operator /bundle, public bundle, desk-public-rest). */
export const WATCHDOG_QUERIES = {
  summary: 'v_ledger_watchdog?select=*',
  breaches: `v_invalidation_breaches?select=steward,lot_table,lot_id,instrument,unit,thesis_id,invalidation_price,mark,mark_at,mark_age_minutes,action_hint,mark_session&order=mark_at.desc&limit=${WATCHDOG_LIST_LIMIT}`,
  missing: `v_open_lots_missing_invalidation?select=steward,lot_table,lot_id,instrument,unit,thesis_id,mark,mark_at,opened_at&order=opened_at.asc&limit=${WATCHDOG_LIST_LIMIT}`,
  issues: `v_ledger_integrity?select=check_name,severity,steward,ref_table,ref_id,instrument,detail,at&order=at.desc.nullslast&limit=${WATCHDOG_LIST_LIMIT}`,
} as const;

export type WatchdogLot = {
  steward: string;
  lot_table: string;
  lot_id: string;
  instrument: string;
  unit: MoneyUnit;
  thesis_id: string | null;
  invalidation_price: number | null;
  mark: number | null;
  mark_at: string | null;
  action_hint: string | null;
  /**
   * Equity mark session (`pre` / `rth` / `post` / `closed`) from v_invalidation_breaches.mark_session,
   * or derived from mark_at when the view predates it. Null for prediction markets and memes (24/7).
   */
  mark_session: EquityMarkSession | null;
};

export type WatchdogIssue = {
  check_name: string;
  severity: string;
  steward: string;
  ref_table: string;
  ref_id: string;
  instrument: string | null;
  detail: string;
  at: string | null;
};

/**
 * Open risk to invalidation vs the 10%-of-book budget, per steward (v_exposure_usage, carried in the
 * v_ledger_watchdog `exposure` summary). Book units. `over` = headroom below zero.
 */
export type ExposureUsage = {
  steward: 'quantanamo' | 'oddsborne' | 'bandit';
  unit: MoneyUnit;
  open_risk: number;
  risk_budget: number;
  used_share: number | null;
  headroom: number;
  over: boolean;
  /** 'to_invalidation' | 'full_notional' once the view reports it. */
  risk_basis: string | null;
};

const EXPOSURE_ORDER = ['quantanamo', 'oddsborne', 'bandit'] as const;

export type LearningGapSteward = (typeof EXPOSURE_ORDER)[number];

/** Per-steward count of closed lots still waiting on a lesson. Not a trading breach. */
export type LearningGapCounts = Record<LearningGapSteward, number>;

export type LearningGapLot = {
  steward: LearningGapSteward;
  lot_table: string;
  lot_id: string;
};

export const EMPTY_LEARNING_GAPS: LearningGapCounts = {
  quantanamo: 0,
  oddsborne: 0,
  bandit: 0,
};

export type LedgerWatchdog = {
  available: boolean;
  checked_at: string | null;
  invalidation_breaches: number;
  breaches_actionable: number;
  breaches_review_at_open: number;
  lots_missing_invalidation: number;
  integrity_issues: number;
  integrity_errors: number;
  integrity: Record<string, number>;
  open_lots: number;
  exposure_over_budget: number;
  exposure: ExposureUsage[];
  /** Closed lots past the grace window with no lesson or belief after the close. */
  learning_gaps: LearningGapCounts;
  /** Lot ids behind `learning_gaps`, capped in the view. Book rows match these. */
  learning_gap_lots: LearningGapLot[];
  breaches: WatchdogLot[];
  missing: WatchdogLot[];
  issues: WatchdogIssue[];
};

export function emptyLedgerWatchdog(): LedgerWatchdog {
  return {
    available: false,
    checked_at: null,
    invalidation_breaches: 0,
    breaches_actionable: 0,
    breaches_review_at_open: 0,
    lots_missing_invalidation: 0,
    integrity_issues: 0,
    integrity_errors: 0,
    integrity: {},
    open_lots: 0,
    exposure_over_budget: 0,
    exposure: [],
    learning_gaps: { ...EMPTY_LEARNING_GAPS },
    learning_gap_lots: [],
    breaches: [],
    missing: [],
    issues: [],
  };
}

/** Book holding id for a learning-gap lot. Open equity rows use a different id, so they never match. */
export function learningGapHoldingId(lotTable: string, lotId: string): string | null {
  const id = lotId.trim();
  if (!id) return null;
  if (lotTable === 'pm_positions') return `pm:${id}`;
  if (lotTable === 'meme_positions') return `meme:${id}`;
  if (lotTable === 'position_episodes') return `eq-closed:${id}`;
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value: unknown): number {
  const parsed = num(value);
  return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return null;
}

/** The view's mark_session for an equity lot, else derived from mark_at. 24/7 books have none. */
function markSession(lotTable: string | null, named: string | null, markAt: string | null): EquityMarkSession | null {
  if (lotTable !== 'position_episodes') return null;
  if (named && isEquityMarkSession(named)) return named;
  return markAt ? usEquityMarkSession(Date.parse(markAt)) : null;
}

function lot(row: Record<string, unknown>): WatchdogLot {
  return {
    steward: str(row.steward) ?? 'unknown',
    lot_table: str(row.lot_table) ?? '',
    lot_id: str(row.lot_id) ?? '',
    instrument: str(row.instrument) ?? '',
    unit: str(row.unit) === 'SOL' ? 'SOL' : 'USD',
    thesis_id: str(row.thesis_id),
    invalidation_price: num(row.invalidation_price),
    mark: num(row.mark),
    mark_at: str(row.mark_at),
    action_hint: str(row.action_hint),
    mark_session: markSession(str(row.lot_table), str(row.mark_session), str(row.mark_at)),
  };
}

function issue(row: Record<string, unknown>): WatchdogIssue {
  return {
    check_name: str(row.check_name) ?? 'unknown',
    severity: str(row.severity) ?? 'warn',
    steward: str(row.steward) ?? 'unknown',
    ref_table: str(row.ref_table) ?? '',
    ref_id: str(row.ref_id) ?? '',
    instrument: str(row.instrument),
    detail: str(row.detail) ?? '',
    at: str(row.at),
  };
}

function exposureRows(value: unknown): ExposureUsage[] {
  const bag = record(value);
  if (!bag) return [];
  return EXPOSURE_ORDER.flatMap((steward) => {
    const row = record(bag[steward]);
    if (!row) return [];
    const openRisk = num(row.open_risk);
    const budget = num(row.risk_budget);
    if (openRisk === null || budget === null) return [];
    const headroom = num(row.headroom) ?? budget - openRisk;
    return [{
      steward,
      unit: str(row.unit) === 'SOL' ? 'SOL' : 'USD',
      open_risk: openRisk,
      risk_budget: budget,
      used_share: num(row.used_share),
      headroom,
      over: headroom < 0,
      risk_basis: str(row.risk_basis),
    } satisfies ExposureUsage];
  });
}

/** Map `{ summary, breaches, missing, issues }` rows (any path). */
export function mapLedgerWatchdog(raw: unknown): LedgerWatchdog {
  const bag = record(raw);
  const summary = rows(bag?.summary)[0];
  if (!bag || !summary) return emptyLedgerWatchdog();
  const integrity: Record<string, number> = {};
  const rawIntegrity = record(summary.integrity);
  for (const [key, value] of Object.entries(rawIntegrity ?? {})) integrity[key] = count(value);
  return {
    available: true,
    checked_at: str(summary.checked_at),
    invalidation_breaches: count(summary.invalidation_breaches),
    breaches_actionable: count(summary.breaches_actionable),
    breaches_review_at_open: count(summary.breaches_review_at_open),
    lots_missing_invalidation: count(summary.lots_missing_invalidation),
    integrity_issues: count(summary.integrity_issues),
    integrity_errors: count(summary.integrity_errors),
    integrity,
    open_lots: count(summary.open_lots),
    exposure_over_budget: count(summary.exposure_over_budget),
    exposure: exposureRows(summary.exposure),
    ...learningGaps(summary.learning_gaps),
    breaches: rows(bag.breaches).map(lot),
    missing: rows(bag.missing).map(lot),
    issues: rows(bag.issues).map(issue),
  };
}

function learningGaps(value: unknown): Pick<LedgerWatchdog, 'learning_gaps' | 'learning_gap_lots'> {
  const bag = record(value);
  if (!bag) return { learning_gaps: { ...EMPTY_LEARNING_GAPS }, learning_gap_lots: [] };
  const learning_gaps: LearningGapCounts = {
    quantanamo: count(bag.quantanamo),
    oddsborne: count(bag.oddsborne),
    bandit: count(bag.bandit),
  };
  const learning_gap_lots: LearningGapLot[] = [];
  for (const row of rows(bag.lots)) {
    const steward = str(row.steward);
    const lotId = str(row.lot_id);
    const lotTable = str(row.lot_table);
    if (!steward || !lotId || !lotTable) continue;
    if (steward !== 'quantanamo' && steward !== 'oddsborne' && steward !== 'bandit') continue;
    learning_gap_lots.push({ steward, lot_table: lotTable, lot_id: lotId });
  }
  return { learning_gaps, learning_gap_lots };
}

/** Counts for /api/health and the twice-daily ledger health routine. */
export function watchdogHealthSummary(watchdog: LedgerWatchdog | undefined): {
  watchdog_available: boolean;
  invalidation_breaches: number;
  breaches_actionable: number;
  breaches_review_at_open: number;
  lots_missing_invalidation: number;
  integrity_issues: number;
  integrity_errors: number;
  integrity: Record<string, number>;
  exposure_over_budget: number;
  /** Learning-loop gap. Does not change `ok` on /api/health. */
  learning_gaps: LearningGapCounts;
} {
  const w = watchdog ?? emptyLedgerWatchdog();
  return {
    watchdog_available: w.available,
    invalidation_breaches: w.invalidation_breaches,
    breaches_actionable: w.breaches_actionable,
    breaches_review_at_open: w.breaches_review_at_open,
    lots_missing_invalidation: w.lots_missing_invalidation,
    integrity_issues: w.integrity_issues,
    integrity_errors: w.integrity_errors,
    integrity: w.integrity,
    exposure_over_budget: w.exposure_over_budget,
    learning_gaps: { ...w.learning_gaps },
  };
}

function wholeAmount(value: number, unit: MoneyUnit): string {
  if (unit === 'SOL') return `${value.toFixed(3)} SOL`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** Quiet Book line: `risk $654 / $550 budget`. Never colored like P/L. */
export function exposureLine(row: ExposureUsage): string {
  return `risk ${wholeAmount(row.open_risk, row.unit)} / ${wholeAmount(row.risk_budget, row.unit)} budget`;
}

/**
 * An equity lot marked through its line outside the regular session: not an exit. The steward's rule
 * counts regular-session trades only, so it decides at the next open. True when the view says
 * review_at_open, or when the mark's own session is not rth (an equity never exits on a pre / post /
 * closed print, even if an older view called it actionable). Prediction markets and memes trade 24/7.
 */
export function breachDecidesAtOpen(lot: Pick<WatchdogLot, 'lot_table' | 'action_hint' | 'mark_session'>): boolean {
  if (lot.lot_table !== 'position_episodes') return false;
  if (lot.action_hint === 'review_at_open') return true;
  return lot.mark_session !== null && lot.mark_session !== 'rth';
}

/** Plain name for an out-of-session print: `premarket print`, `after-hours print`, `market-closed print`. */
export function sessionPrintText(session: EquityMarkSession | null): string {
  if (session === 'pre') return 'premarket print';
  if (session === 'post') return 'after-hours print';
  if (session === 'closed') return 'market-closed print';
  return 'out-of-session print';
}
