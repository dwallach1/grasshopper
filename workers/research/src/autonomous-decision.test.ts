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
});
