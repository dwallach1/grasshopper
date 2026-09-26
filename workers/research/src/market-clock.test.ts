import { describe, expect, test } from 'bun:test';

import { marketGate } from './market-clock';

describe('New York research schedule gate', () => {
  test('accepts the summer UTC candidate at 10:05 EDT', () => {
    expect(marketGate(Date.parse('2026-08-24T14:05:00Z'))).toMatchObject({
      time: '10:05', slot: 'morning', actionable: true,
    });
  });

  test('rejects the winter-only UTC candidate during summer', () => {
    expect(marketGate(Date.parse('2026-08-24T15:05:00Z'))).toMatchObject({
      time: '11:05', slot: null, actionable: false,
    });
  });

  test('accepts the winter UTC candidate at 10:05 EST', () => {
    expect(marketGate(Date.parse('2026-12-07T15:05:00Z'))).toMatchObject({
      time: '10:05', slot: 'morning', actionable: true,
    });
  });

  test('accepts the summer pre-close window at 15:05 EDT', () => {
    expect(marketGate(Date.parse('2026-08-24T19:05:00Z'))).toMatchObject({
      time: '15:05', slot: 'pre_close', actionable: true,
    });
  });

  test('does not admit the retired midday window', () => {
    expect(marketGate(Date.parse('2026-08-24T17:05:00Z'))).toMatchObject({
      time: '13:05', slot: null, actionable: false,
    });
  });

  test('rejects weekends even when a slot is forced', () => {
    expect(marketGate(Date.parse('2026-08-22T14:05:00Z'), 'manual')).toMatchObject({
      weekday: 'Sat', actionable: false, reason: 'weekend',
    });
  });
});

describe('NYSE holidays and early closes', () => {
  test('a scheduled slot on an exchange holiday is not actionable', () => {
    expect(marketGate(Date.parse('2026-11-26T15:05:00Z'))).toMatchObject({
      time: '10:05', slot: 'morning', actionable: false, reason: 'market_holiday',
    });
  });

  test('the 15:05 pre-close slot after a 13:00 early close is not actionable; 10:05 still is', () => {
    expect(marketGate(Date.parse('2026-11-27T20:05:00Z'))).toMatchObject({
      time: '15:05', actionable: false, reason: 'market_early_close',
    });
    expect(marketGate(Date.parse('2026-11-27T15:05:00Z'))).toMatchObject({ time: '10:05', actionable: true });
  });
});
