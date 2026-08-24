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

export function parseAiJsonObject(result: unknown): Record<string, unknown> {
  const text = unwrapAiText(result).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  try {
    const parsed = JSON.parse(fenced || text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The output remains audit-only and cannot become a trade intent.
  }
  return {
    material_change: false,
    summary: text.slice(0, 4000),
    actions: [],
    risks: ['unstructured_model_output'],
  };
}
