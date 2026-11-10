/**
 * Board / Book / Team are one horizontal deck. Labels are an indicator.
 * The rail is circular: Board swipe-back lands on Team, Team swipe-forward
 * lands on Board. Team itself is a vertical stack on that rail, so a horizontal
 * drag on a steward card changes tabs. The Board rank handle (`data-card-dragger`)
 * owns its drag on both axes. A marked team-card body (`data-team-card`) still
 * suppresses a horizontal tab swipe when that attribute is present. Reduced
 * motion snaps with no travel animation.
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
/** A short flick commits even when the finger traveled less than PAGE_SWIPE_PX. px/s. */
export const PAGE_FLICK_PX_S = 500;
/** Release speed is the movement inside this tail, so a pause does not inherit an earlier burst. */
export const VELOCITY_WINDOW_MS = 100;
/** A resting page, not a coordinate the smooth wrap used to pass through. */
export const PAGER_SETTLE_PX = 8;
/** |dx| must beat |dy| by this factor. 1.2 ≈ 40° from the horizontal — not a diagonal. */
export const PAGE_SWIPE_DOMINANCE = 1.2;
export const CARD_DRAGGER_ATTR = 'data-card-dragger';
export const TEAM_CARD_ATTR = 'data-team-card';
/** Chrome synthesizes a mouse down after a touch swipe. Ignore it or the rail re-arms short. */
export const COMPAT_MOUSE_SUPPRESS_MS = 700;
/** After a handle or card-body gesture, keep rejecting rail snap until the finger's scroll settles. */
export const PAGER_PIN_SETTLE_MS = 400;

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

