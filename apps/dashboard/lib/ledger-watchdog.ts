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

/**
 * An actionable breach escalates on the second check, or when the first real print
 * is this old. Long enough that the run which wrote the print does not escalate
 * itself. Short of the ~2h the 10/8 NBIS and CODA exits waited.
 */
export const BREACH_ESCALATION_WINDOW_MS = 15 * 60 * 1000;

/** PostgREST reads (operator /bundle, public bundle, desk-public-rest). */
export const WATCHDOG_QUERIES = {
  summary: 'v_ledger_watchdog?select=*',
  breaches: `v_invalidation_breaches?select=steward,lot_table,lot_id,instrument,unit,thesis_id,invalidation_price,mark,mark_at,mark_age_minutes,action_hint,mark_session,first_seen_at,breach_age_minutes,check_count,escalated,escalation,sentence&order=mark_at.desc&limit=${WATCHDOG_LIST_LIMIT}`,
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
  /** First real print under the line. Null until a mark is persisted. */
  first_seen_at: string | null;
  /** Minutes since `first_seen_at`. Null when that print was never stored. */
  breach_age_minutes: number | null;
  check_count: number;
  escalated: boolean;
  escalation: 'next_check' | 'window' | null;
  /** Plain sell-now line from the view, when escalated. */
  sentence: string | null;
};

export type EscalatedBreach = {
  steward: string;
  lot_table: string;
  lot_id: string;
  instrument: string;
  first_seen_at: string;
  breach_age_minutes: number;
  escalation: 'next_check' | 'window';
  sentence: string;
};

export type BreachPrint = { at: string; price: number | null };

