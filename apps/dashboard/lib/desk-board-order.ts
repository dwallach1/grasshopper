/** Board standings can be thumb-reordered via the rank dragger. Rank numbers stay scored. */

export const BOARD_DRAG_ROW_PX = 48;

export function applyStandingOrder<T extends { id: string }>(
  rows: readonly T[],
  order: readonly string[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const next: T[] = [];
  for (const id of order) {
    const row = byId.get(id);
    if (!row || seen.has(id)) continue;
    next.push(row);
    seen.add(id);
  }
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    next.push(row);
  }
  return next;
}

export function moveStanding(order: readonly string[], id: string, delta: number): string[] {
  const index = order.indexOf(id);
  if (index < 0 || delta === 0) return [...order];
  const nextIndex = Math.min(order.length - 1, Math.max(0, index + delta));
  if (nextIndex === index) return [...order];
  const copy = [...order];
  const [item] = copy.splice(index, 1);
  if (item === undefined) return copy;
  copy.splice(nextIndex, 0, item);
  return copy;
}

export function standingShiftFromDrag(dy: number, rowPx = BOARD_DRAG_ROW_PX): number {
  if (!(rowPx > 0) || !Number.isFinite(dy)) return 0;
  return Math.trunc(dy / rowPx);
}
