import { NOT_IN_LEDGER } from './book-performance';
import type { FillLogRow } from './ledger-types';

/** Official Rive demo used as motion chrome — never a ledger mark. */
export const TAPE_RIVE_SRC = '/rive/skills.riv';
export const TAPE_RIVE_STATE_MACHINE = 'Designer handoff';
export const TAPE_RIVE_PROGRESS_INPUT = 'Level';
export const TAPE_STEP_MS = 850;

/**
 * Oldest-first story order. `desk.fill_log` is newest-first for the table.
 * Does not invent rows — empty in, empty out.
 */
export function replayFills(rows: readonly FillLogRow[]): FillLogRow[] {
  return [...rows].sort((a, b) => {
    const byTime = a.at.localeCompare(b.at);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

/** 0–100 for a Rive number input. Empty tape stays 0 — not a fake fill. */
export function replayProgress(index: number, count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 100;
  const clamped = Math.min(Math.max(index, 0), count - 1);
  return Math.round((clamped / (count - 1)) * 100);
}

/**
 * Relative |notional| vs the largest abs notional on this tape.
 * Null notional → 0. Never synthesizes a dollar or SOL amount.
 */
export function replayIntensity(row: FillLogRow | undefined, maxAbsNotional: number): number {
  if (!row || row.notional === null || maxAbsNotional <= 0) return 0;
  return Math.min(100, Math.round((Math.abs(row.notional) / maxAbsNotional) * 100));
}

export function maxAbsNotional(rows: readonly FillLogRow[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.notional === null) continue;
    const abs = Math.abs(row.notional);
    if (abs > max) max = abs;
  }
  return max;
}

export function tapeCaption(rows: readonly FillLogRow[]): string {
  if (rows.length === 0) return NOT_IN_LEDGER;
  return `${rows.length} ledger fill${rows.length === 1 ? '' : 's'} · tap to replay`;
}
