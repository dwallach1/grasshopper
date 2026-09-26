import { describe, expect, test } from 'bun:test';

import type { BrokerAccountSnapshot } from '@quantanamo/contracts/broker';
import { decidePositionAction } from './position-decision';
import { lotInvalidationFromEpisode } from './schemas';

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
  size_multiplier: 1,
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
  test('no global stop: a -9% position with no thesis invalidation holds', () => {
    const result = decidePositionAction(basePosition, snapshot, thesis, {}, context(91));
    expect(result.action).toBe('hold');
  });

  test('exit reads the linked thesis falsifier', () => {
    const invalidated = {
      position_action: 'exit', decision_confidence: 92, thesis_state: 'invalidated',
      invalidation_confirmed: true, summary: 'Demand reversal documented in the print.',
    };
    const result = decidePositionAction(basePosition, snapshot, thesis, invalidated, context(95, 100, 97));
    expect(result.action).toBe('exit');
    expect(result.quantity).toBe(10);
    expect(result.evidence.thesis_id).toBe('t1');
    expect(String(result.evidence.thesis_falsifier)).toContain('demand reversal');
    const noFalsifier = [{ ...thesis[0]!, falsifier: null }];
    const held = decidePositionAction(basePosition, snapshot, noFalsifier, invalidated, context(95, 100, 97));
    expect(held.action).toBe('hold');
    expect(held.evidence.exit_source).toBe('steward_judgment');
  });

  test('lot invalidation price is read first: hit exits, not hit holds', () => {
    const history = { addsToday: 0, addsLifetime: 0, reductionsToday: 0, lastAddAt: null };
    const lot = { price: 96, note: 'Loses the post-earnings gap.' };
    // The model says hold, but the steward's own lot price is hit.
    const hit = decidePositionAction(basePosition, snapshot, thesis, {}, context(95.5), history, lot);
    expect(hit.action).toBe('exit');
    expect(hit.quantity).toBe(10);
    expect(hit.evidence.trigger).toBe('lot_invalidation_price');
    expect(hit.evidence.invalidation_source).toBe('lot');
    expect(hit.evidence.lot_invalidation_price).toBe(96);
    const notHit = decidePositionAction(basePosition, snapshot, thesis, {}, context(97), history, lot);
    expect(notHit.action).toBe('hold');
    // No lot price and no linked falsifier: an exit call stays the steward's judgment.
    const invalidated = {
      position_action: 'exit', decision_confidence: 92, thesis_state: 'invalidated', summary: 'Gap lost.',
    };
    const noFalsifier = [{ ...thesis[0]!, falsifier: null }];
    const priceOnly = decidePositionAction(
      basePosition, snapshot, noFalsifier, invalidated, context(97, 101, 99), history, { price: 90, note: null },
    );
    expect(priceOnly.action).toBe('hold');
    expect(priceOnly.evidence.exit_source).toBe('lot_invalidation_price_not_hit');
  });

  test('lot invalidation note comes before the thesis falsifier', () => {
    const history = { addsToday: 0, addsLifetime: 0, reductionsToday: 0, lastAddAt: null };
    const invalidated = {
      position_action: 'exit', decision_confidence: 92, thesis_state: 'invalidated', summary: 'Gap lost.',
    };
    const noFalsifier = [{ ...thesis[0]!, falsifier: null }];
    const result = decidePositionAction(
      basePosition, snapshot, noFalsifier, invalidated, context(95, 100, 97), history,
      { price: null, note: 'Lot is wrong if the gap fills on volume.' },
    );
    expect(result.action).toBe('exit');
    expect(result.evidence.trigger).toBe('validated_lot_invalidation');
    expect(result.evidence.invalidation_source).toBe('lot');
    // A lot note still needs model confirmation and adverse evidence.
    const unconfirmed = decidePositionAction(
      basePosition, snapshot, noFalsifier, { ...invalidated, decision_confidence: 70 }, context(95, 100, 97), history,
      { price: null, note: 'Lot is wrong if the gap fills on volume.' },
    );
    expect(unconfirmed.action).toBe('hold');
  });

  test('reduces only with high-confidence adverse evidence', () => {
    const result = decidePositionAction(basePosition, snapshot, thesis, {
      position_action: 'reduce', decision_confidence: 90, thesis_state: 'weakening',
      reduce_percent: 40, summary: 'The catalyst weakened.',
    }, context(96, 100, 98));
    expect(result.action).toBe('reduce');
    expect(result.quantity).toBe(4);
  });

  test('adds at full multiplier', () => {
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

  test('no averaging-down ban: an add below cost is results-sized like any other add', () => {
    const result = decidePositionAction(basePosition, snapshot, thesis, {
      position_action: 'add', decision_confidence: 95, thesis_state: 'intact', add_percent: 2,
      portfolio_risk_pass: true, bull_case_pass: true, bear_case_answered: true,
    }, context(99, 96, 97));
    expect(result.action).toBe('add');
    expect(result.dollarAmount).toBe(200);
  });

  test('blocks churn while a same-symbol order is pending', () => {
    const result = decidePositionAction(basePosition, { ...snapshot, pendingOrderSymbols: ['ABCD'] }, thesis, {}, context());
    expect(result.action).toBe('hold');
  });

  test('no add count, spacing or fixed add %: a 6% add after a same-day reduction is results-sized', () => {
    const smaller = { ...basePosition, quantity: 2 };
    const result = decidePositionAction(smaller, { ...snapshot, positions: [smaller] }, thesis, {
      position_action: 'add', decision_confidence: 95, thesis_state: 'intact', add_percent: 6,
      portfolio_risk_pass: true, bull_case_pass: true, bear_case_answered: true,
    }, context(), { addsToday: 3, addsLifetime: 5, reductionsToday: 1, lastAddAt: new Date().toISOString() });
    expect(result.action).toBe('add');
    expect(result.dollarAmount).toBe(600);
  });

  test('no fixed reduce band: the requested partial % is used; 0 or 100 is not a reduce', () => {
    const decision = {
      position_action: 'reduce', decision_confidence: 90, thesis_state: 'weakening', summary: 'The catalyst weakened.',
    };
    expect(decidePositionAction(basePosition, snapshot, thesis, { ...decision, reduce_percent: 80 }, context(96, 100, 98)).quantity).toBe(8);
    expect(decidePositionAction(basePosition, snapshot, thesis, { ...decision, reduce_percent: 10 }, context(96, 100, 98)).quantity).toBe(1);
    expect(decidePositionAction(basePosition, snapshot, thesis, { ...decision, reduce_percent: 100 }, context(96, 100, 98)).action).toBe('hold');
  });

  test('a wide spread is not a block', () => {
    const wide = context();
    wide.market.symbols[0]!.spreadBps = 400;
    const smaller = { ...basePosition, quantity: 2 };
    const result = decidePositionAction(smaller, { ...snapshot, positions: [smaller] }, thesis, {
      position_action: 'add', decision_confidence: 95, thesis_state: 'intact', add_percent: 2,
      portfolio_risk_pass: true, bull_case_pass: true, bear_case_answered: true,
    }, wide);
    expect(result.action).toBe('add');
  });

  const addDecision = {
    position_action: 'add', decision_confidence: 95, thesis_state: 'intact', add_percent: 2,
    portfolio_risk_pass: true, bull_case_pass: true, bear_case_answered: true,
    summary: 'Fresh evidence strengthens the existing position.',
  };

  test('add size follows the outcome multiplier', () => {
    const smaller = { ...basePosition, quantity: 2 };
    const half = [{ ...thesis[0]!, size_multiplier: 0.5 }];
    const result = decidePositionAction(smaller, { ...snapshot, positions: [smaller] }, half, addDecision, context());
    expect(result.action).toBe('add');
    expect(result.dollarAmount).toBe(100);
    expect(result.evidence?.size_multiplier).toBe(0.5);
  });

  test('no position cap: a large position can still add at the results-driven size', () => {
    const large = { ...basePosition, quantity: 48, sharesAvailableForSells: 48 }; // ~50% of book
    const result = decidePositionAction(large, { ...snapshot, positions: [large] }, thesis, addDecision, context());
    expect(result.action).toBe('add');
    expect(result.dollarAmount).toBe(200);
  });

  test('add is limited only by spendable cash', () => {
    const smaller = { ...basePosition, quantity: 2 };
    const poor = { ...snapshot, cash: 57.5, buyingPower: 57.5, positions: [smaller] };
    const result = decidePositionAction(smaller, poor, thesis, addDecision, context());
    expect(result.action).toBe('add');
    expect(result.dollarAmount).toBe(57.5);
  });

  test('no global stop on a large position either', () => {
    const large = { ...basePosition, quantity: 48, sharesAvailableForSells: 48 };
    const result = decidePositionAction(large, { ...snapshot, positions: [large] }, thesis, {}, context(85));
    expect(result.action).toBe('hold');
  });

  test('missing outcome multiplier fails closed on adds', () => {
    const smaller = { ...basePosition, quantity: 2 };
    const unsized = [{ ...thesis[0]!, size_multiplier: null }];
    const result = decidePositionAction(smaller, { ...snapshot, positions: [smaller] }, unsized, addDecision, context());
    expect(result.action).toBe('hold');
  });
});

describe('lotInvalidationFromEpisode', () => {
  test('reads position_episodes.invalidation_price and invalidation_note', () => {
    expect(lotInvalidationFromEpisode({ invalidation_price: '12.50', invalidation_note: ' gap fills ' }))
      .toEqual({ price: 12.5, note: 'gap fills' });
    expect(lotInvalidationFromEpisode({ invalidation_price: null, invalidation_note: '' })).toBeNull();
    expect(lotInvalidationFromEpisode({ invalidation_price: 0, invalidation_note: null })).toBeNull();
    expect(lotInvalidationFromEpisode({})).toBeNull();
  });
});
