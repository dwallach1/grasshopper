import type { BrokerAccountSnapshot } from '@quantanamo/contracts/broker';

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
import { MIN_ORDER_NOTIONAL, sizeBuyNotional, validMultiplier } from './sizing';
import type { LotInvalidation } from './schemas';

export type ManagedPosition = BrokerAccountSnapshot['positions'][number];

export type PositionThesis = {
  id: string;
  name: string;
  status: string;
  stance: string;
  confidence: number;
  symbols: string[];
  falsifier?: string | null;
  /** Outcome multiplier from public.thesis_sizing() (0.25..1). Missing = no add. */
  size_multiplier?: number | null;
  /** Edge-scaled max stake (USD) from public.thesis_max_stakes(). Missing = no add. */
  max_stake?: number | null;
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
  _history: PositionHistory = { addsToday: 0, addsLifetime: 0, reductionsToday: 0, lastAddAt: null },
  lot: LotInvalidation | null = null,
): PositionAction {
  const symbol = position.symbol;
  const researched = asBrokerResearchContext(brokerContext);
  const market = marketRow(researched, symbol);
  const quoteAt = market ? Date.parse(String(market.quoteAt || '')) : NaN;
  const last = market ? Number(market.last) : NaN;
  const snapshotAge = Date.now() - Date.parse(snapshot.observedAt);
  const fresh = Boolean(
    market
    && Number.isFinite(quoteAt)
    && Date.now() - quoteAt <= 120_000
    && market.tradable === true
    && market.state === 'active'
    && Number.isFinite(last)
    && last > 0,
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
  // No global stop-loss (David, 2026-09-26: "Kill the old rules!"). Exits come from the
  // position's own written invalidation, read in this order:
  //   1. the lot (position_episodes.invalidation_price / invalidation_note, steward-written),
  //   2. the linked thesis (theses.falsifier).
  // With neither, exits are left to the steward's judgment and its learned beliefs.
  const lotPrice = lot && typeof lot.price === 'number' && Number.isFinite(lot.price) && lot.price > 0 ? lot.price : null;
  const lotNote = lot?.note?.trim() ? lot.note.trim() : null;
  const lotEvidence: DecisionJsonObject = {
    lot_invalidation_price: lotPrice,
    lot_invalidation_note: lotNote ? lotNote.slice(0, 500) : null,
  };

  // 1a. The steward's own per-lot price is hit: the lot is invalidated by its own definition.
  if (lotPrice !== null && last <= lotPrice) {
    const quantity = boundedSellQuantity(position, 1);
    if (quantity > 0) return {
      action: 'exit', symbol, quantity,
      rationale: `Lot invalidation price hit: last ${last} <= ${lotPrice}${lotNote ? ` (${lotNote.slice(0, 300)})` : ''}.`,
      evidence: {
        ...commonEvidence,
        ...lotEvidence,
        trigger: 'lot_invalidation_price',
        invalidation_source: 'lot',
      },
    };
  }

  // 1b/2. A written invalidation (lot note first, then the linked thesis falsifier) confirmed by
  // the model (exit, confidence >= 90, thesis invalidated) and deterministic adverse evidence.
  const exitThesis = theses.find((thesis) =>
    thesis.symbols.includes(symbol) && (thesis.falsifier?.trim().length ?? 0) >= 20);
  const invalidationSource: 'lot' | 'thesis' | null = lotNote ? 'lot' : exitThesis ? 'thesis' : null;

  if (
    recommendation === 'exit'
    && confidence >= 90
    && thesisState === 'invalidated'
    && adverseReasons.length > 0
    && invalidationSource
  ) {
    const quantity = boundedSellQuantity(position, 1);
    const label = invalidationSource === 'lot' ? 'lot invalidation' : `thesis invalidation (${exitThesis?.id})`;
    if (quantity > 0) return {
      action: 'exit', symbol, quantity,
      rationale: `Validated ${label}: ${String(decision.summary || '').slice(0, 1200)}`,
      evidence: {
        ...commonEvidence,
        ...lotEvidence,
        trigger: invalidationSource === 'lot' ? 'validated_lot_invalidation' : 'validated_thesis_invalidation',
        invalidation_source: invalidationSource,
        thesis_id: exitThesis?.id ?? null,
        thesis_falsifier: exitThesis ? String(exitThesis.falsifier).slice(0, 500) : null,
        adverse_reasons: adverseReasons,
      },
    };
  }
  if (recommendation === 'exit' && !invalidationSource) {
    return {
      action: 'hold', symbol,
      rationale: lotPrice !== null
        ? `Lot invalidation price ${lotPrice} is not hit (last ${last}) and no written invalidation is confirmed.`
        : 'Neither the lot nor a linked thesis carries a written invalidation; exit is left to the steward.',
      evidence: {
        ...commonEvidence,
        ...lotEvidence,
        exit_source: lotPrice !== null ? 'lot_invalidation_price_not_hit' : 'steward_judgment',
      },
    };
  }

  if (
    recommendation === 'reduce'
    && confidence >= 88
    && thesisState !== 'intact'
    && adverseReasons.length > 0
  ) {
    // No fixed reduce band: the model's reduce % (a partial sell, 0 < % < 100) is used as-is.
    const reducePercent = Number(decision.reduce_percent);
    const quantity = Number.isFinite(reducePercent) && reducePercent > 0 && reducePercent < 100
      ? boundedSellQuantity(position, reducePercent / 100)
      : 0;
    if (quantity > 0) return {
      action: 'reduce', symbol, quantity,
      rationale: `Evidence-backed ${reducePercent}% risk reduction: ${String(decision.summary || '').slice(0, 1200)}`,
      evidence: { ...commonEvidence, trigger: 'adverse_evidence', adverse_reasons: adverseReasons, reduce_percent: reducePercent },
    };
  }

  const supportingThesis = theses.find((thesis) =>
    thesis.symbols.includes(symbol)
    && thesis.status === 'hardening' && thesis.stance === 'bullish' && thesis.confidence >= 80);
  if (
    recommendation === 'add'
    && confidence >= 90
    && thesisState === 'intact'
    && riskPass
    && decision.bull_case_pass === true
    && decision.bear_case_answered === true
    && supportingThesis
  ) {
    const evidence = actionableBrokerEvidence(researched, symbol);
    const requestedPercent = Number(decision.add_percent);
    const multiplier = supportingThesis.size_multiplier;
    // Results-driven add: the model's requested add % of NAV x the thesis multiplier. No fixed
    // add %, add count, spacing or averaging-down rule; only spendable cash (no margin) limits it.
    const dollarAmount = validMultiplier(multiplier) && Number.isFinite(requestedPercent) && requestedPercent > 0
      ? sizeBuyNotional({
        totalValue: snapshot.totalValue,
        buyingPower: snapshot.buyingPower,
        cash: snapshot.cash,
        requestedPercent,
        multiplier,
        maxStake: supportingThesis.max_stake,
      })
      : 0;
    if (evidence.pass && dollarAmount >= MIN_ORDER_NOTIONAL) return {
      action: 'add', symbol, dollarAmount,
      rationale: `Evidence-backed add to ${supportingThesis.name}: ${String(decision.summary || '').slice(0, 1200)}`,
      evidence: {
        ...commonEvidence,
        trigger: 'hardening_thesis_add',
        thesis_id: supportingThesis.id,
        broker_evidence: evidence.reasons,
        size_multiplier: multiplier ?? null,
      },
    };
  }

  return {
    action: 'hold', symbol, rationale: String(decision.summary || 'No position action passed deterministic gates.').slice(0, 1200),
    evidence: commonEvidence,
  };
}
