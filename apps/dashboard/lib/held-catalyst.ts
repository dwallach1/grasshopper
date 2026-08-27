import { nyDateKey } from './ny-date';
import type { BookNameLine, CatalystRow } from './ledger-types';

const DEAD_STATUSES = new Set([
  'cancelled',
  'canceled',
  'passed',
  'expired',
  'killed',
  'done',
]);

function eventDay(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}

/**
 * Next dated catalyst on currently held book names. Pre-event primacy:
 * do not filter the universe to AI — Events keeps the full sheet.
 */
export function nextHeldCatalyst(
  catalysts: readonly CatalystRow[],
  names: readonly BookNameLine[],
  nowIso: string,
): CatalystRow | null {
  const held = new Set(names.map((row) => row.symbol.toUpperCase()));
  if (held.size === 0) return null;
  const today = nyDateKey(nowIso);
  const upcoming = catalysts.filter((row) => {
    if (!row.symbol || !row.event_date) return false;
    if (!held.has(row.symbol.toUpperCase())) return false;
    if (DEAD_STATUSES.has(row.status.toLowerCase())) return false;
    return eventDay(row.event_date) >= today;
  });
  upcoming.sort((a, b) => {
    const byDate = eventDay(a.event_date ?? '').localeCompare(eventDay(b.event_date ?? ''));
    if (byDate !== 0) return byDate;
    return (a.symbol ?? '').localeCompare(b.symbol ?? '');
  });
  return upcoming[0] ?? null;
}

export type ThesisSymbolSplit = {
  held: string[];
  candidates: string[];
};

export function heldAndCandidateSymbols(
  symbols: readonly string[],
  heldLots: readonly string[],
): ThesisSymbolSplit {
  const heldSet = new Set(heldLots);
  const held = symbols.filter((symbol) => heldSet.has(symbol));
  const extraHeld = heldLots.filter((symbol) => !symbols.includes(symbol));
  const candidates = symbols.filter((symbol) => !heldSet.has(symbol));
  return { held: [...held, ...extraHeld], candidates };
}
