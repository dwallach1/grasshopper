/**
 * Ledger watchdog: read-only backstop for the retired position monitor.
 * Reads public.v_ledger_watchdog (counts), v_invalidation_breaches and
 * v_open_lots_missing_invalidation. Never invents a mark: a lot without a
 * ledger mark is never a breach. Missing views serve an unavailable, zeroed payload.
 */
import type { MoneyUnit } from './money-units';

export const WATCHDOG_LIST_LIMIT = 50;

/** PostgREST reads (operator /bundle, public bundle, desk-public-rest). */
export const WATCHDOG_QUERIES = {
  summary: 'v_ledger_watchdog?select=*',
  breaches: `v_invalidation_breaches?select=steward,lot_table,lot_id,instrument,unit,thesis_id,invalidation_price,mark,mark_at,mark_age_minutes,action_hint&order=mark_at.desc&limit=${WATCHDOG_LIST_LIMIT}`,
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
    breaches: [],
    missing: [],
    issues: [],
  };
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
    breaches: rows(bag.breaches).map(lot),
    missing: rows(bag.missing).map(lot),
    issues: rows(bag.issues).map(issue),
  };
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
  };
}
