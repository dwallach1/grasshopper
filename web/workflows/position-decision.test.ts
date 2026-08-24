import { describe, expect, test } from 'bun:test';

import type { BrokerAccountSnapshot } from './broker-contract';
import { decidePositionAction } from './position-decision';

const now = new Date().toISOString();
const basePosition = { symbol: 'ABCD', quantity: 10, sharesAvailableForSells: 10, averageBuyPrice: 100 };
const snapshot: BrokerAccountSnapshot = {
  accountKey: 'rh:test', accountLast4: '1234', observedAt: now,
  totalValue: 10_000, equityValue: 1_000, cash: 9_000, buyingPower: 9_000,
  positions: [basePosition], todayAgenticOrderCount: 0, todayAgenticOrderNotional: 0, pendingOrderSymbols: [],
};
const thesis = [{
  id: 't1', name: 'Test thesis', status: 'hardening', stance: 'bullish', confidence: 85, symbols: ['ABCD'],
  falsifier: 'The thesis is invalidated by a documented demand reversal.',
}];

function context(last = 105, previousClose = last - 4, open = last - 2) {
  const reportDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return {
    market: { symbols: [{
      symbol: 'ABCD', tradable: true, state: 'active', bid: last - 0.05, ask: last,
      last, previousClose, quoteAt: new Date().toISOString(), spreadBps: 5,
    }] },
    fundamentals: { results: [{ symbol: 'ABCD', volume: 2000, average_volume_2_weeks: 1000, open }] },
    earnings: [{ symbol: 'ABCD', data: { results: [{ report: { date: reportDate }, eps: { actual: 1 } }] } }],
  };
}

describe('autonomous position decisions', () => {
  test('exits on the deterministic hard loss limit', () => {
    const result = decidePositionAction(basePosition, snapshot, thesis, {}, context(91));
    expect(result.action).toBe('exit');
    expect(result.quantity).toBe(10);
  });

  test('reduces only with high-confidence adverse evidence', () => {
    const result = decidePositionAction(basePosition, snapshot, thesis, {
      position_action: 'reduce', decision_confidence: 90, thesis_state: 'weakening',
      reduce_percent: 40, summary: 'The catalyst weakened.',
    }, context(96, 100, 98));
    expect(result.action).toBe('reduce');
    expect(result.quantity).toBe(4);
  });

  test('adds only within the five-percent total position cap', () => {
    const smaller = { ...basePosition, quantity: 2 };
    const result = decidePositionAction(smaller, { ...snapshot, positions: [smaller] }, thesis, {
      position_action: 'add', decision_confidence: 95, thesis_state: 'intact', add_percent: 2,
      portfolio_risk_pass: true, bull_case_pass: true, bear_case_answered: true,
      summary: 'Fresh evidence strengthens the existing position.',
    }, context());
    expect(result.action).toBe('add');
    expect(result.dollarAmount).toBe(200);
  });

  test('holds when model confidence is too low', () => {
    const result = decidePositionAction(basePosition, snapshot, thesis, {
      position_action: 'exit', decision_confidence: 70, thesis_state: 'invalidated',
      invalidation_confirmed: true,
    }, context());
    expect(result.action).toBe('hold');
  });

  test('does not average down', () => {
    const result = decidePositionAction(basePosition, snapshot, thesis, {
      position_action: 'add', decision_confidence: 95, thesis_state: 'intact', add_percent: 2,
      portfolio_risk_pass: true, bull_case_pass: true, bear_case_answered: true,
    }, context(99, 96, 97));
    expect(result.action).toBe('hold');
  });

  test('blocks churn while a same-symbol order is pending', () => {
    const result = decidePositionAction(basePosition, { ...snapshot, pendingOrderSymbols: ['ABCD'] }, thesis, {}, context());
    expect(result.action).toBe('hold');
  });

  test('blocks an add after a same-day reduction', () => {
    const smaller = { ...basePosition, quantity: 2 };
    const result = decidePositionAction(smaller, { ...snapshot, positions: [smaller] }, thesis, {
      position_action: 'add', decision_confidence: 95, thesis_state: 'intact', add_percent: 2,
      portfolio_risk_pass: true, bull_case_pass: true, bear_case_answered: true,
    }, context(), { addsToday: 0, addsLifetime: 0, reductionsToday: 1, lastAddAt: null });
    expect(result.action).toBe('hold');
  });
});
