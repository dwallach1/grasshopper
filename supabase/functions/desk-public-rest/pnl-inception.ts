/**
 * Book start vs a capped pnl tail.
 * The phone bundle keeps a short recent tail for the liveline.
 * When that tail is full, the earliest row in it is not day one.
 * `pnl_start` is the ledger's first mark, kept off the tail so the
 * chart clock does not stretch back to inception.
 * A short tail already contains day one — leave `pnl_start` null.
 */

/** Operator postgres / REST / full-bundle tail. The public phone cap is smaller. */
export const PNL_TAIL_LIMIT = 200;

export type PnlStartWindow<T> = {
  pnl: T[];
  pnl_start: T | null;
};

function pnlRowId(row: unknown): string | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = (row as { id?: unknown }).id;
  if (typeof id === 'string' && id) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

/**
 * Keep `latest` as the liveline tail. Attach `first` only when the tail
 * hit `limit` and that row is not already inside it.
 */
export function attachPnlStart<T>(
  latest: readonly T[],
  first: T | null | undefined,
  limit: number,
): PnlStartWindow<T> {
  if (!(limit > 0) || latest.length < limit || first == null) {
    return { pnl: [...latest], pnl_start: null };
  }
  const firstId = pnlRowId(first);
  if (firstId && latest.some((row) => pnlRowId(row) === firstId)) {
    return { pnl: [...latest], pnl_start: null };
  }
  return { pnl: [...latest], pnl_start: first };
}
