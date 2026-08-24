import type { BrokerAccountSnapshot } from './broker-contract';

export type DecisionJsonObject = Record<string, unknown>;

export type DecisionThesisTask = {
  thesis: {
    status: string;
    stance: string;
    confidence: number;
    symbols: string[];
  };
};

function isObject(value: unknown): value is DecisionJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function actionableBrokerEvidence(
  context: DecisionJsonObject,
  symbol: string,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const market = isObject(context.market) && Array.isArray(context.market.symbols)
    ? context.market.symbols.find((row) => isObject(row) && row.symbol === symbol)
    : null;
  if (!isObject(market)) return { pass: false, reasons: ['missing_market_context'] };
  const quoteAt = Date.parse(String(market.quoteAt || ''));
  if (!Number.isFinite(quoteAt) || Date.now() - quoteAt > 120_000) return { pass: false, reasons: ['stale_quote'] };
  if (market.tradable !== true || market.state !== 'active') return { pass: false, reasons: ['not_tradable'] };
  const spreadBps = Number(market.spreadBps);
  if (!Number.isFinite(spreadBps) || spreadBps > 80) return { pass: false, reasons: ['spread_too_wide'] };

  const earnings = Array.isArray(context.earnings) ? context.earnings : [];
  const earningsRow = earnings.find((row) => isObject(row) && row.symbol === symbol);
  const earningsResults = isObject(earningsRow) && isObject(earningsRow.data) && Array.isArray(earningsRow.data.results)
    ? earningsRow.data.results.filter(isObject)
    : [];
  for (const row of earningsResults) {
    if (!isObject(row.report) || !isObject(row.eps) || row.eps.actual == null || typeof row.report.date !== 'string') continue;
    const reportDate = Date.parse(`${row.report.date}T12:00:00-04:00`);
    if (Number.isFinite(reportDate) && Math.abs(Date.now() - reportDate) <= 3 * 24 * 60 * 60 * 1_000) {
      reasons.push('recent_reported_earnings');
      break;
    }
  }

  const fundamentals = isObject(context.fundamentals) && Array.isArray(context.fundamentals.results)
    ? context.fundamentals.results.find((row) => isObject(row) && row.symbol === symbol)
    : null;
  if (isObject(fundamentals)) {
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

export function approvedCandidate(
  task: DecisionThesisTask,
  output: DecisionJsonObject,
  brokerContext: DecisionJsonObject,
  snapshot: BrokerAccountSnapshot,
): { symbol: string; notional: number; rationale: string; evidence: DecisionJsonObject } | null {
  if (String(output.trade_decision) !== 'buy' || output.material_change !== true) return null;
  if (task.thesis.status !== 'hardening' || task.thesis.stance !== 'bullish' || task.thesis.confidence < 80) return null;
  const symbol = String(output.symbol || '').trim().toUpperCase();
  if (!task.thesis.symbols.includes(symbol)) return null;
  if (Number(output.decision_confidence) < 85) return null;
  if (output.bull_case_pass !== true || output.bear_case_answered !== true || output.portfolio_risk_pass !== true) return null;
  const catalyst = String(output.catalyst || '').trim();
  const invalidation = String(output.invalidation || '').trim();
  if (catalyst.length < 20 || invalidation.length < 20) return null;
  if (snapshot.positions.some((position) => position.symbol === symbol && position.quantity > 0)) return null;
  const evidence = actionableBrokerEvidence(brokerContext, symbol);
  if (!evidence.pass) return null;
  const requestedPercent = Number(output.notional_percent);
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
    rationale: `${String(output.summary || '').slice(0, 1200)} Catalyst: ${catalyst} Invalidation: ${invalidation}`,
    evidence: { reasons: evidence.reasons, decision_confidence: output.decision_confidence, requested_percent: requestedPercent },
  };
}
