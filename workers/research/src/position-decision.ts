import type { BrokerAccountSnapshot } from '@thesisforge/contracts/broker';

import {
  actionableBrokerEvidence,
  earningsResultRows,
  fundamentalsRow,
  marketRow,
  type DecisionJsonObject,
} from './autonomous-decision';
import {
  asBrokerResearchContext,
  PositionAiOutputSchema,
} from './schemas';

export type ManagedPosition = BrokerAccountSnapshot['positions'][number];

export type PositionThesis = {
  id: string;
  name: string;
  status: string;
  stance: string;
  confidence: number;
  symbols: string[];
  falsifier?: string | null;
};

export type PositionHistory = {
  addsToday: number;
  addsLifetime: number;
  reductionsToday: number;
  lastAddAt: string | null;
};

export type PositionAction = {
  action: 'hold' | 'add' | 'reduce' | 'exit' | 'insufficient_data';
  symbol: string;
  dollarAmount?: number;
  quantity?: number;
  rationale: string;
  evidence: DecisionJsonObject;
};

function boundedSellQuantity(position: ManagedPosition, fraction: number): number {
  const available = Math.min(position.quantity, position.sharesAvailableForSells);
  return Math.floor(available * fraction * 1_000_000) / 1_000_000;
}

function deterministicAdverseEvidence(context: unknown, symbol: string): string[] {
  const researched = asBrokerResearchContext(context);
  const reasons: string[] = [];
  const market = marketRow(researched, symbol);
  const fundamentals = fundamentalsRow(researched, symbol);
  if (market && fundamentals) {
    const last = Number(market.last);
    const previousClose = Number(market.previousClose);
    const open = Number(fundamentals.open);
    const volume = Number(fundamentals.volume);
    const averageVolume = Number(fundamentals.average_volume_2_weeks ?? fundamentals.average_volume);
    const move = previousClose > 0 ? ((last - previousClose) / previousClose) * 100 : NaN;
    if (
      Number.isFinite(move) && move <= -3
      && Number.isFinite(open) && last < open
      && Number.isFinite(volume) && Number.isFinite(averageVolume) && averageVolume > 0
      && volume >= averageVolume * 1.5
    ) reasons.push('negative_price_volume_dislocation');
  }
  for (const row of earningsResultRows(researched, symbol)) {
    if (!row.eps || row.eps.actual == null || row.eps.estimate == null || !row.report) continue;
    const actual = Number(row.eps.actual);
    const estimate = Number(row.eps.estimate);
    const reportAt = Date.parse(`${String(row.report.date || '')}T12:00:00-04:00`);
    if (Number.isFinite(actual) && Number.isFinite(estimate) && actual < estimate
      && Number.isFinite(reportAt) && Math.abs(Date.now() - reportAt) <= 3 * 24 * 60 * 60 * 1_000) {
      reasons.push('recent_negative_earnings_surprise');
      break;
    }
  }
  return reasons;
}