export type BreachReplay = {
  checks: number;
  first_seen_at: string | null;
  second_seen_at: string | null;
  as_of: string | null;
  breach_age_minutes: number | null;
  escalated: boolean;
  escalation: 'next_check' | 'window' | null;
  sentence: string | null;
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

/** Decisions that cannot be scored (no market, side, or price). Not a trading breach. */
export type UnscoreableDecisionCounts = LearningGapCounts;

export const EMPTY_UNSCOREABLE_DECISIONS: UnscoreableDecisionCounts = {
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
  /** Enter/skip rows with no market, side, or price. Sibling of `learning_gaps`. */
  unscoreable_decisions: UnscoreableDecisionCounts;
  /** Actionable breaches past the next check or the 15-minute window. */
  breaches_escalated: number;
  escalated: EscalatedBreach[];
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
    unscoreable_decisions: { ...EMPTY_UNSCOREABLE_DECISIONS },
    breaches_escalated: 0,
    escalated: [],
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

function flag(value: unknown): boolean {
  return value === true || value === 'true' || value === 't' || value === 'yes';
}

function minutes(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = num(value);
  return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : null;
}

function escalationOf(value: unknown): 'next_check' | 'window' | null {
  const named = str(value);
  return named === 'next_check' || named === 'window' ? named : null;
}

/** Age in plain words: 14 → `14m`, 120 → `2h`, 171 → `2h 51m`. */
export function breachAgeLabel(minutesValue: number): string | null {
  if (!Number.isFinite(minutesValue) || minutesValue < 0) return null;
  const whole = Math.trunc(minutesValue);
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Desk line. No price and no P/L. */
export function escalatedBreachSentence(instrument: string, ageMinutes: number): string | null {
  const label = breachAgeLabel(ageMinutes);
  const name = instrument.trim();
  if (!name || !label) return null;
  return `${name} has been under its exit line for ${label} — sell now`;
}

export function breachAgeMinutes(firstSeenAt: string, asOf: string): number | null {
  const age = Date.parse(asOf) - Date.parse(firstSeenAt);
  if (!Number.isFinite(age) || age < 0) return null;
  return Math.floor(age / 60_000);
}

/** Same rule as public.breach_escalation_state. A missing first print is not escalated. */
export function breachEscalationState(
  checks: number,
  firstSeenAt: string | null,
  asOf: string | null,
): { escalated: boolean; escalation: 'next_check' | 'window' | null } {
  if (!firstSeenAt || !asOf) return { escalated: false, escalation: null };
  const age = Date.parse(asOf) - Date.parse(firstSeenAt);
  if (!Number.isFinite(age)) return { escalated: false, escalation: null };
  if (checks >= 2) return { escalated: true, escalation: 'next_check' };
  if (age >= BREACH_ESCALATION_WINDOW_MS) return { escalated: true, escalation: 'window' };
  return { escalated: false, escalation: null };
}

/** True when the exit line is at or below the new blended cost. */
export function lineAtOrBelowBlended(line: number | null, cost: number | null): boolean {
  return line !== null && cost !== null && Number.isFinite(line) && Number.isFinite(cost) && cost > 0 && line <= cost;
}

/** An add flags when the line is at or below cost, unless the trade recorded a scratch. A first buy does not. */
export function addFlagsLineVsCost(input: {
  line: number | null;
  blended: number | null;
  isAdd: boolean;
  acceptedScratch: boolean;
}): boolean {
  return input.isAdd && !input.acceptedScratch && lineAtOrBelowBlended(input.line, input.blended);
}

/**
 * Walk real prints in time order. A null price is skipped. Equities count only in the regular
 * session. Check 1 is the first print under the line. Check 2, still under, escalates.
 */
export function replayActionableBreachChecks(input: {
  line: number;
  marks: BreachPrint[];
  equity?: boolean;
  asOf?: string | null;
  instrument?: string | null;
}): BreachReplay {
  const equity = input.equity !== false;
  const ordered = [...input.marks].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const hits: BreachPrint[] = [];
  for (const mark of ordered) {
    if (mark.price === null || !Number.isFinite(mark.price) || !Number.isFinite(Date.parse(mark.at))) continue;
    if (mark.price > input.line) continue;
    if (equity && usEquityMarkSession(Date.parse(mark.at)) !== 'rth') continue;
    hits.push(mark);
  }
  const first = hits[0]?.at ?? null;
  const second = hits[1]?.at ?? null;
  const asOf = input.asOf ?? second ?? first;
  const state = breachEscalationState(hits.length, first, asOf);
  const age = first && asOf ? breachAgeMinutes(first, asOf) : null;
  const sentence = state.escalated && age !== null && input.instrument
    ? escalatedBreachSentence(input.instrument, age)
    : null;
  return {
    checks: hits.length,
    first_seen_at: first,
    second_seen_at: second,
    as_of: asOf,
    breach_age_minutes: age,
    escalated: state.escalated,
    escalation: state.escalation,
    sentence,
  };
}

function lot(row: Record<string, unknown>): WatchdogLot {
  const age = minutes(row.breach_age_minutes);
  const instrument = str(row.instrument) ?? '';
  const escalated = flag(row.escalated);
  return {
    steward: str(row.steward) ?? 'unknown',
    lot_table: str(row.lot_table) ?? '',
    lot_id: str(row.lot_id) ?? '',
    instrument,
    unit: str(row.unit) === 'SOL' ? 'SOL' : 'USD',
    thesis_id: str(row.thesis_id),
    invalidation_price: num(row.invalidation_price),
    mark: num(row.mark),
    mark_at: str(row.mark_at),
    action_hint: str(row.action_hint),
    mark_session: markSession(str(row.lot_table), str(row.mark_session), str(row.mark_at)),
    first_seen_at: str(row.first_seen_at),
    breach_age_minutes: age,
    check_count: count(row.check_count),
    escalated,
    escalation: escalationOf(row.escalation),
    sentence: str(row.sentence) ?? (escalated && age !== null ? escalatedBreachSentence(instrument, age) : null),
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
  const breachLots = rows(bag.breaches).map(lot);
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
    unscoreable_decisions: stewardCounts(summary.unscoreable_decisions),
    ...escalatedBreaches(summary.breaches_escalated, summary.escalated, breachLots),
    breaches: breachLots,
    missing: rows(bag.missing).map(lot),
    issues: rows(bag.issues).map(issue),
  };
}

function escalatedBreaches(
  countValue: unknown,
  listed: unknown,
  breachLots: WatchdogLot[],
): Pick<LedgerWatchdog, 'breaches_escalated' | 'escalated'> {
  const fromSummary: EscalatedBreach[] = [];
  for (const row of rows(listed)) {
    const instrument = str(row.instrument);
    const first = str(row.first_seen_at);
    const age = minutes(row.breach_age_minutes);
    const escalation = escalationOf(row.escalation);
    const lotTable = str(row.lot_table);
    const lotId = str(row.lot_id);
    if (!instrument || !first || age === null || !escalation || !lotTable || !lotId) continue;
    const sentence = str(row.sentence) ?? escalatedBreachSentence(instrument, age);
    if (!sentence) continue;
    fromSummary.push({
      steward: str(row.steward) ?? 'unknown',
      lot_table: lotTable,
      lot_id: lotId,
      instrument,
      first_seen_at: first,
      breach_age_minutes: age,
      escalation,
      sentence,
    });
  }
  const fromLots: EscalatedBreach[] = breachLots.flatMap((row) => {
    if (!row.escalated || !row.first_seen_at || row.breach_age_minutes === null || !row.escalation) return [];
    const sentence = row.sentence ?? escalatedBreachSentence(row.instrument, row.breach_age_minutes);
    if (!sentence) return [];
    return [{
      steward: row.steward,
      lot_table: row.lot_table,
      lot_id: row.lot_id,
      instrument: row.instrument,
      first_seen_at: row.first_seen_at,
      breach_age_minutes: row.breach_age_minutes,
      escalation: row.escalation,
      sentence,
    }];
  });
  const escalated = fromSummary.length > 0 ? fromSummary : fromLots;
  const named = num(countValue);
  return {
    breaches_escalated: named !== null ? count(countValue) : escalated.length,
    escalated,
  };
}

function stewardCounts(value: unknown): UnscoreableDecisionCounts {
  const bag = record(value);
  if (!bag) return { ...EMPTY_UNSCOREABLE_DECISIONS };
  return {
    quantanamo: count(bag.quantanamo),
    oddsborne: count(bag.oddsborne),
    bandit: count(bag.bandit),
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
  /** Decisions that cannot be scored. Does not change `ok` on /api/health. */
  unscoreable_decisions: UnscoreableDecisionCounts;
  /** Sell-now count. Does not change `ok` on /api/health. */
  breaches_escalated: number;
  /** Plain sentences, one per escalated lot. */
  escalated: string[];
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
    unscoreable_decisions: { ...w.unscoreable_decisions },
    breaches_escalated: w.breaches_escalated,
    escalated: w.escalated.map((row) => row.sentence),
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
