import { DurableObject } from 'cloudflare:workers';

export type BrokerAccountSnapshot = {
  accountKey: string;
  accountLast4: string;
  observedAt: string;
  totalValue: number;
  equityValue: number;
  cash: number;
  buyingPower: number;
  positions: Array<{
    symbol: string;
    quantity: number;
    sharesAvailableForSells: number;
    averageBuyPrice: number | null;
  }>;
  todayAgenticOrderCount: number;
  todayAgenticOrderNotional: number;
  pendingOrderSymbols: string[];
};

export type BrokerMarketContext = {
  observedAt: string;
  symbols: Array<{
    symbol: string;
    tradable: boolean;
    state: string;
    fractionalTradable: boolean;
    bid: number;
    ask: number;
    last: number;
    previousClose: number;
    quoteAt: string;
    spreadBps: number;
  }>;
};

export type AutonomousEquityIntent = {
  refId: string;
  symbol: string;
  side: 'buy' | 'sell';
  positionAction: 'open' | 'add' | 'reduce' | 'exit';
  dollarAmount?: number;
  quantity?: number;
  rationaleSha256: string;
  maxTradePercent: number;
  maxDailyNotionalPercent: number;
  maxTradesPerDay: number;
  maxSpreadBps: number;
};

export type AutonomousExecutionResult = {
  refId: string;
  status: 'submitted' | 'duplicate';
  accountKey: string;
  brokerOrderId: string;
  orderJson: string;
  reviewJson: string;
  submittedAt: string;
};

// Compile-time contract for the cross-Worker Durable Object binding.
export abstract class RobinhoodBrokerRpc extends DurableObject {
  abstract readAccountSnapshot(): Promise<BrokerAccountSnapshot>;
  abstract readEquityMarketContext(symbols: string[]): Promise<BrokerMarketContext>;
  abstract readEquityResearchContext(symbols: string[]): Promise<string>;
  abstract executeAutonomousEquityIntent(intent: AutonomousEquityIntent): Promise<AutonomousExecutionResult>;
}
