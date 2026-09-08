import { describe, expect, test } from 'bun:test';

import { DESK_SWIPE_SURFACES, DESK_SWIPE_TABS, DESK_TABS, PUBLIC_DESK_TABS } from './desk-nav';
import {
  isSwipeSurface,
  pagerScrollBehavior,
  swipeSurfaceAt,
  swipeSurfaceIndex,
  swipeTabLabel,
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
});