export function decidePositionAction(
  position: ManagedPosition,
  snapshot: BrokerAccountSnapshot,
  theses: PositionThesis[],
  output: unknown,
  brokerContext: unknown,
  history: PositionHistory = { addsToday: 0, addsLifetime: 0, reductionsToday: 0, lastAddAt: null },
): PositionAction {
  const symbol = position.symbol;
  const researched = asBrokerResearchContext(brokerContext);
  const market = marketRow(researched, symbol);
  const quoteAt = market ? Date.parse(String(market.quoteAt || '')) : NaN;
  const last = market ? Number(market.last) : NaN;
  const spreadBps = market ? Number(market.spreadBps) : NaN;
  const snapshotAge = Date.now() - Date.parse(snapshot.observedAt);
  const fresh = Boolean(
    market
    && Number.isFinite(quoteAt)
    && Date.now() - quoteAt <= 120_000
    && market.tradable === true
    && market.state === 'active'
    && Number.isFinite(last)
    && last > 0
    && Number.isFinite(spreadBps)
    && spreadBps <= 80,
  );
  if (!fresh || !Number.isFinite(snapshotAge) || snapshotAge < 0 || snapshotAge > 300_000) {
    return {
      action: 'insufficient_data', symbol, rationale: 'Fresh tradable market context is unavailable.',
      evidence: { quote_fresh: fresh, snapshot_age_ms: snapshotAge },
    };
  }
  if (snapshot.pendingOrderSymbols.includes(symbol)) {
    return {
      action: 'hold', symbol, rationale: 'A same-symbol broker order is already pending.',
      evidence: { pending_order: true },
    };
  }
  if (position.quantity <= 0 || position.sharesAvailableForSells < 0) {
    return {
      action: 'insufficient_data', symbol, rationale: 'Broker position sizing is invalid.',
      evidence: { position_valid: false },
    };
  }

  const parsedOutput = PositionAiOutputSchema.safeParse(output);
  const decision = parsedOutput.success ? parsedOutput.data : {
    position_action: 'hold' as const,
    decision_confidence: 0,
    thesis_state: 'intact' as const,
  };

  const averageCost = Number(position.averageBuyPrice);
  const returnPercent = Number.isFinite(averageCost) && averageCost > 0
    ? ((last - averageCost) / averageCost) * 100
    : null;
  const confidence = Number(decision.decision_confidence);
  const recommendation = decision.position_action;
  const thesisState = decision.thesis_state;
  const riskPass = decision.portfolio_risk_pass === true;
  const commonEvidence: DecisionJsonObject = {
    quote_fresh: true,
    last,
    average_cost: Number.isFinite(averageCost) ? averageCost : null,
    return_percent: returnPercent,
    decision_confidence: confidence,
    thesis_state: thesisState,
    model_recommendation: recommendation,
  };
  const adverseReasons = deterministicAdverseEvidence(researched, symbol);
  const hasStructuredFalsifier = theses.some((thesis) =>
    thesis.symbols.includes(symbol) && (thesis.falsifier?.trim().length ?? 0) >= 20);

  if (returnPercent !== null && returnPercent <= -8) {
    const quantity = boundedSellQuantity(position, 1);
    if (quantity > 0) return {
      action: 'exit', symbol, quantity,
      rationale: `Position breached the -8% hard loss limit (${returnPercent.toFixed(2)}%).`,
      evidence: { ...commonEvidence, trigger: 'hard_loss_limit' },
    };
  }

  if (
    recommendation === 'exit'
    && confidence >= 90
    && thesisState === 'invalidated'
    && adverseReasons.length > 0
    && hasStructuredFalsifier
  ) {
    const quantity = boundedSellQuantity(position, 1);
    if (quantity > 0) return {
      action: 'exit', symbol, quantity,
      rationale: `Validated thesis invalidation: ${String(decision.summary || '').slice(0, 1200)}`,
      evidence: { ...commonEvidence, trigger: 'validated_thesis_invalidation', adverse_reasons: adverseReasons },
    };
  }

  if (
    recommendation === 'reduce'
    && confidence >= 88
    && thesisState !== 'intact'
    && adverseReasons.length > 0
    && history.reductionsToday === 0
  ) {
    const requestedPercent = Number(decision.reduce_percent);
    const reducePercent = Math.min(50, Math.max(25, Number.isFinite(requestedPercent) ? requestedPercent : 25));
    const quantity = boundedSellQuantity(position, reducePercent / 100);
    if (quantity > 0) return {
      action: 'reduce', symbol, quantity,
      rationale: `Evidence-backed ${reducePercent}% risk reduction: ${String(decision.summary || '').slice(0, 1200)}`,
      evidence: { ...commonEvidence, trigger: 'adverse_evidence', adverse_reasons: adverseReasons, reduce_percent: reducePercent },
    };
  }

  const supportingThesis = theses.find((thesis) =>
    thesis.symbols.includes(symbol)
    && thesis.status === 'hardening' && thesis.stance === 'bullish' && thesis.confidence >= 80);
  const lastAddAge = history.lastAddAt ? Date.now() - Date.parse(history.lastAddAt) : Number.POSITIVE_INFINITY;
  if (
    recommendation === 'add'
    && confidence >= 90
    && thesisState === 'intact'
    && riskPass
    && decision.bull_case_pass === true
    && decision.bear_case_answered === true
    && supportingThesis
    && last >= averageCost
    && history.addsToday === 0
    && history.addsLifetime < 2
    && lastAddAge >= 24 * 60 * 60 * 1_000
    && history.reductionsToday === 0
  ) {
    const evidence = actionableBrokerEvidence(researched, symbol);
    const requestedPercent = Number(decision.add_percent);
    const currentNotional = position.quantity * last;
    const remainingCapacity = Math.max(0, snapshot.totalValue * 0.05 - currentNotional);
    const dollarAmount = Math.floor(Math.min(
      snapshot.totalValue * Math.min(2, Math.max(1, requestedPercent)) / 100,
      remainingCapacity,
      snapshot.buyingPower,
    ) * 100) / 100;
    if (evidence.pass && dollarAmount >= 25) return {
      action: 'add', symbol, dollarAmount,
      rationale: `Evidence-backed add to ${supportingThesis.name}: ${String(decision.summary || '').slice(0, 1200)}`,
      evidence: {
        ...commonEvidence,
        trigger: 'hardening_thesis_add',
        thesis_id: supportingThesis.id,
        broker_evidence: evidence.reasons,
        post_trade_position_cap_percent: 5,
      },
    };
  }

  return {
    action: 'hold', symbol, rationale: String(decision.summary || 'No position action passed deterministic gates.').slice(0, 1200),
    evidence: commonEvidence,
  };
}
