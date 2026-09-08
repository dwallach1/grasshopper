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
