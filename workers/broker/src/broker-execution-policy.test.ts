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

  test('no fixed reduce band: any partial reduction below a full exit is allowed; a reduce cannot be a full exit', () => {
    expect(validateBrokerExecutionPolicy({ ...base, side: 'sell', positionAction: 'reduce', quantity: 9 }, snapshot)).toBe(9);
    expect(validateBrokerExecutionPolicy({ ...base, side: 'sell', positionAction: 'reduce', quantity: 1 }, snapshot)).toBe(1);
    expect(() => validateBrokerExecutionPolicy({ ...base, side: 'sell', positionAction: 'reduce', quantity: 10 }, snapshot)).toThrow('full exit');
    expect(() => validateBrokerExecutionPolicy({ ...base, side: 'sell', positionAction: 'reduce', quantity: 11 }, snapshot)).toThrow('available shares');
  });

  test('no averaging-down ban: an add below cost passes; the price must still be valid', () => {
    const buySnapshot = {
      ...snapshot,
      todayAgenticOrderCount: 0,
      positions: [{ symbol: 'ABCD', quantity: 2, sharesAvailableForSells: 2, averageBuyPrice: 100 }],
    };
    expect(validateBrokerExecutionPolicy(
      { ...base, side: 'buy', positionAction: 'add', dollarAmount: 100 }, buySnapshot, 99,
    )).toBe(100);
    expect(() => validateBrokerExecutionPolicy(
      { ...base, side: 'buy', positionAction: 'add', dollarAmount: 100 }, buySnapshot, 0,
    )).toThrow('valid order price');
  });

  test('rejects a same-symbol pending order', () => {
    expect(() => validateBrokerExecutionPolicy(
      { ...base, side: 'sell', positionAction: 'exit', quantity: 10 }, { ...snapshot, pendingOrderSymbols: ['ABCD'] },
    )).toThrow('pending');
  });

  const fresh = { ...snapshot, todayAgenticOrderCount: 0, todayAgenticOrderNotional: 0, positions: [] };
  const modern = { ...base, maxTradePercent: undefined, maxDailyNotionalPercent: undefined, maxTradesPerDay: undefined, maxSpreadBps: undefined };

  test('no % rail: a results-driven open far above the old 5% / 20% caps passes when cash covers it', () => {
    expect(validateBrokerExecutionPolicy({ ...modern, symbol: 'WXYZ', side: 'buy', positionAction: 'open', dollarAmount: 6_000 }, fresh))
      .toBe(6_000);
    // Legacy fields from an older orchestrator are ignored rather than enforced.
    expect(validateBrokerExecutionPolicy({ ...base, symbol: 'WXYZ', side: 'buy', positionAction: 'open', dollarAmount: 6_000 }, fresh))
      .toBe(6_000);
  });

  test('mechanical limits only: buying power, no margin, positive size; no daily trade count', () => {
    const open = { ...modern, symbol: 'WXYZ', side: 'buy' as const, positionAction: 'open' as const };
    expect(() => validateBrokerExecutionPolicy({ ...open, dollarAmount: 9_000.01 }, fresh)).toThrow('buying power');
    const marginAccount = { ...fresh, cash: 1_000, buyingPower: 9_000 };
    expect(() => validateBrokerExecutionPolicy({ ...open, dollarAmount: 1_000.01 }, marginAccount)).toThrow('margin');
    expect(validateBrokerExecutionPolicy({ ...open, dollarAmount: 1_000 }, marginAccount)).toBe(1_000);
    expect(validateBrokerExecutionPolicy({ ...open, dollarAmount: 100 }, { ...fresh, todayAgenticOrderCount: 12 })).toBe(100);
    expect(validateBrokerExecutionPolicy({ ...base, symbol: 'WXYZ', side: 'buy', positionAction: 'open', dollarAmount: 100 },
      { ...fresh, todayAgenticOrderCount: 12 })).toBe(100);
    expect(() => validateBrokerExecutionPolicy({ ...open, dollarAmount: 0 }, fresh)).toThrow('positive');
  });

  test('large existing position: adds are not capped by position size; sells still allowed', () => {
    const large = {
      ...fresh,
      positions: [{ symbol: 'ABCD', quantity: 50, sharesAvailableForSells: 50, averageBuyPrice: 90 }],
    };
    expect(validateBrokerExecutionPolicy({ ...modern, side: 'buy', positionAction: 'add', dollarAmount: 100 }, large, 100)).toBe(100);
    expect(validateBrokerExecutionPolicy({ ...modern, side: 'sell', positionAction: 'exit', quantity: 50 }, large)).toBe(50);
    expect(validateBrokerExecutionPolicy({ ...modern, side: 'sell', positionAction: 'reduce', quantity: 20 }, large)).toBe(20);
  });
});
