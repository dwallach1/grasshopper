/**
 * Team card deck is index-driven. The page rail does not share this control.
 */
export function clampDeckIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

export function deckIndexFromThumb(offset: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0;
  const t = Math.min(1, Math.max(0, offset / width));
  return clampDeckIndex(Math.round(t * (count - 1)), count);
}

export function deckThumbRatio(index: number, count: number): number {
  if (count <= 1) return 0;
  return clampDeckIndex(index, count) / (count - 1);
}

export function stepDeckIndex(index: number, delta: number, count: number): number {
  return clampDeckIndex(index + delta, count);
}

/** One card per threshold. Drag left or up advances; a short nudge stays put. */
export const TEAM_CARD_DRAG_PX = 48;

export function deckShiftFromDrag(dx: number, stepPx = TEAM_CARD_DRAG_PX): number {
  if (!(stepPx > 0) || !Number.isFinite(dx)) return 0;
  return Math.trunc(-dx / stepPx);
}

/** Dominant axis steps the deck. Vertical is isolated from the horizontal pager. */
export function deckShiftFromAxes(dx: number, dy: number, stepPx = TEAM_CARD_DRAG_PX): number {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  const shift = Math.abs(dy) > Math.abs(dx) ? deckShiftFromDrag(dy, stepPx) : deckShiftFromDrag(dx, stepPx);
  return shift === 0 ? 0 : shift;
}
