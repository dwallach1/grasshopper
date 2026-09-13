/**
 * Phone desk pull-to-refresh. Arms only at the top of the pane scroller
 * on a vertical drag. Horizontal tab swipe and mid-list scroll stay first.
 * Travel is resisted so the parchment mark eases, not a CRT bounce.
 */
import { lockSwipeAxis } from './desk-swipe';

export const PULL_TRIGGER_PX = 64;
export const PULL_MAX_PX = 88;
export const PULL_RESIST = 0.46;
export const PULL_TOP_SLOP_PX = 1;
export const NESTED_SCROLL_ATTR = 'data-desk-nested-scroll';

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing';

export function pullTravel(
  dy: number,
  resist = PULL_RESIST,
  max = PULL_MAX_PX,
): number {
  if (dy <= 0) return 0;
  return Math.min(max, dy * resist);
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
