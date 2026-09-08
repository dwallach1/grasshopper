import { describe, expect, test } from 'bun:test';

import { DESK_SWIPE_SURFACES, DESK_SWIPE_TABS, DESK_TABS } from './desk-nav';
import {
  isSwipeSurface,
  pagerScrollBehavior,
  swipeSurfaceAt,
  swipeSurfaceIndex,
  swipeTabLabel,
} from './desk-swipe';

describe('desk swipe deck', () => {
  test('Board / Book / Theses / Team stay one rail in that order', () => {
    expect([...DESK_SWIPE_SURFACES]).toEqual(['leaderboard', 'book', 'theses', 'team']);
    expect(DESK_SWIPE_TABS.map((tab) => tab.label)).toEqual(['Board', 'Book', 'Theses', 'Team']);
    expect(DESK_SWIPE_TABS.map((tab) => tab.href)).toEqual(['/', '/book', '/theses', '/team']);
    expect(swipeSurfaceIndex('leaderboard')).toBe(0);
    expect(swipeSurfaceIndex('book')).toBe(1);
    expect(swipeSurfaceIndex('theses')).toBe(2);
    expect(swipeSurfaceIndex('team')).toBe(3);
    expect(swipeSurfaceAt(1)).toBe('book');
    expect(swipeSurfaceAt(-1)).toBeNull();
    expect(swipeSurfaceAt(4)).toBeNull();
    expect(swipeTabLabel('theses')).toBe('Theses');
    expect(swipeTabLabel('team')).toBe('Team');
  });

  test('operator Events and Tests stay off the phone deck', () => {
    expect(isSwipeSurface('leaderboard')).toBe(true);
    expect(isSwipeSurface('book')).toBe(true);
    expect(isSwipeSurface('theses')).toBe(true);
    expect(isSwipeSurface('team')).toBe(true);
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
});
