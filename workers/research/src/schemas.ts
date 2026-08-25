import { z } from 'zod';

export const MAX_THESES_PER_RUN = 12;

const AutonomousExecutionResultSchema = z.object({
  refId: z.string().min(1),
  status: z.enum(['submitted', 'duplicate']),
  accountKey: z.string().min(1),
  brokerOrderId: z.string().min(1),
  orderJson: z.string(),
  reviewJson: z.string(),
  submittedAt: z.string().min(1),
});

export const ThesisSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  status: z.string().default('unknown'),
  confidence: z.number().default(0),
  stance: z.string().default('neutral'),
  time_horizon: z.string().optional(),
  variant_perception: z.string().nullable().optional(),
  falsifier: z.string().nullable().optional(),
  symbols: z.array(z.string()).max(8).default([]),
  recent_investigations: z.array(z.unknown()).max(8).optional(),
});

export type Thesis = z.infer<typeof ThesisSchema>;

const PositionActionSchema = z.enum(['open', 'add', 'reduce', 'exit']);

const ApprovedProposalRowSchema = z.object({
  id: z.number().int(),
  thesis_id: z.string().nullable().optional(),
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  notional: z.coerce.number().positive(),
  rationale: z.string().min(1),
  created_at: z.string().optional(),
  broker_alerts: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ApprovedTradeProposalSchema = z.object({
  id: z.number().int(),
  thesisId: z.string().nullable(),
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  notional: z.number().positive(),
  quantity: z.number().positive().optional(),
  positionEpisodeId: z.string().optional(),
  positionAction: PositionActionSchema.optional(),
  rationale: z.string().min(1),
  createdAt: z.string(),
});

export type ApprovedTradeProposal = z.infer<typeof ApprovedTradeProposalSchema>;

export const PositionConfigurationSchema = z.object({
  positionKey: z.string().min(1),
  episodeId: z.string().min(1),
  symbol: z.string().min(1),
  accountKey: z.string().min(1),
  nextReviewAt: z.number().nullable(),
});

export type PositionConfiguration = z.infer<typeof PositionConfigurationSchema>;

const RiskControlSchema = z.object({
  control_key: z.string(),
  status: z.string(),
  enforcement_level: z.string(),
}).passthrough();

const CloudContextSchema = z.object({
  snapshot: z.object({
    generated_at: z.string().optional(),
    payload: z.object({
      theses: z.array(z.unknown()).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  latest_thesis_input_sha256: z.record(z.string(), z.unknown()).optional(),
  approved_proposals: z.array(z.unknown()).optional(),
  risk_controls: z.array(z.unknown()).optional(),
}).passthrough();

const FinalizeRunSchema = z.object({
  finalized: z.literal(true),
}).passthrough();

const IdRowSchema = z.object({
  id: z.union([z.string(), z.number()]),
}).passthrough();

export function parseTheses(context: unknown): Thesis[] {
  const parsed = CloudContextSchema.safeParse(context);
  if (!parsed.success) return [];
  const rows = parsed.data.snapshot?.payload?.theses;
  if (!rows) return [];
  const theses: Thesis[] = [];
  for (const row of rows) {
    const thesis = ThesisSchema.safeParse(row);
    if (!thesis.success) continue;
    theses.push({
      ...thesis.data,
      symbols: thesis.data.symbols.slice(0, 8),
      variant_perception: thesis.data.variant_perception ?? null,
      falsifier: thesis.data.falsifier ?? null,
      recent_investigations: thesis.data.recent_investigations?.slice(0, 6),
    });
  }
  return theses.slice(0, MAX_THESES_PER_RUN);
}

export function contextVersion(context: unknown): string {
  const parsed = CloudContextSchema.safeParse(context);
  return parsed.success && parsed.data.snapshot?.generated_at
    ? parsed.data.snapshot.generated_at
    : 'missing-snapshot-version';
}

export function latestThesisHashes(context: unknown): Map<string, string> {
  const hashes = new Map<string, string>();
  const parsed = CloudContextSchema.safeParse(context);
  if (!parsed.success || !parsed.data.latest_thesis_input_sha256) return hashes;
  for (const [key, value] of Object.entries(parsed.data.latest_thesis_input_sha256)) {
    if (typeof value === 'string') hashes.set(key, value);
  }
  return hashes;
}

function positionActionValue(value: unknown): ApprovedTradeProposal['positionAction'] {
  const parsed = PositionActionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function approvedTradeProposals(context: unknown): ApprovedTradeProposal[] {
  const parsed = CloudContextSchema.safeParse(context);
  if (!parsed.success || !parsed.data.approved_proposals) return [];
  const proposals: ApprovedTradeProposal[] = [];
  for (const row of parsed.data.approved_proposals) {
    const candidate = ApprovedProposalRowSchema.safeParse(row);
    if (!candidate.success) continue;
    const alerts = candidate.data.broker_alerts ?? {};
    const quantity = Number(alerts.position_quantity);
    const positionAction = positionActionValue(alerts.position_action)
      ?? (candidate.data.side === 'buy' ? 'open' : undefined);
    if (candidate.data.side === 'sell' && (!Number.isFinite(quantity) || quantity <= 0)) continue;
    proposals.push({
      id: candidate.data.id,
      thesisId: candidate.data.thesis_id ?? null,
      symbol: candidate.data.symbol.trim().toUpperCase(),
      side: candidate.data.side,
      notional: candidate.data.notional,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
      positionEpisodeId: typeof alerts.position_episode_id === 'string'
        ? alerts.position_episode_id
        : undefined,
      positionAction,
      rationale: candidate.data.rationale,
      createdAt: candidate.data.created_at ?? '',
    });
  }
  return proposals.slice(0, 3);
}

function riskControlActive(context: unknown, controlKey: string): boolean {
  const parsed = CloudContextSchema.safeParse(context);
  if (!parsed.success || !parsed.data.risk_controls) return false;
  return parsed.data.risk_controls.some((row) => {
    const control = RiskControlSchema.safeParse(row);
    return control.success
      && control.data.control_key === controlKey
      && control.data.status === 'active'
      && control.data.enforcement_level === 'code';
  });
}

export function autonomousExecutionActive(context: unknown): boolean {
  return riskControlActive(context, 'autonomous-execution');
}

export function autonomousPositionManagementActive(context: unknown): boolean {
  return riskControlActive(context, 'autonomous-position-management');
}

export function firstObject(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const row = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return row as Record<string, unknown>;
}

export function firstIdRow(value: unknown): { id: string | number } | null {
  const row = firstObject(value);
  if (!row) return null;
  const parsed = IdRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function parsePositionConfiguration(text: string): PositionConfiguration {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Stored position configuration is invalid');
  }
  const parsed = PositionConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new Error('Stored position configuration is invalid');
  return parsed.data;
}

export function parseAutonomousExecutionResult(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Stored autonomous execution result is invalid');
  }
  const parsed = AutonomousExecutionResultSchema.safeParse(value);
  if (!parsed.success) throw new Error('Stored autonomous execution result is invalid');
  return parsed.data;
}

export function isFinalizeRunSuccess(value: unknown): boolean {
  return FinalizeRunSchema.safeParse(value).success;
}

export function unwrapAiText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.response === 'string') return record.response;
  }
  return JSON.stringify(result);
}

export const ThesisAiOutputSchema = z.object({
  material_change: z.boolean(),
  stance: z.enum(['bullish', 'bearish', 'neutral']).optional(),
  confidence_delta: z.number().optional(),
  summary: z.string().optional(),
  risks: z.array(z.string()).optional(),
  actions: z.array(z.string()).optional(),
  trade_decision: z.enum(['no_trade', 'buy']).optional(),
  symbol: z.string().optional(),
  notional_percent: z.number().optional(),
  decision_confidence: z.number().optional(),
  catalyst: z.string().optional(),
  invalidation: z.string().optional(),
  bull_case_pass: z.boolean().optional(),
  bear_case_answered: z.boolean().optional(),
  portfolio_risk_pass: z.boolean().optional(),
  claim_status: z.enum([
    'confirmed',
    'contradicted',
    'partially_supported',
    'unverified',
    'insufficient',
  ]).optional(),
  cited_source_ids: z.array(z.string()).optional(),
  escalate: z.boolean().optional(),
}).passthrough();

export type ThesisAiOutput = z.infer<typeof ThesisAiOutputSchema>;

export const PositionAiOutputSchema = z.object({
  position_action: z.enum(['hold', 'add', 'reduce', 'exit']),
  decision_confidence: z.number(),
  thesis_state: z.enum(['intact', 'weakening', 'invalidated']),
  summary: z.string().optional(),
  risks: z.array(z.string()).optional(),
  catalyst: z.string().optional(),
  invalidation: z.string().optional(),
  add_percent: z.number().optional(),
  reduce_percent: z.number().optional(),
  invalidation_confirmed: z.boolean().optional(),
  adverse_evidence: z.boolean().optional(),
  bull_case_pass: z.boolean().optional(),
  bear_case_answered: z.boolean().optional(),
  portfolio_risk_pass: z.boolean().optional(),
  claim_status: z.enum([
    'confirmed',
    'contradicted',
    'partially_supported',
    'unverified',
    'insufficient',
  ]).optional(),
  cited_source_ids: z.array(z.string()).optional(),
  escalate: z.boolean().optional(),
}).passthrough();

export type PositionAiOutput = z.infer<typeof PositionAiOutputSchema>;

function extractAiJson(result: unknown): { text: string; value: unknown | null } {
  const text = unwrapAiText(result).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  try {
    return { text, value: JSON.parse(fenced || text) as unknown };
  } catch {
    return { text, value: null };
  }
}

/** Audit-safe fallback: never actionable for buys. */
export function parseThesisAiOutput(result: unknown): ThesisAiOutput {
  const { text, value } = extractAiJson(result);
  const parsed = ThesisAiOutputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return {
    material_change: false,
    summary: text.slice(0, 4000),
    actions: [],
    risks: ['unstructured_model_output'],
  };
}

/** Audit-safe fallback: defaults to hold. */
export function parsePositionAiOutput(result: unknown): PositionAiOutput {
  const { text, value } = extractAiJson(result);
  const parsed = PositionAiOutputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return {
    position_action: 'hold',
    decision_confidence: 0,
    thesis_state: 'intact',
    summary: text.slice(0, 4000),
    risks: ['unstructured_model_output'],
  };
}

export function parseAiJsonObject(result: unknown): Record<string, unknown> {
  return parseThesisAiOutput(result);
}

export const MarketSymbolRowSchema = z.object({
  symbol: z.string().min(1),
  tradable: z.boolean().optional(),
  state: z.string().optional(),
  last: z.coerce.number().optional(),
  previousClose: z.coerce.number().optional(),
  quoteAt: z.string().optional(),
  spreadBps: z.coerce.number().optional(),
}).passthrough();

export const FundamentalsRowSchema = z.object({
  symbol: z.string().min(1),
  volume: z.unknown().optional(),
  average_volume_2_weeks: z.unknown().optional(),
  average_volume: z.unknown().optional(),
  open: z.unknown().optional(),
}).passthrough();

export const EarningsResultRowSchema = z.object({
  report: z.object({
    date: z.unknown().optional(),
  }).passthrough().optional(),
  eps: z.object({
    actual: z.unknown().optional().nullable(),
    estimate: z.unknown().optional().nullable(),
  }).passthrough().optional(),
}).passthrough();

export const EarningsSymbolRowSchema = z.object({
  symbol: z.string().min(1),
  data: z.object({
    results: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough();

export const BrokerResearchContextSchema = z.object({
  market: z.object({
    symbols: z.array(MarketSymbolRowSchema).optional(),
    observedAt: z.string().optional(),
  }).passthrough().optional(),
  fundamentals: z.object({
    results: z.array(FundamentalsRowSchema).optional(),
  }).passthrough().optional(),
  earnings: z.array(EarningsSymbolRowSchema).optional(),
}).passthrough();

export type BrokerResearchContext = z.infer<typeof BrokerResearchContextSchema>;
export type MarketSymbolRow = z.infer<typeof MarketSymbolRowSchema>;
export type FundamentalsRow = z.infer<typeof FundamentalsRowSchema>;

export function parseBrokerResearchContext(text: string): BrokerResearchContext {
  const parsed = BrokerResearchContextSchema.safeParse(parseJsonObject(text));
  return parsed.success ? parsed.data : {};
}

export function asBrokerResearchContext(value: unknown): BrokerResearchContext {
  const parsed = BrokerResearchContextSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

const PositionThesisSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  stance: z.string(),
  confidence: z.number(),
  symbols: z.array(z.string()),
  falsifier: z.string().nullable().optional(),
});

export const CloudTaskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('thesis_research'),
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    thesis: ThesisSchema,
    contextVersion: z.string().min(1),
    marketSlot: z.string().min(1),
  }),
  z.object({
    kind: z.literal('position_review'),
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    positionKey: z.string().min(1),
    reason: z.string().min(1),
    episodeId: z.string().optional(),
    symbol: z.string().optional(),
    theses: z.array(PositionThesisSchema).optional(),
  }),
  z.object({
    kind: z.literal('trade_execution'),
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    proposal: ApprovedTradeProposalSchema,
  }),
]);

export type CloudTask = z.infer<typeof CloudTaskSchema>;

export function parseCloudTask(value: unknown): CloudTask {
  return CloudTaskSchema.parse(value);
}

export function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Stored JSON object is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored JSON object is invalid');
  }
  return value as Record<string, unknown>;
}

