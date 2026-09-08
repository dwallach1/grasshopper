import { describe, expect, test } from 'bun:test';

import { DESK_SWIPE_SURFACES, DESK_SWIPE_TABS, DESK_TABS } from './desk-nav';
import {
  followPagerScroll,
  isCardDraggerTarget,
  isHorizontalLock,
  isSwipeSurface,
  isSwipeWrap,
  pageSwipeConsumesTarget,
  pagerScrollBehavior,
  pagerScrollToBehavior,
  swipeAxis,
  swipeHitFromEvent,
  swipeSurfaceAt,
  swipeSurfaceIndex,
  swipeTabLabel,
  wrapSwipeIndex,
  wrapSwipeSurface,
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
    expect(swipeAxis(-80, 10)).toBe(1);
    expect(swipeAxis(80, 8)).toBe(-1);
    expect(swipeAxis(-80, 90)).toBe(0);
    expect(swipeAxis(-20, 0)).toBe(0);
    expect(isHorizontalLock(16, 4)).toBe(true);
    expect(isHorizontalLock(4, 16)).toBe(false);
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
});
