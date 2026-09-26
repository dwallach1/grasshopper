import { describe, expect, test } from 'bun:test';

import type { BrokerAccountSnapshot } from '@quantanamo/contracts/broker';
import { actionableBrokerEvidence, approvedCandidate } from './autonomous-decision';

const thesisTask = {
  kind: 'thesis_research' as const,
  runId: 'run-1',
  idempotencyKey: 'run-1:thesis:neocloud',
  contextVersion: 'v1',
  marketSlot: 'midday',
  thesis: {
    id: 'neocloud',
    name: 'Neocloud',
    summary: 'Capacity expansion with improving economics.',
    status: 'hardening',
    confidence: 85,
    stance: 'bullish',
    symbols: ['ABCD'],
    size_multiplier: 1,
    sizing_basis: 'half_kelly',
  },
};

function context(quoteAt = new Date().toISOString()) {
  const reportDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return {
    market: {
      symbols: [{
        symbol: 'ABCD', tradable: true, state: 'active', bid: 99.9, ask: 100,
        last: 100, previousClose: 98, quoteAt, spreadBps: 10,
      }],
    },
    fundamentals: { results: [{ symbol: 'ABCD', volume: '1000', average_volume_2_weeks: '900', open: '99' }] },
    earnings: [{
      symbol: 'ABCD',
      data: { results: [{ report: { date: reportDate }, eps: { actual: '1.10', estimate: '1.00' } }] },
    }],
  };
}

const snapshot: BrokerAccountSnapshot = {
  accountKey: 'rh:test',
  accountLast4: '1234',
  observedAt: new Date().toISOString(),
  totalValue: 10_000,
  equityValue: 0,
  cash: 10_000,
  buyingPower: 10_000,
  positions: [],
  todayAgenticOrderCount: 0,
  todayAgenticOrderNotional: 0,
  pendingOrderSymbols: [],
};

const modelDecision = {
  material_change: true,
  trade_decision: 'buy',
  symbol: 'ABCD',
  notional_percent: 5,
  decision_confidence: 90,
  catalyst: 'Fresh reported earnings exceeded expectations with a constructive setup.',
  invalidation: 'Exit if the post-report move fails and price loses the defined support level.',
  bull_case_pass: true,
  bear_case_answered: true,
  portfolio_risk_pass: true,
  summary: 'A bounded post-earnings entry passed the independent gates.',
};

describe('autonomous decision gates', () => {
  test('allows a bounded candidate only with fresh deterministic evidence', () => {
    const candidate = approvedCandidate(thesisTask, modelDecision, context(), snapshot);
    expect(candidate?.notional).toBe(500);
    expect(candidate?.symbol).toBe('ABCD');
  });

  test('a wide spread is guidance, not a block', () => {
    const wide = context();
    wide.market.symbols[0]!.spreadBps = 350;
    expect(actionableBrokerEvidence(wide, 'ABCD').pass).toBe(true);
    expect(approvedCandidate(thesisTask, modelDecision, wide, snapshot)?.notional).toBe(500);
  });

  test('a sub-1% request is sized, not rejected (no minimum request %)', () => {
    expect(approvedCandidate(thesisTask, { ...modelDecision, notional_percent: 0.5 }, context(), snapshot)?.notional).toBe(50);
  });

  test('rejects stale broker evidence', () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(actionableBrokerEvidence(context(stale), 'ABCD').pass).toBe(false);
    expect(approvedCandidate(thesisTask, modelDecision, context(stale), snapshot)).toBeNull();
  });

  test('rejects adding to an existing position in the launch policy', () => {
    const withPosition = { ...snapshot, positions: [{
      symbol: 'ABCD', quantity: 1, sharesAvailableForSells: 1, averageBuyPrice: 90,
    }] };
    expect(approvedCandidate(thesisTask, modelDecision, context(), withPosition)).toBeNull();
  });

  test('rejects an LLM recommendation that lacks all panel gates', () => {
    expect(approvedCandidate(
      thesisTask,
      { ...modelDecision, portfolio_risk_pass: false },
      context(),
      snapshot,
    )).toBeNull();
  });

  test('size follows results: requested percent x outcome multiplier', () => {
    const half = { ...thesisTask, thesis: { ...thesisTask.thesis, size_multiplier: 0.5 } };
    const candidate = approvedCandidate(half, modelDecision, context(), snapshot);
    expect(candidate?.notional).toBe(250);
    expect(candidate?.evidence.size_multiplier).toBe(0.5);
    expect(candidate?.evidence.sizing).toBe('requested_percent_x_outcome_multiplier');
  });

  test('no per-position cap: a large results-driven request passes; only > 100% of book is invalid', () => {
    const big = approvedCandidate(thesisTask, { ...modelDecision, notional_percent: 40 }, context(), snapshot);
    expect(big?.notional).toBe(4_000);
    expect(approvedCandidate(thesisTask, { ...modelDecision, notional_percent: 101 }, context(), snapshot)).toBeNull();
  });

  test('spendable cash (no margin) still bounds the size', () => {
    const thin = { ...snapshot, buyingPower: 487.76, cash: 487.76 };
    expect(approvedCandidate(thesisTask, { ...modelDecision, notional_percent: 20 }, context(), thin)?.notional).toBe(487.76);
  });

  test('missing or out-of-range multiplier fails closed', () => {
    for (const size_multiplier of [null, undefined, 0, 0.1, 1.5]) {
      const task = { ...thesisTask, thesis: { ...thesisTask.thesis, size_multiplier } };
      expect(approvedCandidate(task, modelDecision, context(), snapshot)).toBeNull();
    }
  });

  test('a re-scored thesis below 80 loses autonomous buys until it re-earns them', () => {
    const rescored = { ...thesisTask, thesis: { ...thesisTask.thesis, confidence: 72 } };
    expect(approvedCandidate(rescored, modelDecision, context(), snapshot)).toBeNull();
  });
});
