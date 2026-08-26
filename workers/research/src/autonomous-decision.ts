import type { BrokerAccountSnapshot } from '@quantanamo/contracts/broker';

import {
  asBrokerResearchContext,
  EarningsResultRowSchema,
  ThesisAiOutputSchema,
  type BrokerResearchContext,
  type FundamentalsRow,
  type MarketSymbolRow,
} from './schemas';

export type DecisionJsonPrimitive = boolean | number | string | null;
export type DecisionJsonValue =
  | DecisionJsonPrimitive
  | DecisionJsonObject
  | DecisionJsonValue[];
export type DecisionJsonObject = { [key: string]: DecisionJsonValue };

export type BrokerEvidence = {
  pass: boolean;
  reasons: string[];
};

export type ApprovedCandidate = {
  symbol: string;
  notional: number;
  rationale: string;
  evidence: DecisionJsonObject;
};

export type DecisionThesisTask = {
  thesis: {
    status: string;
    stance: string;
    confidence: number;
    symbols: string[];
  };
};

function marketRow(context: BrokerResearchContext, symbol: string): MarketSymbolRow | null {
  return context.market?.symbols?.find((row) => row.symbol === symbol) ?? null;
}

function fundamentalsRow(context: BrokerResearchContext, symbol: string): FundamentalsRow | null {
  return context.fundamentals?.results?.find((row) => row.symbol === symbol) ?? null;
}

function earningsResultRows(context: BrokerResearchContext, symbol: string) {
  const earningsRow = context.earnings?.find((row) => row.symbol === symbol);
  const rows = earningsRow?.data?.results ?? [];
  return rows.flatMap((row) => {
    const parsed = EarningsResultRowSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function actionableBrokerEvidence(
  context: unknown,
  symbol: string,
): BrokerEvidence {
  const researched = asBrokerResearchContext(context);
  const reasons: string[] = [];
  const market = marketRow(researched, symbol);
  if (!market) return { pass: false, reasons: ['missing_market_context'] };
  const quoteAt = Date.parse(String(market.quoteAt || ''));
  if (!Number.isFinite(quoteAt) || Date.now() - quoteAt > 120_000) return { pass: false, reasons: ['stale_quote'] };
  if (market.tradable !== true || market.state !== 'active') return { pass: false, reasons: ['not_tradable'] };
  const spreadBps = Number(market.spreadBps);
  if (!Number.isFinite(spreadBps) || spreadBps > 80) return { pass: false, reasons: ['spread_too_wide'] };

  for (const row of earningsResultRows(researched, symbol)) {
    if (!row.report || !row.eps || row.eps.actual == null) continue;
    const reportDateValue = typeof row.report.date === 'string' ? row.report.date : null;
    if (!reportDateValue) continue;
    const reportDate = Date.parse(`${reportDateValue}T12:00:00-04:00`);
    if (Number.isFinite(reportDate) && Math.abs(Date.now() - reportDate) <= 3 * 24 * 60 * 60 * 1_000) {
      reasons.push('recent_reported_earnings');
      break;
    }
  }

  const fundamentals = fundamentalsRow(researched, symbol);
  if (fundamentals) {
    const volume = Number(fundamentals.volume);
    const averageVolume = Number(fundamentals.average_volume_2_weeks ?? fundamentals.average_volume);
    const last = Number(market.last);
    const previousClose = Number(market.previousClose);
    const open = Number(fundamentals.open);
    const movePercent = previousClose > 0 ? ((last - previousClose) / previousClose) * 100 : NaN;
    if (
      Number.isFinite(volume) && Number.isFinite(averageVolume) && averageVolume > 0
      && volume >= averageVolume * 1.5
      && Number.isFinite(movePercent) && Math.abs(movePercent) >= 3 && Math.abs(movePercent) <= 8
      && Number.isFinite(open) && last > open
    ) reasons.push('price_volume_dislocation');
  }
  return { pass: reasons.length > 0, reasons };
}

export { marketRow, fundamentalsRow, earningsResultRows };

export function approvedCandidate(
  task: DecisionThesisTask,
  output: unknown,
  brokerContext: unknown,
  snapshot: BrokerAccountSnapshot,
): ApprovedCandidate | null {
  const parsed = ThesisAiOutputSchema.safeParse(output);
  if (!parsed.success) return null;
  const decision = parsed.data;
  if (decision.trade_decision !== 'buy' || decision.material_change !== true) return null;
  if (task.thesis.status !== 'hardening' || task.thesis.stance !== 'bullish' || task.thesis.confidence < 80) return null;
  const symbol = String(decision.symbol || '').trim().toUpperCase();
  if (!task.thesis.symbols.includes(symbol)) return null;
  if (Number(decision.decision_confidence) < 85) return null;
  if (decision.bull_case_pass !== true || decision.bear_case_answered !== true || decision.portfolio_risk_pass !== true) {
    return null;
  }
  const catalyst = String(decision.catalyst || '').trim();
  const invalidation = String(decision.invalidation || '').trim();
  if (catalyst.length < 20 || invalidation.length < 20) return null;
  if (snapshot.positions.some((position) => position.symbol === symbol && position.quantity > 0)) return null;
  const evidence = actionableBrokerEvidence(brokerContext, symbol);
  if (!evidence.pass) return null;
  const requestedPercent = Number(decision.notional_percent);
  if (!Number.isFinite(requestedPercent) || requestedPercent < 1 || requestedPercent > 5) return null;
  const notional = Math.floor(Math.min(
    snapshot.totalValue * requestedPercent / 100,
    snapshot.totalValue * 0.05,
    snapshot.buyingPower,
  ) * 100) / 100;
  if (notional < 25) return null;
  return {
    symbol,
    notional,
    rationale: `${String(decision.summary || '').slice(0, 1200)} Catalyst: ${catalyst} Invalidation: ${invalidation}`,
    evidence: {
      reasons: evidence.reasons,
      decision_confidence: decision.decision_confidence ?? null,
      requested_percent: requestedPercent,
    },
  };
}
