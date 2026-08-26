import {
  AI_MODELS,
  jsonSchemaResponseFormat,
  modelForRole,
  parseAiJsonObject,
  runAiRole,
  type AiRole,
} from '@quantanamo/shared/ai';
import { isJsonObject, type JsonObject } from '@quantanamo/shared/json';

import {
  parsePositionAiOutput,
  parseThesisAiOutput,
  type CloudTask,
  type ThesisAiOutput,
  type PositionAiOutput,
} from './schemas';

export const SYNTHESIS_PROMPT_VERSION = 'thesis-synthesis-v3';
export const SYNTHESIS_AI_MODEL = AI_MODELS.synthesis;
export const SYNTHESIS_ESCALATE_AI_MODEL = AI_MODELS.synthesis_escalate;

type ResearchTask = Extract<CloudTask, { kind: 'thesis_research' }>;
type PositionReviewTask = Extract<CloudTask, { kind: 'position_review' }>;

type AiEnv = {
  AI: Ai;
  AI_GATEWAY_ID: string;
};

const ThesisSynthesisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    material_change: { type: 'boolean' },
    stance: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
    confidence_delta: { type: 'integer', minimum: -10, maximum: 10 },
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'string' } },
    trade_decision: { type: 'string', enum: ['no_trade', 'buy'] },
    symbol: { type: 'string' },
    notional_percent: { type: 'number', minimum: 0, maximum: 5 },
    decision_confidence: { type: 'integer', minimum: 0, maximum: 100 },
    catalyst: { type: 'string' },
    invalidation: { type: 'string' },
    bull_case_pass: { type: 'boolean' },
    bear_case_answered: { type: 'boolean' },
    portfolio_risk_pass: { type: 'boolean' },
    claim_status: {
      type: 'string',
      enum: ['confirmed', 'contradicted', 'partially_supported', 'unverified', 'insufficient'],
    },
    cited_source_ids: { type: 'array', items: { type: 'string' } },
    escalate: { type: 'boolean' },
  },
  required: [
    'material_change', 'stance', 'confidence_delta', 'summary', 'risks', 'actions',
    'trade_decision', 'symbol', 'notional_percent', 'decision_confidence', 'catalyst',
    'invalidation', 'bull_case_pass', 'bear_case_answered', 'portfolio_risk_pass',
    'claim_status', 'cited_source_ids', 'escalate',
  ],
} as const;

const PositionSynthesisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    position_action: { type: 'string', enum: ['hold', 'add', 'reduce', 'exit'] },
    decision_confidence: { type: 'integer', minimum: 0, maximum: 100 },
    thesis_state: { type: 'string', enum: ['intact', 'weakening', 'invalidated'] },
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    catalyst: { type: 'string' },
    invalidation: { type: 'string' },
    add_percent: { type: 'number', minimum: 0, maximum: 2 },
    reduce_percent: { type: 'number', minimum: 0, maximum: 100 },
    invalidation_confirmed: { type: 'boolean' },
    adverse_evidence: { type: 'boolean' },
    bull_case_pass: { type: 'boolean' },
    bear_case_answered: { type: 'boolean' },
    portfolio_risk_pass: { type: 'boolean' },
    claim_status: {
      type: 'string',
      enum: ['confirmed', 'contradicted', 'partially_supported', 'unverified', 'insufficient'],
    },
    cited_source_ids: { type: 'array', items: { type: 'string' } },
    escalate: { type: 'boolean' },
  },
  required: [
    'position_action', 'decision_confidence', 'thesis_state', 'summary', 'risks', 'catalyst',
    'invalidation', 'add_percent', 'reduce_percent', 'invalidation_confirmed', 'adverse_evidence',
    'bull_case_pass', 'bear_case_answered', 'portfolio_risk_pass',
    'claim_status', 'cited_source_ids', 'escalate',
  ],
} as const;

function thesisInvestigations(thesis: ResearchTask['thesis']): unknown[] {
  return Array.isArray(thesis.recent_investigations) ? thesis.recent_investigations.slice(0, 6) : [];
}

