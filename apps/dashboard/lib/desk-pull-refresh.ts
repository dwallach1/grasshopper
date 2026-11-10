/**
 * Phone desk pull-to-refresh. Arms only at the top of the pane scroller
 * on a vertical drag. Horizontal tab swipe and mid-list scroll stay first.
 * Travel is a rubber band: resistance grows, and the mark approaches
 * PULL_MAX_PX without a hard stop. The band is tuned so the old flat line
 * `dy * PULL_RESIST` and this curve arm refresh at the same finger distance.
 */
import { lockSwipeAxis } from './desk-swipe';

export const PULL_TRIGGER_PX = 64;
export const PULL_MAX_PX = 88;
/** Finger distance of the old flat line. The curve passes through the trigger there. */
export const PULL_RESIST = 0.46;
export const PULL_TOP_SLOP_PX = 1;
export const NESTED_SCROLL_ATTR = 'data-desk-nested-scroll';

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing';

/** Time constant so `pullTravel(trigger / resist) === trigger` under asymptote `max`. */
export function pullRubberK(
  max = PULL_MAX_PX,
  trigger = PULL_TRIGGER_PX,
  resist = PULL_RESIST,
): number {
  if (!(max > 0) || !(resist > 0)) return 1;
  const anchorDy = trigger / resist;
  const anchorTravel = Math.min(Math.max(trigger, 0), max * (1 - 1e-6));
  if (!(anchorDy > 0) || !(anchorTravel > 0) || anchorTravel >= max) return anchorDy > 0 ? anchorDy : 1;
  return -anchorDy / Math.log(1 - anchorTravel / max);
}

/**
 * Asymptotic rubber band. 0 at rest, strictly increasing, always below `max`.
 * Initial slope is near 1 and falls as the finger goes further — no wall at 88.
 */
export function pullTravel(dy: number, max = PULL_MAX_PX): number {
  if (!Number.isFinite(dy) || dy <= 0 || !(max > 0)) return 0;
  const k = pullRubberK(max);
  if (!(k > 0)) return 0;
  const decay = Math.exp(-dy / k);
  const travel = max * (1 - decay);
  if (!(travel < max)) return max * (1 - 1e-9);
  return travel;
}

/** df/dy. Release speed of the mark is this times the finger's px/s. */
export function pullSlope(dy: number, max = PULL_MAX_PX): number {
  if (!(max > 0)) return 0;
  const k = pullRubberK(max);
  if (!(k > 0)) return 0;
  const finger = dy > 0 && Number.isFinite(dy) ? dy : 0;
  return (max / k) * Math.exp(-Math.min(finger, 1e6) / k);
}

export function pullReleaseVelocity(dy: number, fingerVelocity: number, max = PULL_MAX_PX): number {
  if (!Number.isFinite(fingerVelocity)) return 0;
  return pullSlope(dy, max) * fingerVelocity;
}

/** Inverse of pullTravel, so a catch mid-settle continues on the same curve. */
export function pullFingerForTravel(travel: number, max = PULL_MAX_PX): number {
  if (!Number.isFinite(travel) || travel <= 0 || !(max > 0)) return 0;
  const k = pullRubberK(max);
  if (!(k > 0)) return 0;
  const ratio = Math.min(travel / max, 1 - 1e-6);
  if (ratio <= 0) return 0;
  return -k * Math.log(1 - ratio);
}

export function pullProgress(travel: number, trigger = PULL_TRIGGER_PX): number {
  if (trigger <= 0) return 0;
  return Math.min(1, travel / trigger);
}

export function isPaneAtTop(scrollTop: number, slop = PULL_TOP_SLOP_PX): boolean {
  return scrollTop <= slop;
}

/** Vertical lock at the top, pulling down — not a tab swipe, not mid-list. */
export function canBeginPull(
  scrollTop: number,
  dx: number,
  dy: number,
): boolean {
  if (!isPaneAtTop(scrollTop)) return false;
  if (dy <= 0) return false;
  return lockSwipeAxis(dx, dy) === 'y';
}

export function shouldCommitPull(travel: number, trigger = PULL_TRIGGER_PX): boolean {
  return travel >= trigger;
}

export function pullPhase(
  travel: number,
  refreshing: boolean,
  trigger = PULL_TRIGGER_PX,
): PullPhase {
  if (refreshing) return 'refreshing';
  if (travel <= 0) return 'idle';
  if (travel >= trigger) return 'armed';
  return 'pulling';
}

export type NestedScrollHost = {
  querySelectorAll: (selector: string) => ArrayLike<{ hidden?: boolean }>;
};

/** Prefer the innermost visible nested scroller (thesis page over the list). */
export function nestedScrollIndex(
  host: NestedScrollHost | null,
  attr = NESTED_SCROLL_ATTR,
): number {
  if (host === null) return -1;
  const nodes = host.querySelectorAll(`[${attr}]`);
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node && !node.hidden) return i;
  }
  return -1;
}

export function paneScrollTop(scrollTop: number | null | undefined): number {
  if (scrollTop === null || scrollTop === undefined) return 0;
  if (!Number.isFinite(scrollTop)) return 0;
  return Math.max(0, scrollTop);
}
