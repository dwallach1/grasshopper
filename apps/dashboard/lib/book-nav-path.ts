import { agenticSnapshots } from './book-performance';
import type { AccountRow } from './ledger-types';
import { nyDateKey } from './ny-date';

export type NavWindowId = 'session' | '1d' | 'all';

export type NavWindowOption = {
  id: NavWindowId;
  label: string;
};

export const NAV_WINDOWS: readonly NavWindowOption[] = [
  { id: 'session', label: 'session' },
  { id: '1d', label: '1d' },
  { id: 'all', label: 'all' },
];

export type NavPoint = {
  time: number;
  value: number;
};

const DAY_MS = 86_400_000;

function oldestFirst(rows: readonly AccountRow[]): AccountRow[] {
  return [...agenticSnapshots([...rows])].sort((a, b) => {
    const byTime = a.observed_at.localeCompare(b.observed_at);
    if (byTime !== 0) return byTime;
    return 0;
  });
}

function dedupeTime(rows: readonly AccountRow[]): AccountRow[] {
  const seen = new Set<string>();
  const out: AccountRow[] = [];
  for (const row of rows) {
    if (seen.has(row.observed_at)) continue;
    seen.add(row.observed_at);
    out.push(row);
  }
  return out;
}

function latestTime(rows: readonly AccountRow[], latestObservedAt: string | null): number | null {
  if (latestObservedAt) {
    const ms = Date.parse(latestObservedAt);
    if (Number.isFinite(ms)) return ms;
  }
  const last = rows[rows.length - 1];
  if (!last) return null;
  const ms = Date.parse(last.observed_at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Agentic NAV polyline from ledger snapshots. Oldest first. Sparse is honest —
 * no interpolated timestamps, no personal-book fallback.
 */
export function navPathSeries(input: {
  snapshotsNewestFirst: readonly AccountRow[];
  window: NavWindowId;
  latestObservedAt: string | null;
}): NavPoint[] {
  const rows = dedupeTime(oldestFirst(input.snapshotsNewestFirst));
  if (rows.length === 0) return [];
  const endMs = latestTime(rows, input.latestObservedAt);
  const sessionDay = input.latestObservedAt
    ? nyDateKey(input.latestObservedAt)
    : (rows[rows.length - 1] ? nyDateKey(rows[rows.length - 1]!.observed_at) : null);

  const filtered = rows.filter((row) => {
    const ms = Date.parse(row.observed_at);
    if (!Number.isFinite(ms)) return false;
    if (input.window === 'all') return true;
    if (input.window === '1d') {
      if (endMs === null) return true;
      return ms >= endMs - DAY_MS;
    }
    if (!sessionDay) return true;
    return nyDateKey(row.observed_at) === sessionDay;
  });

  return filtered.map((row) => ({
    time: Date.parse(row.observed_at),
    value: row.total_value,
  }));
}