function compactInvestigation(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const row = item as Record<string, unknown>;
  return {
    bookmark_id: row.bookmark_id,
    claim_status: row.claim_status,
    investigation_summary: typeof row.investigation_summary === 'string'
      ? row.investigation_summary.slice(0, 800)
      : row.investigation_summary,
    symbols: Array.isArray(row.symbols) ? row.symbols.slice(0, 8) : row.symbols,
    corroborating_source_ids: Array.isArray(row.corroborating_source_ids)
      ? row.corroborating_source_ids.slice(0, 8)
      : row.corroborating_source_ids,
    contradicting_source_ids: Array.isArray(row.contradicting_source_ids)
      ? row.contradicting_source_ids.slice(0, 8)
      : row.contradicting_source_ids,
    open_questions: Array.isArray(row.open_questions) ? row.open_questions.slice(0, 4) : row.open_questions,
  };
}

function compactThesisForSynthesis(thesis: ResearchTask['thesis']): Record<string, unknown> {
  return {
    id: thesis.id,
    name: thesis.name,
    summary: thesis.summary.slice(0, 2_000),
    status: thesis.status,
    confidence: thesis.confidence,
    stance: thesis.stance,
    time_horizon: thesis.time_horizon,
    variant_perception: thesis.variant_perception?.slice(0, 500) ?? null,
    falsifier: thesis.falsifier?.slice(0, 500) ?? null,
    symbols: thesis.symbols.slice(0, 8),
    recent_investigations: thesisInvestigations(thesis).map(compactInvestigation),
  };
}

function compactDecisionContext(decisionContext: JsonObject): JsonObject {
  const broker = decisionContext.broker;
  if (!isJsonObject(broker)) return decisionContext;
  const quotes = Array.isArray(broker.quotes) ? broker.quotes.slice(0, 8) : broker.quotes;
  const research = Array.isArray(broker.research) ? broker.research.slice(0, 8) : broker.research;
  return {
    ...decisionContext,
    broker: { ...broker, quotes, research },
  };
}

function investigationConflict(investigations: unknown[]): boolean {
  let supporting = false;
  let contradicting = false;
  for (const item of investigations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const status = (item as Record<string, unknown>).claim_status;
    if (status === 'corroborated') supporting = true;
    if (status === 'contradicted') contradicting = true;
  }
  return supporting && contradicting;
}

function shouldEscalateThesis(investigations: unknown[], firstPass: ThesisAiOutput): boolean {
  if (firstPass.escalate === true) return true;
  if (investigationConflict(investigations)) return true;
  if (firstPass.trade_decision === 'buy' && Number(firstPass.decision_confidence || 0) >= 75) return true;
  if (firstPass.claim_status === 'contradicted' || firstPass.claim_status === 'insufficient') return true;
  return false;
}

function shouldEscalatePosition(firstPass: PositionAiOutput): boolean {
  if (firstPass.escalate === true) return true;
  if (firstPass.position_action === 'exit' || firstPass.position_action === 'reduce') return true;
  if (firstPass.position_action === 'add' && Number(firstPass.decision_confidence || 0) >= 75) return true;
  return false;
}

function aiErrorRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /4006:|2021:|7003:|neurons|Invalid User Credentials|User Input Error/i.test(message);
}

async function runSynthesis(
  env: AiEnv,
  role: Extract<AiRole, 'synthesis' | 'synthesis_escalate'>,
  system: string,
  user: string,
  schemaName: string,
  schema: Record<string, unknown>,
  metadata: Record<string, string>,
): Promise<unknown> {
  const gatewayOptions = {
    gatewayId: env.AI_GATEWAY_ID,
    metadata: {
      prompt_version: SYNTHESIS_PROMPT_VERSION,
      ai_model: modelForRole(role),
      ...metadata,
    },
    tags: ['quantanamo', role],
  };
  const primary = async (): Promise<unknown> => {
    const result = await runAiRole(
      env.AI,
      role,
      {
        system: [
          system,
          'Return strict JSON only. Do not wrap the payload in markdown.',
        ].join(' '),
        messages: [{ role: 'user', content: user }],
        max_tokens: 1_200,
        temperature: 0.1,
        response_format: jsonSchemaResponseFormat(schemaName, schema),
        reasoning: { effort: role === 'synthesis_escalate' ? 'high' : 'medium' },
      },
      gatewayOptions,
    );
    return parseAiJsonObject(result);
  };
  try {
    return await primary();
  } catch (error) {
    if (!aiErrorRetryable(error)) throw error;
    console.warn(JSON.stringify({
      event: 'synthesis_primary_retry',
      role,
      error: error instanceof Error ? error.message : 'unknown',
      model: modelForRole(role),
    }));
    return primary();
  }
}

