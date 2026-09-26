import { describe, expect, test } from 'bun:test';

import {
  halfKellyMultiplier,
  outcomePosteriorConfidence,
  sizeBuyNotional,
  spendableCash,
} from './sizing';

describe('outcome re-score (mirror of private.outcome_posterior_confidence)', () => {
  test('matches the 2026-09-26 prod re-score', () => {
    // [stated, trades, wins, realized] -> new confidence
    expect(outcomePosteriorConfidence(91, 4, 1, 22.82).confidence).toBe(72); // earnings_gap_structure
    expect(outcomePosteriorConfidence(80, 4, 2, 57.39).confidence).toBe(71); // weather_same_day_high
    expect(outcomePosteriorConfidence(55, 1, 0, -18.82).confidence).toBe(50);
    expect(outcomePosteriorConfidence(40, 1, 0, -0.0097).confidence).toBe(36);
    expect(outcomePosteriorConfidence(15, 1, 0, -200).confidence).toBe(14);
  });

  test('n >= 5 with negative P/L caps at 60 and demotes', () => {
    expect(outcomePosteriorConfidence(91, 6, 2, -100)).toEqual({ confidence: 60, capped: true, demote: true });
    expect(outcomePosteriorConfidence(40, 6, 1, -100)).toEqual({ confidence: 31, capped: false, demote: true });
    expect(outcomePosteriorConfidence(91, 6, 2, 100).demote).toBe(false);
  });

  test('no trades leaves the stated confidence', () => {
    expect(outcomePosteriorConfidence(85, 0, 0, 0).confidence).toBe(85);
  });
});

describe('half-Kelly multiplier (mirror of private.half_kelly_multiplier)', () => {
  test('thin samples get 0.5, never 1.0', () => {
    expect(halfKellyMultiplier(4, 4, 100, null)).toBe(0.5);
    expect(halfKellyMultiplier(0, 0, null, null)).toBe(0.5);
  });

  test('no edge floors at 0.25 (BANDIT today: 34 trades, 17 wins, 0.1328 vs 0.1358)', () => {
    expect(halfKellyMultiplier(34, 17, 0.1328, 0.1358)).toBe(0.25);
    expect(halfKellyMultiplier(10, 0, null, 50)).toBe(0.25);
  });

  test('scales half-Kelly against the 20% reference, clamped to 1.0', () => {
    expect(halfKellyMultiplier(10, 6, 100, 100)).toBe(0.5); // f* 0.2 -> half 0.1 -> 0.1 / 0.2
    expect(halfKellyMultiplier(10, 7, 100, 50)).toBe(1); // f* 0.55 -> clamp
    expect(halfKellyMultiplier(10, 10, 100, null)).toBe(1); // no losses
  });
});

describe('edge-scaled max stake bounds every buy', () => {
  test('size = min(requested x multiplier, max stake, cash); missing max stake = no buy', () => {
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 20, multiplier: 1, maxStake: 250 })).toBe(250);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 1, multiplier: 1, maxStake: 250 })).toBe(100);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 20, multiplier: 1, maxStake: null })).toBe(0);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 20, multiplier: 1, maxStake: 0 })).toBe(0);
  });
});

describe('no hard cap per position: requested x multiplier, then spendable cash', () => {
  test('entry size = requested % of book x multiplier, no % rail', () => {
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 20, multiplier: 0.5, maxStake: 1_000_000 })).toBe(1_000);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 60, multiplier: 1, maxStake: 1_000_000 })).toBe(6_000);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 100, multiplier: 0.25, maxStake: 1_000_000 })).toBe(2_500);
  });

  test('only mechanical limits: spendable cash (no margin), valid inputs', () => {
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 400, requestedPercent: 20, multiplier: 1, maxStake: 1_000_000 })).toBe(400);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 9_000, cash: 1_000, requestedPercent: 50, multiplier: 1, maxStake: 1_000_000 })).toBe(1_000);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 10, multiplier: 0, maxStake: 1_000_000 })).toBe(0);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 101, multiplier: 1, maxStake: 1_000_000 })).toBe(0);
    expect(sizeBuyNotional({ totalValue: 0, buyingPower: 10_000, requestedPercent: 10, multiplier: 1, maxStake: 1_000_000 })).toBe(0);
    expect(spendableCash(9_000, 1_000)).toBe(1_000);
    expect(spendableCash(500)).toBe(500);
    expect(spendableCash(500, -20)).toBe(0);
  });

  test('QUANTANAMO at the 2026-09-26 NAV: thin thesis 0.5 x request, bounded by $487.76 cash', () => {
    const nav = { totalValue: 5_500.65, buyingPower: 487.76, cash: 487.76, multiplier: 0.5 };
    expect(sizeBuyNotional({ ...nav, requestedPercent: 5, maxStake: 1_000_000 })).toBe(137.51);
    expect(sizeBuyNotional({ ...nav, requestedPercent: 10, maxStake: 1_000_000 })).toBe(275.03);
    expect(sizeBuyNotional({ ...nav, requestedPercent: 20, maxStake: 1_000_000 })).toBe(487.76);
  });
});
