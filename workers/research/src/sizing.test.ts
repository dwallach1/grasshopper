import { describe, expect, test } from 'bun:test';

import {
  halfKellyMultiplier,
  outcomePosteriorConfidence,
  positionCapHeadroom,
  sizeBuyNotional,
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

  test('scales half-Kelly against the 20% cap, clamped to 1.0', () => {
    expect(halfKellyMultiplier(10, 6, 100, 100)).toBe(0.5); // f* 0.2 -> half 0.1 -> 0.1 / 0.2
    expect(halfKellyMultiplier(10, 7, 100, 50)).toBe(1); // f* 0.55 -> clamp
    expect(halfKellyMultiplier(10, 10, 100, null)).toBe(1); // no losses
  });
});

describe('20% single-position cap', () => {
  test('grandfathered oversize position has zero headroom', () => {
    expect(positionCapHeadroom(5_500.65, 2_780)).toBe(0); // CODA ~50% of book
    expect(positionCapHeadroom(10_000, 1_500)).toBe(500);
  });

  test('entry size = requested x multiplier, then cap and buying power', () => {
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 20, multiplier: 0.5 })).toBe(1_000);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 30, multiplier: 1 })).toBe(2_000);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 400, requestedPercent: 20, multiplier: 1 })).toBe(400);
    expect(sizeBuyNotional({
      totalValue: 10_000, buyingPower: 10_000, requestedPercent: 10, multiplier: 1, currentPositionValue: 1_900,
    })).toBe(100);
    expect(sizeBuyNotional({ totalValue: 10_000, buyingPower: 10_000, requestedPercent: 10, multiplier: 0 })).toBe(0);
  });
});
