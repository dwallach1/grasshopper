import { describe, expect, test } from 'bun:test';

import type { AutonomousEquityIntent, BrokerAccountSnapshot } from '@quantanamo/contracts/broker';
import { validateBrokerExecutionPolicy } from './broker-execution-policy';

const snapshot: BrokerAccountSnapshot = {
  accountKey: 'rh:test', accountLast4: '1234', observedAt: new Date().toISOString(),
  totalValue: 10_000, equityValue: 1_000, cash: 9_000, buyingPower: 9_000,
  positions: [{ symbol: 'ABCD', quantity: 10, sharesAvailableForSells: 10, averageBuyPrice: 100 }],
  todayAgenticOrderCount: 3, todayAgenticOrderNotional: 1_000, pendingOrderSymbols: [],
};
const base: Omit<AutonomousEquityIntent, 'side' | 'positionAction'> = {
  refId: '00000000-0000-4000-8000-000000000000', symbol: 'ABCD', rationaleSha256: 'a'.repeat(64),
  maxTradePercent: 5, maxDailyNotionalPercent: 20, maxTradesPerDay: 3, maxSpreadBps: 80,
};

describe('broker position-action policy', () => {
  test('allows a full protective exit despite exhausted buy quota', () => {
    expect(validateBrokerExecutionPolicy({ ...base, side: 'sell', positionAction: 'exit', quantity: 10 }, snapshot)).toBe(10);
  });

  test('rejects a reduction larger than half the position', () => {
    expect(() => validateBrokerExecutionPolicy({ ...base, side: 'sell', positionAction: 'reduce', quantity: 6 }, snapshot)).toThrow();
  });

  test('rejects averaging down on an add', () => {
    const buySnapshot = {
      ...snapshot,
      todayAgenticOrderCount: 0,
      positions: [{ symbol: 'ABCD', quantity: 2, sharesAvailableForSells: 2, averageBuyPrice: 100 }],
    };
    expect(() => validateBrokerExecutionPolicy(
      { ...base, side: 'buy', positionAction: 'add', dollarAmount: 100 }, buySnapshot, 99,
    )).toThrow('averaging down');
  });

  test('rejects a same-symbol pending order', () => {
    expect(() => validateBrokerExecutionPolicy(
      { ...base, side: 'sell', positionAction: 'exit', quantity: 10 }, { ...snapshot, pendingOrderSymbols: ['ABCD'] },
    )).toThrow('pending');
  });

  const cap20 = { ...base, maxTradePercent: 20 };
  const fresh = { ...snapshot, todayAgenticOrderCount: 0, todayAgenticOrderNotional: 0, positions: [] };

  test('20% single-position cap: an open at 20% passes, above it fails', () => {
    expect(validateBrokerExecutionPolicy({ ...cap20, symbol: 'WXYZ', side: 'buy', positionAction: 'open', dollarAmount: 2_000 }, fresh))
      .toBe(2_000);
    expect(() => validateBrokerExecutionPolicy(
      { ...cap20, symbol: 'WXYZ', side: 'buy', positionAction: 'open', dollarAmount: 2_000.01 }, fresh,
    )).toThrow('per-trade portfolio cap');
  });

  test('grandfathered oversize position: adds rejected, full exit allowed', () => {
    const oversize = {
      ...fresh,
      positions: [{ symbol: 'ABCD', quantity: 50, sharesAvailableForSells: 50, averageBuyPrice: 90 }],
    };
    expect(() => validateBrokerExecutionPolicy(
      { ...cap20, side: 'buy', positionAction: 'add', dollarAmount: 100 }, oversize, 100,
    )).toThrow('total position portfolio cap');
    expect(validateBrokerExecutionPolicy({ ...cap20, side: 'sell', positionAction: 'exit', quantity: 50 }, oversize)).toBe(50);
    expect(validateBrokerExecutionPolicy({ ...cap20, side: 'sell', positionAction: 'reduce', quantity: 20 }, oversize)).toBe(20);
  });
});
