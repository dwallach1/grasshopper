import { describe, expect, test } from 'bun:test';

import { DESK_SWIPE_SURFACES, DESK_SWIPE_TABS, DESK_TABS, PUBLIC_DESK_TABS } from './desk-nav';
import {
  DESK_PAGER_SLOTS,
  followPagerScroll,
  isCardDraggerTarget,
  isDominantHorizontal,
  isHorizontalLock,
  isSwipeSurface,
  isSwipeWrap,
  isVerticalLock,
  lockSwipeAxis,
  pageSwipeConsumesTarget,
  pageSwipeFromDrag,
  pagerScrollBehavior,
  pagerScrollToBehavior,
  pagerSlotKey,
  swipeAxis,
  swipeHitFromEvent,
  swipeSurfaceAt,
  swipeSurfaceIndex,
  swipeTabLabel,
  wrapFromEdgeDrag,
  wrapSwipeIndex,
  wrapSwipeSurface,
  compatMouseUntil,
  isCompatMouseSuppressed,
  type SwipeHitTarget,
} from './desk-swipe';

describe('desk swipe deck', () => {
  test('Board / Book / Team stay one rail in that order', () => {
    expect([...DESK_SWIPE_SURFACES]).toEqual(['leaderboard', 'book', 'team']);
    expect(DESK_SWIPE_TABS.map((tab) => tab.label)).toEqual(['Board', 'Book', 'Team']);
    expect(DESK_SWIPE_TABS.map((tab) => tab.href)).toEqual(['/', '/book', '/team']);
    expect(swipeSurfaceIndex('leaderboard')).toBe(0);
    expect(swipeSurfaceIndex('book')).toBe(1);
    expect(swipeSurfaceIndex('team')).toBe(2);
    expect(swipeSurfaceAt(1)).toBe('book');
    expect(swipeSurfaceAt(-1)).toBeNull();
    expect(swipeSurfaceAt(3)).toBeNull();
    expect(swipeTabLabel('team')).toBe('Team');
  });

  test('operator tabs are not on the phone deck', () => {
    expect(isSwipeSurface('leaderboard')).toBe(true);
    expect(isSwipeSurface('book')).toBe(true);
    expect(isSwipeSurface('team')).toBe(true);
    expect(isSwipeSurface('theses')).toBe(false);
    expect(isSwipeSurface('events')).toBe(false);
    expect(isSwipeSurface('backtests')).toBe(false);
    expect(DESK_TABS.map((tab) => tab.id)).toEqual([
      'leaderboard', 'book', 'theses', 'events', 'backtests', 'team',
    ]);
    expect(PUBLIC_DESK_TABS.map((tab) => tab.label)).toEqual(['Board', 'Book', 'Theses', 'Team']);
    expect(PUBLIC_DESK_TABS.map((tab) => tab.href)).toEqual(['/', '/book', '/theses', '/team']);
  });

  test('reduced motion snaps with no travel animation', () => {
    expect(pagerScrollBehavior(true)).toBe('auto');
    expect(pagerScrollBehavior(false)).toBe('smooth');
  });

  test('the rail is circular both ways', () => {
    expect(wrapSwipeIndex(0, -1)).toBe(2);
    expect(wrapSwipeIndex(2, 1)).toBe(0);
    expect(wrapSwipeIndex(1, 1)).toBe(2);
    expect(wrapSwipeIndex(1, -1)).toBe(0);
    expect(wrapSwipeSurface('leaderboard', -1)).toBe('team');
    expect(wrapSwipeSurface('team', 1)).toBe('leaderboard');
    expect(wrapSwipeSurface('book', 1)).toBe('team');
    expect(wrapSwipeSurface('team', -1)).toBe('book');
    expect(wrapFromEdgeDrag('leaderboard', 80, 8)).toBe('team');
    expect(wrapFromEdgeDrag('team', -80, 8)).toBe('leaderboard');
    expect(wrapFromEdgeDrag('book', 80, 8)).toBeNull();
    expect(wrapFromEdgeDrag('leaderboard', 20, 4)).toBeNull();
    expect(wrapFromEdgeDrag('leaderboard', 80, 90)).toBeNull();
    expect(pageSwipeFromDrag('leaderboard', 80, 8)).toBe('team');
    expect(pageSwipeFromDrag('team', -80, 8)).toBe('leaderboard');
    expect(pageSwipeFromDrag('leaderboard', -80, 10)).toBe('book');
    expect(pageSwipeFromDrag('leaderboard', -300, 12)).toBe('book');
    expect(pageSwipeFromDrag('leaderboard', 12, 140)).toBeNull();
    expect(DESK_PAGER_SLOTS.map((slot) => pagerSlotKey(slot.id, slot.clone))).toEqual([
      'team-clone', 'leaderboard', 'book', 'team', 'leaderboard-clone',
    ]);
    expect(isSwipeWrap('leaderboard', 'team')).toBe(true);
    expect(isSwipeWrap('team', 'leaderboard')).toBe(true);
    expect(isSwipeWrap('leaderboard', 'book')).toBe(false);
    expect(isSwipeWrap('book', 'team')).toBe(false);
  });

  test('wrap jumps without travel; adjacent keeps the motion preference', () => {
    expect(pagerScrollToBehavior(true, false, false)).toBe('auto');
    expect(pagerScrollToBehavior(false, true, false)).toBe('auto');
    expect(pagerScrollToBehavior(false, false, true)).toBe('auto');
    expect(pagerScrollToBehavior(false, false, false)).toBe('smooth');
  });

  test('page swipe is horizontal-only and does not share the card dragger', () => {
    expect(isDominantHorizontal(-80, 10)).toBe(true);
    expect(isDominantHorizontal(-80, 90)).toBe(false);
    expect(swipeAxis(-80, 10)).toBe(1);
    expect(swipeAxis(80, 8)).toBe(-1);
    expect(swipeAxis(-80, 90)).toBe(0);
    expect(swipeAxis(40, 140)).toBe(0);
    expect(swipeAxis(-20, 0)).toBe(0);
    expect(isHorizontalLock(24, 8)).toBe(true);
    expect(isHorizontalLock(16, 30)).toBe(false);
    expect(isHorizontalLock(4, 16)).toBe(false);
    expect(isVerticalLock(12, 140)).toBe(true);
    expect(isVerticalLock(80, 8)).toBe(false);
    expect(lockSwipeAxis(8, 40)).toBe('y');
    expect(lockSwipeAxis(40, 8)).toBe('x');
    expect(lockSwipeAxis(4, 4)).toBeNull();
    expect(followPagerScroll(100, 40, 400)).toBe(60);
    expect(followPagerScroll(0, 40, 400)).toBe(0);
    expect(followPagerScroll(400, -40, 400)).toBe(400);
    const thumb: SwipeHitTarget = {
      closest(selector) {
        return selector === '[data-card-dragger]' ? thumb : null;
      },
    };
    const pane: SwipeHitTarget = {
      closest() {
        return null;
      },
    };
    expect(isCardDraggerTarget(thumb)).toBe(true);
    expect(pageSwipeConsumesTarget(thumb)).toBe(false);
    expect(pageSwipeConsumesTarget(pane)).toBe(true);
    expect(pageSwipeConsumesTarget(null)).toBe(true);
    expect(swipeHitFromEvent(null)).toBeNull();
  });

  test('a touch swipe does not re-arm on the compatibility mouse down', () => {
    expect(compatMouseUntil('touch', 1000)).toBe(1700);
    expect(compatMouseUntil('pen', 1000)).toBe(1700);
    expect(compatMouseUntil('mouse', 1000)).toBe(0);
    expect(isCompatMouseSuppressed('mouse', 1200, 1700)).toBe(true);
    expect(isCompatMouseSuppressed('mouse', 1800, 1700)).toBe(false);
    expect(isCompatMouseSuppressed('touch', 1200, 1700)).toBe(false);
  });
});
