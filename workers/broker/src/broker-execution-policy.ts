import type { AutonomousEquityIntent, BrokerAccountSnapshot } from '@quantanamo/contracts/broker';

export function validateBrokerExecutionPolicy(
  intent: AutonomousEquityIntent,
  snapshot: BrokerAccountSnapshot,
  markPrice?: number,
): number {
  const symbol = intent.symbol.trim().toUpperCase();
  const hasDollarAmount = Number.isFinite(intent.dollarAmount);
  const requested = Number(hasDollarAmount ? intent.dollarAmount : intent.quantity);
  if (!Number.isFinite(requested) || requested <= 0) throw new Error('Order size must be positive');
  if (snapshot.pendingOrderSymbols.includes(symbol)) throw new Error('A same-symbol broker order is already pending');
  const position = snapshot.positions.find((item) => item.symbol === symbol && item.quantity > 0);

  if (intent.positionAction === 'open') {
    if (intent.side !== 'buy' || !hasDollarAmount) throw new Error('Opening orders must be dollar-based buys');
    if (position) throw new Error('Opening order conflicts with an existing position');
  } else if (intent.positionAction === 'add') {
    if (intent.side !== 'buy' || !hasDollarAmount) throw new Error('Add orders must be dollar-based buys');
    if (!position) throw new Error('Add order requires an existing position');
  } else if (intent.positionAction === 'reduce' || intent.positionAction === 'exit') {
    if (intent.side !== 'sell' || hasDollarAmount) throw new Error('Risk-reducing orders must be share-based sells');
    if (!position || requested > position.sharesAvailableForSells) throw new Error('Sell exceeds currently available shares');
    const tolerance = 0.000001;
    if (intent.positionAction === 'exit' && Math.abs(requested - position.sharesAvailableForSells) > tolerance) {
      throw new Error('Exit order must use all currently available shares');
    }
    if (intent.positionAction === 'reduce') {
      if (requested >= position.sharesAvailableForSells - tolerance) throw new Error('Reduction cannot be a full exit');
      if (requested > position.sharesAvailableForSells * 0.5 + tolerance) throw new Error('Reduction exceeds 50% of available shares');
    }
  } else {
    throw new Error('Unsupported position action');
  }

  if (intent.side === 'buy') {
    if (snapshot.todayAgenticOrderCount >= intent.maxTradesPerDay) throw new Error('Daily buy trade-count limit reached');
    if (requested > snapshot.buyingPower) throw new Error('Order exceeds current buying power');
    if (requested > snapshot.totalValue * intent.maxTradePercent / 100) throw new Error('Order exceeds the per-trade portfolio cap');
    if (snapshot.todayAgenticOrderNotional + requested > snapshot.totalValue * intent.maxDailyNotionalPercent / 100) {
      throw new Error('Order exceeds the daily notional cap');
    }
  }
  if (intent.positionAction === 'add' && position && markPrice !== undefined) {
    if (!Number.isFinite(markPrice) || markPrice <= 0) throw new Error('A valid add price is required');
    if (position.quantity * markPrice + requested > snapshot.totalValue * intent.maxTradePercent / 100) {
      throw new Error('Add would exceed the total position portfolio cap');
    }
    if (position.averageBuyPrice !== null && markPrice < position.averageBuyPrice) {
      throw new Error('Autonomous averaging down is not permitted');
    }
  }
  return requested;
}
