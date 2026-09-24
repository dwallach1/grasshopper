import { describe, expect, test } from 'bun:test';

import {
  clampDeckIndex,
  deckIndexFromThumb,
  deckShiftFromAxes,
  deckShiftFromDrag,
  deckThumbRatio,
  stepDeckIndex,
} from './steward-deck';

describe('steward card deck index', () => {
  test('clamps to the roster and treats an empty deck as 0', () => {
    expect(clampDeckIndex(-2, 3)).toBe(0);
    expect(clampDeckIndex(1, 3)).toBe(1);
    expect(clampDeckIndex(9, 3)).toBe(2);
    expect(clampDeckIndex(0, 0)).toBe(0);
  });

  test('thumb offset maps across the rail without wrapping', () => {
    expect(deckIndexFromThumb(0, 100, 3)).toBe(0);
    expect(deckIndexFromThumb(50, 100, 3)).toBe(1);
    expect(deckIndexFromThumb(100, 100, 3)).toBe(2);
    expect(deckIndexFromThumb(-10, 100, 3)).toBe(0);
    expect(deckIndexFromThumb(140, 100, 3)).toBe(2);
    expect(deckIndexFromThumb(50, 0, 3)).toBe(0);
    expect(deckIndexFromThumb(50, 100, 1)).toBe(0);
  });

  test('thumb ratio sits at the ends for a two-card deck', () => {
    expect(deckThumbRatio(0, 3)).toBe(0);
    expect(deckThumbRatio(1, 3)).toBe(0.5);
    expect(deckThumbRatio(2, 3)).toBe(1);
    expect(deckThumbRatio(0, 1)).toBe(0);
  });

  test('chevrons step one card and stop at the ends', () => {
    expect(stepDeckIndex(0, -1, 3)).toBe(0);
    expect(stepDeckIndex(0, 1, 3)).toBe(1);
    expect(stepDeckIndex(2, 1, 3)).toBe(2);
  });

  test('the card handle steps one steward per threshold, not a tab swipe', () => {
    expect(deckShiftFromDrag(-47)).toBe(0);
    expect(deckShiftFromDrag(-48)).toBe(1);
    expect(deckShiftFromDrag(48)).toBe(-1);
    expect(deckShiftFromDrag(-96)).toBe(2);
    expect(deckShiftFromDrag(20, 0)).toBe(0);
    expect(deckShiftFromDrag(Number.NaN)).toBe(0);
    expect(stepDeckIndex(0, deckShiftFromDrag(-48), 3)).toBe(1);
    expect(stepDeckIndex(0, deckShiftFromDrag(80), 3)).toBe(0);
  });

  test('vertical handle drag steps the deck and a diagonal keeps the stronger axis', () => {
    expect(deckShiftFromAxes(-48, 4)).toBe(1);
    expect(deckShiftFromAxes(4, -48)).toBe(1);
    expect(deckShiftFromAxes(4, 48)).toBe(-1);
    expect(deckShiftFromAxes(0, 0)).toBe(0);
    expect(deckShiftFromAxes(Number.NaN, -48)).toBe(0);
    expect(stepDeckIndex(1, deckShiftFromAxes(0, -48), 3)).toBe(2);
    expect(stepDeckIndex(1, deckShiftFromAxes(0, 48), 3)).toBe(0);
  });
});
