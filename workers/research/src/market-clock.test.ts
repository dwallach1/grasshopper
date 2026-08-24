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

  test('rejects weekends even when a slot is forced', () => {
    expect(marketGate(Date.parse('2026-08-22T14:05:00Z'), 'manual')).toMatchObject({
      weekday: 'Sat', actionable: false, reason: 'weekend',
    });
  });
});
