import { describe, expect, test } from 'bun:test';

import {
  NESTED_SCROLL_ATTR,
  PULL_MAX_PX,
  PULL_TRIGGER_PX,
  canBeginPull,
  isPaneAtTop,
  nestedScrollIndex,
  paneScrollTop,
  pullPhase,
  pullProgress,
  pullTravel,
  shouldCommitPull,
} from './desk-pull-refresh';

describe('desk pull-to-refresh', () => {
  test('travel is resisted and capped — not a 1:1 CRT yank', () => {
    expect(pullTravel(0)).toBe(0);
    expect(pullTravel(-40)).toBe(0);
    expect(pullTravel(40)).toBeGreaterThan(0);
    expect(pullTravel(40)).toBeLessThan(40);
    expect(pullTravel(400)).toBe(PULL_MAX_PX);
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(PULL_TRIGGER_PX)).toBe(1);
    expect(pullProgress(PULL_TRIGGER_PX / 2)).toBeCloseTo(0.5);
    expect(pullProgress(PULL_TRIGGER_PX * 2)).toBe(1);
  });

  test('only the top of a pane can arm a pull; mid-list stays scroll', () => {
    expect(isPaneAtTop(0)).toBe(true);
    expect(isPaneAtTop(1)).toBe(true);
    expect(isPaneAtTop(24)).toBe(false);
    expect(canBeginPull(0, 6, 40)).toBe(true);
    expect(canBeginPull(0, 6, -40)).toBe(false);
    expect(canBeginPull(80, 6, 40)).toBe(false);
    expect(canBeginPull(0, 80, 8)).toBe(false);
    expect(canBeginPull(0, 4, 4)).toBe(false);
  });

  test('release past the trigger refreshes; short pulls snap back', () => {
    expect(shouldCommitPull(PULL_TRIGGER_PX)).toBe(true);
    expect(shouldCommitPull(PULL_TRIGGER_PX + 8)).toBe(true);
    expect(shouldCommitPull(PULL_TRIGGER_PX - 1)).toBe(false);
    expect(shouldCommitPull(0)).toBe(false);
    expect(pullPhase(0, false)).toBe('idle');
    expect(pullPhase(20, false)).toBe('pulling');
    expect(pullPhase(PULL_TRIGGER_PX, false)).toBe('armed');
    expect(pullPhase(8, true)).toBe('refreshing');
  });

  test('nested thesis page wins over the list scroller', () => {
    const nodes = [{ hidden: false }, { hidden: false }];
    expect(nestedScrollIndex({
      querySelectorAll(selector) {
        expect(selector).toBe(`[${NESTED_SCROLL_ATTR}]`);
        return nodes;
      },
    })).toBe(1);
    expect(nestedScrollIndex({
      querySelectorAll() {
        return [{ hidden: false }, { hidden: true }];
      },
    })).toBe(0);
    expect(nestedScrollIndex({
      querySelectorAll() {
        return [];
      },
    })).toBe(-1);
    expect(nestedScrollIndex(null)).toBe(-1);
    expect(paneScrollTop(undefined)).toBe(0);
    expect(paneScrollTop(-4)).toBe(0);
    expect(paneScrollTop(32)).toBe(32);
  });
});