/** First ↔ last only. Board ↔ Team is the wrap; Book sits between them. */
export function isSwipeWrap(from: DeskSwipeSurface, to: DeskSwipeSurface): boolean {
  const a = swipeSurfaceIndex(from);
  const b = swipeSurfaceIndex(to);
  const last = DESK_SWIPE_SURFACES.length - 1;
  if (a < 0 || b < 0 || last < 1) return false;
  return (a === 0 && b === last) || (a === last && b === 0);
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

export type PointerSample = { t: number; x: number };

/** Keep the last ~100ms. A stopped finger has nothing left in the window. */
export function notePointerSample(
  samples: readonly PointerSample[],
  t: number,
  x: number,
  windowMs = VELOCITY_WINDOW_MS,
): PointerSample[] {
  if (!Number.isFinite(t) || !Number.isFinite(x)) return samples.slice();
  const cutoff = t - windowMs;
  const next: PointerSample[] = [];
  for (const sample of samples) {
    if (sample.t >= cutoff) next.push(sample);
  }
  next.push({ t, x });
  if (next.length > 32) next.splice(0, next.length - 32);
  return next;
}

/**
 * Signed px/s across samples that fall inside the last `windowMs` of `now`.
 * One sample, or a gap, is a stop: 0. The sign matches the axis (right / down positive).
 */
export function releaseVelocity(
  samples: readonly PointerSample[],
  now: number,
  windowMs = VELOCITY_WINDOW_MS,
): number {
  if (!Number.isFinite(now) || samples.length < 2) return 0;
  const cutoff = now - windowMs;
  let first: PointerSample | null = null;
  let last: PointerSample | null = null;
  for (const sample of samples) {
    if (sample.t < cutoff || sample.t > now) continue;
    if (!Number.isFinite(sample.t) || !Number.isFinite(sample.x)) continue;
    if (first === null) first = sample;
    last = sample;
  }
  if (first === null || last === null) return 0;
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return ((last.x - first.x) / dt) * 1000;
}

/**
 * -1 previous, 1 next, 0 stay. The axis is already locked.
 * Distance past the threshold commits, and so does a flick the other way:
 * release speed wins when it clears PAGE_FLICK_PX_S, so a short fast flick counts
 * and a reversal is not dragged onward by the earlier travel.
 */
export function swipeRelease(
  dx: number,
  velocity: number,
  threshold = PAGE_SWIPE_PX,
  flick = PAGE_FLICK_PX_S,
): -1 | 0 | 1 {
  if (!Number.isFinite(dx) || !Number.isFinite(velocity)) return 0;
  if (Math.abs(velocity) >= flick && velocity !== 0) return velocity < 0 ? 1 : -1;
  if (Math.abs(dx) < threshold) return 0;
  return dx < 0 ? 1 : -1;
}

/** -1 previous, 1 next, 0 stay. Dominant X only — a vertical flick never changes tabs. */
export function swipeAxis(
  dx: number,
  dy: number,
  threshold = PAGE_SWIPE_PX,
  velocity = 0,
  flick = PAGE_FLICK_PX_S,
): -1 | 0 | 1 {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  if (!isDominantHorizontal(dx, dy)) return 0;
  return swipeRelease(dx, velocity, threshold, flick);
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

/** Pane to snap to, or null if this drag is vertical / short / diagonal. Velocity flips a short flick. */
export function pageSwipeFromDrag(
  surface: DeskSwipeSurface,
  dx: number,
  dy: number,
  velocity = 0,
): DeskSwipeSurface | null {
  const axis = swipeAxis(dx, dy, PAGE_SWIPE_PX, velocity);
  if (axis === 0) return null;
  return wrapSwipeSurface(surface, axis);
}

export type SpringState = {
  position: number;
  velocity: number;
  target: number;
};

export type SpringTune = {
  stiffness: number;
  damping: number;
  /** Reduced motion settles without crossing the target. */
  overshoot: boolean;
};

/** Underdamped so a drag can bounce once. Reduced motion is overdamped and clamped. */
export function gestureSpring(reduceMotion: boolean): SpringTune {
  if (reduceMotion) return { stiffness: 640, damping: 72, overshoot: false };
  return { stiffness: 280, damping: 22, overshoot: true };
}

export function springStep(state: SpringState, dtSeconds: number, tune: SpringTune): SpringState {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return state;
  if (!Number.isFinite(state.position) || !Number.isFinite(state.velocity) || !Number.isFinite(state.target)) {
    return state;
  }
  const dt = Math.min(dtSeconds, 0.034);
  const displacement = state.position - state.target;
  const acceleration = (-tune.stiffness * displacement) - (tune.damping * state.velocity);
  const velocity = state.velocity + (acceleration * dt);
  const position = state.position + (velocity * dt);
  if (!tune.overshoot) {
    const before = state.position - state.target;
    const after = position - state.target;
    if (before === 0 || before * after <= 0) {
      return { position: state.target, velocity: 0, target: state.target };
    }
  }
  return { position, velocity, target: state.target };
}

export function springSettled(state: SpringState, epsilon = 0.5, velocityEpsilon = 40): boolean {
  return Math.abs(state.position - state.target) <= epsilon
    && Math.abs(state.velocity) <= velocityEpsilon;
}

export function followPagerScroll(startLeft: number, dx: number, maxLeft: number): number {
  const next = startLeft - dx;
  if (next < 0) return 0;
  if (next > maxLeft) return maxLeft;
  return next;
}

/**
 * Slot index when the scroller is actually resting on a page.
 * A Board↔Team jump that is still crossing Book is not a commit.
 */
export function settledPagerSlot(scrollLeft: number, width: number, slotCount: number): number | null {
  if (width <= 0 || slotCount <= 0) return null;
  if (!Number.isFinite(scrollLeft)) return null;
  const slot = Math.round(scrollLeft / width);
  if (slot < 0 || slot >= slotCount) return null;
  if (Math.abs(scrollLeft - slot * width) > PAGER_SETTLE_PX) return null;
  return slot;
}

export type PagerScrollNode = {
  style: { scrollBehavior: string; scrollSnapType: string };
  scrollLeft: number;
};

/**
 * `scrollLeft` follows the element's scroll-behavior. The pager used to leave
 * that on smooth, so the Board↔Team "jump" animated through Book and snap-stop
 * could arrest there. Force auto for the assignment, then restore.
 */
export function instantPagerLeft(node: PagerScrollNode, left: number): void {
  if (node.scrollLeft === left) return;
  const behavior = node.style.scrollBehavior;
  const snap = node.style.scrollSnapType;
  node.style.scrollBehavior = 'auto';
  node.style.scrollSnapType = 'none';
  node.scrollLeft = left;
  node.style.scrollSnapType = snap;
  node.style.scrollBehavior = behavior;
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

export function isTeamCardBodyTarget(target: SwipeHitTarget | null): boolean {
  if (target === null || isCardDraggerTarget(target)) return false;
  return target.closest(`[${TEAM_CARD_ATTR}]`) !== null;
}

/** Horizontal tab swipe skips the Team card body. Vertical pull still arms. */
export function horizontalPageSwipeSuppressed(target: SwipeHitTarget | null): boolean {
  return isTeamCardBodyTarget(target);
}

export type TeamGestureKind = 'handle' | 'card' | 'page';

/** A card-body touch shorter than this is still a tap. Past it, horizontal pan must not move the rail. */
export const CARD_NATIVE_BLOCK_PX = 6;

export function teamGestureKind(target: SwipeHitTarget | null): TeamGestureKind {
  if (isCardDraggerTarget(target)) return 'handle';
  if (isTeamCardBodyTarget(target)) return 'card';
  return 'page';
}

/**
 * The Board rank handle owns the gesture on both axes.
 * A marked team-card body blocks a horizontal pan so a leftover carousel cannot
 * fight the rail. The Team stack does not mark cards that way: mast and cards
 * stay with the pager.
 */
export function touchBlocksNativePan(
  kind: TeamGestureKind,
  dx: number,
  dy: number,
  block = CARD_NATIVE_BLOCK_PX,
): boolean {
  if (kind === 'handle') return true;
  if (kind !== 'card') return false;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.abs(dx) >= block && isDominantHorizontal(dx, dy);
}

/** Capture only after the rail locks to a tab swipe or a top-of-pane pull. A tap must reach Book rows. */
export function shouldCapturePagerPointer(axis: SwipeAxisLock, pulling: boolean): boolean {
  if (axis === 'x') return true;
  return axis === 'y' && pulling;
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
