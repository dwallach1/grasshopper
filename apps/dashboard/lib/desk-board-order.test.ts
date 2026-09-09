import { describe, expect, test } from 'bun:test';

import {
  applyStandingOrder,
  moveStanding,
  standingShiftFromDrag,
} from './desk-board-order';

describe('board standing order', () => {
  test('keeps a thumb order and appends new rows without dropping scored place', () => {
    const rows = [{ id: 'oddsborne' }, { id: 'quantanamo' }, { id: 'bandit' }];
    expect(applyStandingOrder(rows, ['bandit', 'oddsborne']).map((row) => row.id)).toEqual([
      'bandit',
      'oddsborne',
      'quantanamo',
    ]);
    expect(applyStandingOrder(rows, ['gone', 'quantanamo']).map((row) => row.id)).toEqual([
      'quantanamo',
      'oddsborne',
      'bandit',
    ]);
  });

  test('the rank dragger steps one row per threshold, not a nested swipe', () => {
    expect(moveStanding(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    expect(moveStanding(['a', 'b', 'c'], 'c', -2)).toEqual(['c', 'a', 'b']);
    expect(moveStanding(['a', 'b', 'c'], 'b', 0)).toEqual(['a', 'b', 'c']);
    expect(moveStanding(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(standingShiftFromDrag(47)).toBe(0);
    expect(standingShiftFromDrag(48)).toBe(1);
    expect(standingShiftFromDrag(-96)).toBe(-2);
    expect(standingShiftFromDrag(20, 0)).toBe(0);
  });
});
