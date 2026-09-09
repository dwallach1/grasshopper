/**
 * Board / Book / Team are one horizontal deck. Labels are an indicator.
 * The rail is circular: Board swipe-back lands on Team, Team swipe-forward
 * lands on Board. Card-deck motion is a separate control (`data-card-dragger`).
 * Reduced motion snaps with no travel animation.
 */
import {
  DESK_SWIPE_SURFACES,
  tabForSurface,
  type DeskSurface,
  type DeskSwipeSurface,
} from './desk-nav';

export const PAGE_SWIPE_PX = 56;
export const PAGE_SWIPE_WRAP_PX = 56;
export const PAGE_SWIPE_LOCK_PX = 12;
/** |dx| must beat |dy| by this factor. 1.2 ≈ 40° from the horizontal — not a diagonal. */
export const PAGE_SWIPE_DOMINANCE = 1.2;
export const CARD_DRAGGER_ATTR = 'data-card-dragger';
/** Chrome synthesizes a mouse down after a touch swipe. Ignore it or the rail re-arms short. */
export const COMPAT_MOUSE_SUPPRESS_MS = 700;

export type SwipeAxisLock = 'x' | 'y' | null;

/** Clone the ends so native snap can wrap: Team | Board | Book | Team | Board */
export const DESK_PAGER_SLOTS = [
  { id: 'team', clone: true },
  { id: 'leaderboard', clone: false },
  { id: 'book', clone: false },
  { id: 'team', clone: false },
  { id: 'leaderboard', clone: true },
] as const satisfies readonly { id: DeskSwipeSurface; clone: boolean }[];

export function isSwipeSurface(id: string): id is DeskSwipeSurface {
  for (const surface of DESK_SWIPE_SURFACES) {
    if (surface === id) return true;
  }
  return false;
}

export function swipeSurfaceIndex(id: DeskSurface): number {
  let index = 0;
  for (const surface of DESK_SWIPE_SURFACES) {
    if (surface === id) return index;
    index += 1;
  }
  return -1;
}

export function swipeSurfaceAt(index: number): DeskSwipeSurface | null {
  return DESK_SWIPE_SURFACES[index] ?? null;
}

export function wrapSwipeIndex(index: number, delta: number, count = DESK_SWIPE_SURFACES.length): number {
  if (count <= 0) return 0;
  return ((index + delta) % count + count) % count;
}

export function wrapSwipeSurface(id: DeskSwipeSurface, delta: number): DeskSwipeSurface {
  const next = wrapSwipeIndex(swipeSurfaceIndex(id), delta);
  return DESK_SWIPE_SURFACES[next] ?? id;
}

export function isSwipeWrap(from: DeskSwipeSurface, to: DeskSwipeSurface): boolean {
  return Math.abs(swipeSurfaceIndex(from) - swipeSurfaceIndex(to)) > 1;
}

export function pagerScrollBehavior(reduceMotion: boolean): ScrollBehavior {
  return reduceMotion ? 'auto' : 'smooth';
}

export function pagerScrollToBehavior(
  firstPaint: boolean,
  wrap: boolean,
  reduceMotion: boolean,
): ScrollBehavior {
  if (firstPaint || wrap) return 'auto';
  return pagerScrollBehavior(reduceMotion);
}

export function swipeTabLabel(id: DeskSwipeSurface): string {
  return tabForSurface(id).label;
}

export function pagerSlotKey(id: DeskSwipeSurface, clone: boolean): string {
  return clone ? `${id}-clone` : id;
}

export function isDominantHorizontal(
  dx: number,
  dy: number,
  dominance = PAGE_SWIPE_DOMINANCE,
): boolean {
  return Math.abs(dx) > Math.abs(dy) * dominance;
}

/** -1 previous, 1 next, 0 stay. Needs dominant X past the threshold — not a vertical flick. */
export function swipeAxis(dx: number, dy: number, threshold = PAGE_SWIPE_PX): -1 | 0 | 1 {
  if (Math.abs(dx) < threshold) return 0;
  if (!isDominantHorizontal(dx, dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export function isHorizontalLock(dx: number, dy: number, lock = PAGE_SWIPE_LOCK_PX): boolean {
  return Math.abs(dx) >= lock && isDominantHorizontal(dx, dy);
}

export function isVerticalLock(dx: number, dy: number, lock = PAGE_SWIPE_LOCK_PX): boolean {
  const ay = Math.abs(dy);
  return ay >= lock && ay >= Math.abs(dx);
}

/** First clear axis wins. Diagonals wait; a vertical lock never becomes a tab swipe. */
export function lockSwipeAxis(dx: number, dy: number, lock = PAGE_SWIPE_LOCK_PX): SwipeAxisLock {
  if (isHorizontalLock(dx, dy, lock)) return 'x';
  if (isVerticalLock(dx, dy, lock)) return 'y';
  return null;
}

export function wrapFromEdgeDrag(
  surface: DeskSwipeSurface,
  dx: number,
  dy: number,
  threshold = PAGE_SWIPE_WRAP_PX,
): DeskSwipeSurface | null {
  if (Math.abs(dx) < threshold) return null;
  if (!isDominantHorizontal(dx, dy)) return null;
  const index = swipeSurfaceIndex(surface);
  const last = DESK_SWIPE_SURFACES.length - 1;
  if (dx > 0 && index === 0) return wrapSwipeSurface(surface, -1);
  if (dx < 0 && index === last) return wrapSwipeSurface(surface, 1);
  return null;
}

/** Pane to snap to, or null if this drag is vertical / short / diagonal. */
export function pageSwipeFromDrag(
  surface: DeskSwipeSurface,
  dx: number,
  dy: number,
): DeskSwipeSurface | null {
  const wrap = wrapFromEdgeDrag(surface, dx, dy);
  if (wrap) return wrap;
  const axis = swipeAxis(dx, dy);
  if (axis === 0) return null;
  return wrapSwipeSurface(surface, axis);
}

export function followPagerScroll(startLeft: number, dx: number, maxLeft: number): number {
  const next = startLeft - dx;
  if (next < 0) return 0;
  if (next > maxLeft) return maxLeft;
  return next;
}

export type SwipeHitTarget = {
  closest: (selector: string) => SwipeHitTarget | null;
};

export function swipeHitFromEvent(target: EventTarget | null): SwipeHitTarget | null {
  if (target === null || !('closest' in target)) return null;
  // SAFETY: pointer targets that expose closest are elements on the desk rail.
  return target as SwipeHitTarget;
}

export function isCardDraggerTarget(target: SwipeHitTarget | null): boolean {
  return target !== null && target.closest(`[${CARD_DRAGGER_ATTR}]`) !== null;
}

export function pageSwipeConsumesTarget(target: SwipeHitTarget | null): boolean {
  return !isCardDraggerTarget(target);
}

export function isCompatMouseSuppressed(
  pointerType: string,
  now: number,
  until: number,
): boolean {
  return pointerType === 'mouse' && now < until;
}

export function compatMouseUntil(
  pointerType: string,
  now: number,
  windowMs = COMPAT_MOUSE_SUPPRESS_MS,
): number {
  if (pointerType === 'touch' || pointerType === 'pen') return now + windowMs;
  return 0;
}
