import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

export const BrokerPositionSchema = z.object({
  symbol: z.string().min(1),
  quantity: z.number(),
  sharesAvailableForSells: z.number(),
  averageBuyPrice: z.number().nullable(),
});

export const BrokerAccountSnapshotSchema = z.object({
  accountKey: z.string().min(1),
  accountLast4: z.string().min(1),
  observedAt: z.string().min(1),
  totalValue: z.number(),
  equityValue: z.number(),
  cash: z.number(),
  buyingPower: z.number(),
  positions: z.array(BrokerPositionSchema),
  todayAgenticOrderCount: z.number().int().nonnegative(),
  todayAgenticOrderNotional: z.number(),
  pendingOrderSymbols: z.array(z.string()),
});

export const BrokerMarketSymbolSchema = z.object({
  symbol: z.string().min(1),
  tradable: z.boolean(),
  state: z.string(),
  fractionalTradable: z.boolean(),
  bid: z.number(),
  ask: z.number(),
  last: z.number(),
  previousClose: z.number(),
  quoteAt: z.string().min(1),
  spreadBps: z.number(),
});

export const BrokerMarketContextSchema = z.object({
  observedAt: z.string().min(1),
  symbols: z.array(BrokerMarketSymbolSchema),
});

export const AutonomousEquityIntentSchema = z.object({
  refId: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  positionAction: z.enum(['open', 'add', 'reduce', 'exit']),
  dollarAmount: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  rationaleSha256: z.string().min(1),
  /**
   * Deprecated and ignored by the gateway. PR 4 removed the % size rails, and PR 6 removed
   * the fixed trade-count and spread rails ("Kill the old rules!", David 2026-09-26).
   * Kept optional only so intents from older orchestrators still parse.
   */
  maxTradePercent: z.number().positive().optional(),
  maxDailyNotionalPercent: z.number().positive().optional(),
  maxTradesPerDay: z.number().int().positive().optional(),
  maxSpreadBps: z.number().positive().optional(),
});

export const AutonomousExecutionResultSchema = z.object({
  refId: z.string().min(1),
  status: z.enum(['submitted', 'duplicate']),
  accountKey: z.string().min(1),
  brokerOrderId: z.string().min(1),
  orderJson: z.string(),
  reviewJson: z.string(),
  submittedAt: z.string().min(1),
});

export type BrokerAccountSnapshot = z.infer<typeof BrokerAccountSnapshotSchema>;
export type BrokerMarketContext = z.infer<typeof BrokerMarketContextSchema>;
export type AutonomousEquityIntent = z.infer<typeof AutonomousEquityIntentSchema>;
export type AutonomousExecutionResult = z.infer<typeof AutonomousExecutionResultSchema>;

// Compile-time contract for the cross-Worker Durable Object binding.
export abstract class RobinhoodBrokerRpc extends DurableObject {
  abstract readAccountSnapshot(): Promise<BrokerAccountSnapshot>;
  abstract readEquityMarketContext(symbols: string[]): Promise<BrokerMarketContext>;
  abstract readEquityResearchContext(symbols: string[]): Promise<string>;
  abstract executeAutonomousEquityIntent(intent: AutonomousEquityIntent): Promise<AutonomousExecutionResult>;
}