export function parseJsonObjectOrNull(text: string): Record<string, unknown> | null {
  try {
    return parseJsonObject(text);
  } catch {
    return null;
  }
}

export const PositionEpisodeRowSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
}).passthrough();

export type PositionEpisodeRow = z.infer<typeof PositionEpisodeRowSchema>;

export function parsePositionEpisodeRows(value: unknown): PositionEpisodeRow[] {
  if (!Array.isArray(value)) return [];
  const rows: PositionEpisodeRow[] = [];
  for (const row of value) {
    const parsed = PositionEpisodeRowSchema.safeParse(row);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

export const BrokerFillSchema = z.object({
  id: z.string().optional(),
  quantity: z.coerce.number().positive(),
  price: z.coerce.number().nonnegative(),
  timestamp: z.string().optional(),
  executed_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

export const BrokerOrderAuditSchema = z.object({
  executions: z.array(z.unknown()).optional(),
}).passthrough();

export function parseBrokerOrderAudit(orderJson: string, reviewJson: string): {
  order: Record<string, unknown>;
  review: Record<string, unknown>;
  fills: Array<{
    id?: string;
    quantity: number;
    price: number;
    timestamp?: string;
    executed_at?: string;
    updated_at?: string;
  } & Record<string, unknown>>;
} {
  const order = BrokerOrderAuditSchema.parse(parseJsonObject(orderJson));
  const review = parseJsonObject(reviewJson);
  const fills = [];
  for (const row of order.executions ?? []) {
    const fill = BrokerFillSchema.safeParse(row);
    if (!fill.success) continue;
    fills.push(fill.data);
  }
  return { order, review, fills };
}