export async function synthesizeThesisDecision(
  env: AiEnv,
  task: ResearchTask,
  decisionContext: JsonObject,
  liveMode: boolean,
): Promise<JsonObject> {
  const investigations = thesisInvestigations(task.thesis);
  const system = [
    'You are an evidence-bounded investment synthesizer.',
    'You cannot call tools or place orders. Use only the supplied thesis, broker context, and investigation packets.',
    'Do not invent current facts, prices, filings, catalysts, earnings, or news.',
    'Separate tweet claims from retrieved evidence. Social claims are not facts.',
    'Every material factual assertion must reference a cited_source_id from the investigation packet when available.',
    'If evidence is insufficient, set claim_status to insufficient and trade_decision to no_trade.',
    'Set escalate=true when sources conflict or financial implications are complex.',
    liveMode
      ? 'A buy is permitted only for an explicitly evidenced, fresh catalyst or price/volume dislocation; otherwise return no_trade.'
      : 'This is a shadow run. Always return no_trade.',
  ].join(' ');
  const boundedContext = compactDecisionContext(decisionContext);
  const user = [
    'Return strict JSON matching the schema.',
    `Market slot: ${task.marketSlot}`,
    `Canonical context version: ${task.contextVersion}`,
    `Thesis: ${JSON.stringify(compactThesisForSynthesis(task.thesis))}`,
    `Claim investigations: ${JSON.stringify(investigations.map(compactInvestigation))}`,
    `Broker and portfolio context: ${JSON.stringify(boundedContext)}`,
  ].join('\n');

  const first = parseThesisAiOutput(await runSynthesis(
    env,
    'synthesis',
    system,
    user,
    'thesis_synthesis',
    ThesisSynthesisJsonSchema,
    { run_id: task.runId, thesis_id: task.thesis.id },
  ));
  if (!shouldEscalateThesis(investigations, first)) {
    return { ...first, synthesis_model: SYNTHESIS_AI_MODEL } as JsonObject;
  }
  const escalated = parseThesisAiOutput(await runSynthesis(
    env,
    'synthesis_escalate',
    system,
    `${user}\nPrior synthesis pass: ${JSON.stringify(first)}\nEscalate carefully. Prefer no_trade when evidence remains contested.`,
    'thesis_synthesis',
    ThesisSynthesisJsonSchema,
    { run_id: task.runId, thesis_id: task.thesis.id, escalated: 'true' },
  ));
  return {
    ...escalated,
    synthesis_model: SYNTHESIS_ESCALATE_AI_MODEL,
    escalated_from: first,
  } as JsonObject;
}

export async function synthesizePositionDecision(
  env: AiEnv,
  task: PositionReviewTask,
  position: JsonObject,
  snapshot: JsonObject,
  brokerContext: JsonObject,
): Promise<JsonObject> {
  const system = [
    'You are a cautious position-management synthesizer.',
    'You cannot call tools or place orders. Use only the supplied broker context, position, and linked theses.',
    'Do not invent facts. Recommend hold by default.',
    'Add requires a fresh positive catalyst and an intact hardening thesis.',
    'Reduce or exit requires specific adverse evidence or a confirmed thesis invalidation.',
    'Set escalate=true for exits, large reduces, or conflicting evidence.',
  ].join(' ');
  const user = [
    'Return strict JSON matching the schema.',
    `Review reason: ${task.reason}`,
    `Position: ${JSON.stringify(position)}`,
    `Portfolio: ${JSON.stringify(snapshot)}`,
    `Linked theses: ${JSON.stringify(task.theses || [])}`,
    `Broker context: ${JSON.stringify(brokerContext)}`,
  ].join('\n');

  const first = parsePositionAiOutput(await runSynthesis(
    env,
    'synthesis',
    system,
    user,
    'position_synthesis',
    PositionSynthesisJsonSchema,
    { run_id: task.runId, position_key: task.positionKey },
  ));
  if (!shouldEscalatePosition(first)) {
    return { ...first, synthesis_model: SYNTHESIS_AI_MODEL } as JsonObject;
  }
  const escalated = parsePositionAiOutput(await runSynthesis(
    env,
    'synthesis_escalate',
    system,
    `${user}\nPrior Sonnet pass: ${JSON.stringify(first)}\nEscalate carefully. Prefer hold when evidence is incomplete.`,
    'position_synthesis',
    PositionSynthesisJsonSchema,
    { run_id: task.runId, position_key: task.positionKey, escalated: 'true' },
  ));
  return {
    ...escalated,
    synthesis_model: SYNTHESIS_ESCALATE_AI_MODEL,
    escalated_from: first,
  } as JsonObject;
}
