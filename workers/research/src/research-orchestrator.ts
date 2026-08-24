import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import { marketGate } from './market-clock';
import { approvedCandidate } from './autonomous-decision';
import { decidePositionAction, type PositionHistory, type PositionThesis } from './position-decision';
import type {
  AutonomousEquityIntent,
  AutonomousExecutionResult,
  BrokerAccountSnapshot,
  RobinhoodBrokerRpc,
} from '@thesisforge/contracts/broker';
import { readSecret } from '@thesisforge/shared/secrets';
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from '@thesisforge/shared/json';

type PublicationEnv = Omit<Cloudflare.Env, 'ROBINHOOD_BROKER_AGENT'> & {
  ROBINHOOD_BROKER_AGENT: DurableObjectNamespace<RobinhoodBrokerRpc>;
};

// Retained only while the legacy Worker hands its Durable Object namespaces to
// thesisforge-research-orchestrator. The final topology has no publication Workflow.
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const PROMPT_VERSION = 'thesis-autonomous-v2';
const MAX_CONTROL_BYTES = 512 * 1024;
const MAX_THESES_PER_RUN = 12;

type DeduplicationResult = { duplicate: boolean };

type ShadowIntentReservation = {
  intentId: string;
  status: 'blocked_no_broker_gateway';
  duplicate: boolean;
};

type Thesis = {
  id: string;
  name: string;
  summary: string;
  status: string;
  confidence: number;
  stance: string;
  time_horizon?: string;
  variant_perception?: string | null;
  falsifier?: string | null;
  symbols: string[];
};

type ResearchCycleParams = {
  force?: boolean;
  requestedBy?: string;
  slot?: string;
};

type ResearchTask = {
  kind: 'thesis_research';
  runId: string;
  idempotencyKey: string;
  thesis: Thesis;
  contextVersion: string;
  marketSlot: string;
};

type PositionReviewTask = {
  kind: 'position_review';
  runId: string;
  idempotencyKey: string;
  positionKey: string;
  reason: string;
  episodeId?: string;
  symbol?: string;
  theses?: PositionThesis[];
};

type ApprovedTradeProposal = {
  id: number;
  thesisId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  notional: number;
  quantity?: number;
  positionEpisodeId?: string;
  positionAction?: 'open' | 'add' | 'reduce' | 'exit';
  rationale: string;
  createdAt: string;
};

type TradeExecutionTask = {
  kind: 'trade_execution';
  runId: string;
  idempotencyKey: string;
  proposal: ApprovedTradeProposal;
};

type CloudTask = ResearchTask | PositionReviewTask | TradeExecutionTask;

type PositionConfiguration = {
  positionKey: string;
  episodeId: string;
  symbol: string;
  accountKey: string;
  nextReviewAt: number | null;
};

type PositionObservation = {
  eventId: string;
  observedAt: string;
  recommendation: 'hold' | 'add' | 'reduce' | 'exit' | 'insufficient_data';
  evidence: JsonObject;
};

async function boundedJson(response: Response): Promise<JsonValue> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_CONTROL_BYTES) throw new Error('Cloud control response exceeded its size limit');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONTROL_BYTES) {
        await reader.cancel('response size limit exceeded');
        throw new Error('Cloud control response exceeded its size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(output);
  return text ? parseJson(text) : null;
}

async function cloudControl<Payload>(env: PublicationEnv, action: string, payload?: Payload): Promise<JsonValue> {
  const publicationToken = await readSecret(env.THESISFORGE_PUBLICATION_TOKEN_SECRET, 'THESISFORGE_PUBLICATION_TOKEN');
  const response = await fetch(
    `${env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/cloud-control`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-thesisforge-publication-token': publicationToken,
      },
      body: JSON.stringify({ action, payload }),
    },
  );
  const body = await boundedJson(response);
  if (!response.ok) throw new Error(`Cloud control failed with status ${response.status}`);
  return body;
}

async function finalizeRunAndPublish(env: PublicationEnv, runId: string): Promise<void> {
  const result = await cloudControl(env, 'finalize_run', { run_id: runId });
  if (!isJsonObject(result) || result.finalized !== true) return;
  const publicationToken = await readSecret(env.THESISFORGE_PUBLICATION_TOKEN_SECRET, 'THESISFORGE_PUBLICATION_TOKEN');
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/dashboard-publication`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-thesisforge-publication-token': publicationToken,
    },
    body: JSON.stringify({ publishCurrent: true }),
  });
  await boundedJson(response);
  if (!response.ok) throw new Error(`Dashboard projection failed with status ${response.status}`);
}

function parseTheses(context: JsonValue): Thesis[] {
  if (!isJsonObject(context) || !isJsonObject(context.snapshot) || !isJsonObject(context.snapshot.payload)) return [];
  const rows = context.snapshot.payload.theses;
  if (!Array.isArray(rows)) return [];
  const theses: Thesis[] = [];
  for (const row of rows) {
    if (!isJsonObject(row) || !isJsonString(row.id) || !isJsonString(row.name) || !isJsonString(row.summary)) continue;
    theses.push({
      id: row.id,
      name: row.name,
      summary: row.summary,
      status: isJsonString(row.status) ? row.status : 'unknown',
      confidence: isJsonNumber(row.confidence) ? row.confidence : 0,
      stance: isJsonString(row.stance) ? row.stance : 'neutral',
      time_horizon: isJsonString(row.time_horizon) ? row.time_horizon : undefined,
      variant_perception: isJsonString(row.variant_perception) ? row.variant_perception : null,
      falsifier: isJsonString(row.falsifier) ? row.falsifier : null,
      symbols: Array.isArray(row.symbols) ? row.symbols.filter(isJsonString).slice(0, 8) : [],
    });
  }
  return theses.slice(0, MAX_THESES_PER_RUN);
}

function contextVersion(context: JsonValue): string {
  return isJsonObject(context) && isJsonObject(context.snapshot) && isJsonString(context.snapshot.generated_at)
    ? context.snapshot.generated_at
    : 'missing-snapshot-version';
}

function latestThesisHashes(context: JsonValue) {
  const hashes = new Map<string, string>();
  if (!isJsonObject(context) || !isJsonObject(context.latest_thesis_input_sha256)) return hashes;
  for (const [key, value] of Object.entries(context.latest_thesis_input_sha256)) {
    if (isJsonString(value)) hashes.set(key, value);
  }
  return hashes;
}

function approvedTradeProposals(context: JsonValue): ApprovedTradeProposal[] {
  if (!isJsonObject(context) || !Array.isArray(context.approved_proposals)) return [];
  const proposals: ApprovedTradeProposal[] = [];
  for (const row of context.approved_proposals) {
    if (!isJsonObject(row) || !Number.isInteger(row.id) || !isJsonString(row.symbol)) continue;
    const side = row.side === 'buy' || row.side === 'sell' ? row.side : null;
    const notional = Number(row.notional);
    if (!side || !Number.isFinite(notional) || notional <= 0 || !isJsonString(row.rationale)) continue;
    const alerts = isJsonObject(row.broker_alerts) ? row.broker_alerts : {};
    const quantity = Number(alerts.position_quantity);
    const positionAction = ['open', 'add', 'reduce', 'exit'].includes(String(alerts.position_action))
      ? positionActionValue(String(alerts.position_action))
      : side === 'buy' ? 'open' : undefined;
    if (side === 'sell' && (!Number.isFinite(quantity) || quantity <= 0)) continue;
    proposals.push({
      id: Number(row.id),
      thesisId: isJsonString(row.thesis_id) ? row.thesis_id : null,
      symbol: row.symbol.trim().toUpperCase(),
      side,
      notional,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
      positionEpisodeId: isJsonString(alerts.position_episode_id) ? alerts.position_episode_id : undefined,
      positionAction,
      rationale: row.rationale,
      createdAt: isJsonString(row.created_at) ? row.created_at : '',
    });
  }
  return proposals.slice(0, 3);
}

function autonomousExecutionActive(context: JsonValue): boolean {
  if (!isJsonObject(context) || !Array.isArray(context.risk_controls)) return false;
  return context.risk_controls.some((row) =>
    isJsonObject(row)
    && row.control_key === 'autonomous-execution'
    && row.status === 'active'
    && row.enforcement_level === 'code');
}

function autonomousPositionManagementActive(context: JsonValue): boolean {
  if (!isJsonObject(context) || !Array.isArray(context.risk_controls)) return false;
  return context.risk_controls.some((row) =>
    isJsonObject(row)
    && row.control_key === 'autonomous-position-management'
    && row.status === 'active'
    && row.enforcement_level === 'code');
}

function firstRow(value: JsonValue): JsonObject | null {
  return Array.isArray(value) && isJsonObject(value[0]) ? value[0] : null;
}

function positionConfiguration(text: string): PositionConfiguration {
  const value = parseJson(text);
  if (
    !isJsonObject(value)
    || !isJsonString(value.positionKey)
    || !isJsonString(value.episodeId)
    || !isJsonString(value.symbol)
    || !isJsonString(value.accountKey)
    || (value.nextReviewAt !== null && !isJsonNumber(value.nextReviewAt))
  ) {
    throw new Error('Stored position configuration is invalid');
  }
  return {
    positionKey: value.positionKey,
    episodeId: value.episodeId,
    symbol: value.symbol,
    accountKey: value.accountKey,
    nextReviewAt: value.nextReviewAt,
  };
}

function autonomousExecutionResult(text: string): AutonomousExecutionResult {
  const value = parseJson(text);
  if (
    !isJsonObject(value)
    || !isJsonString(value.refId)
    || (value.status !== 'submitted' && value.status !== 'duplicate')
    || !isJsonString(value.accountKey)
    || !isJsonString(value.brokerOrderId)
    || !isJsonString(value.orderJson)
    || !isJsonString(value.reviewJson)
    || !isJsonString(value.submittedAt)
  ) {
    throw new Error('Stored autonomous execution result is invalid');
  }
  return {
    refId: value.refId,
    status: value.status,
    accountKey: value.accountKey,
    brokerOrderId: value.brokerOrderId,
    orderJson: value.orderJson,
    reviewJson: value.reviewJson,
    submittedAt: value.submittedAt,
  };
}

async function sha256<Value>(value: Value): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deterministicUuidV4(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function persistBrokerSnapshot(env: PublicationEnv, snapshot: BrokerAccountSnapshot): Promise<number> {
  const result = await cloudControl(env, 'record_account_snapshot', {
    snapshot: {
      observed_at: snapshot.observedAt,
      account_label: `Agentic ••••${snapshot.accountLast4}`,
      total_value: snapshot.totalValue,
      equity_value: snapshot.equityValue,
      cash: snapshot.cash,
      buying_power: snapshot.buyingPower,
      source: 'robinhood_mcp_cloudflare',
    },
    positions: snapshot.positions.map((position) => ({
      observed_at: snapshot.observedAt,
      account_last4: snapshot.accountLast4,
      symbol: position.symbol,
      quantity: position.quantity,
      average_buy_price: position.averageBuyPrice,
      source: 'robinhood_mcp_cloudflare',
    })),
  });
  const row = firstRow(result);
  if (!row || !Number.isInteger(row.id)) throw new Error('Account snapshot was not persisted');
  return Number(row.id);
}

function positionActionValue(value: string): ApprovedTradeProposal['positionAction'] {
  if (value === 'open' || value === 'add' || value === 'reduce' || value === 'exit') return value;
  return undefined;
}

function aiText<Result>(result: Result): string {
  const value = parseJson(JSON.stringify(result));
  if (isJsonString(value)) return value;
  if (isJsonObject(value) && isJsonString(value.response)) return value.response;
  return JSON.stringify(value);
}

function parseAiOutput<Result>(result: Result): JsonObject {
  const text = aiText(result).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  try {
    const parsed = parseJson(fenced || text);
    if (isJsonObject(parsed)) return parsed;
  } catch {
    // The output remains audit-only and cannot become a trade intent.
  }
  return { material_change: false, summary: text.slice(0, 4000), actions: [], risks: ['unstructured_model_output'] };
}

async function analyzeThesis(
  env: PublicationEnv,
  task: ResearchTask,
  decisionContext: JsonObject,
): Promise<JsonObject> {
  const liveMode = String(env.TRADING_ENABLED) === 'true';
  const prompt = [
    'You are a cautious investment decision classifier. You cannot call tools or place orders.',
    'Do not invent current facts, prices, filings, catalysts, earnings, or news.',
    'Use only the supplied canonical thesis and broker research context. Separate missing evidence from negative evidence.',
    liveMode
      ? 'A buy is permitted only for an explicitly evidenced, fresh catalyst or price/volume dislocation; otherwise return no_trade.'
      : 'This is a shadow run. Always return no_trade.',
    'Return strict JSON with keys: material_change (boolean), stance (bullish|bearish|neutral),',
    'confidence_delta (integer -10..10), summary (string), risks (string[]), actions (string[]),',
    'trade_decision (no_trade|buy), symbol (string), notional_percent (number 0..5),',
    'decision_confidence (integer 0..100), catalyst (string), invalidation (string),',
    'bull_case_pass (boolean), bear_case_answered (boolean), portfolio_risk_pass (boolean).',
    `Market slot: ${task.marketSlot}`,
    `Canonical context version: ${task.contextVersion}`,
    `Thesis: ${JSON.stringify(task.thesis)}`,
    `Broker and portfolio context: ${JSON.stringify(decisionContext)}`,
  ].join('\n');
  const result = await env.AI.run(
    AI_MODEL,
    {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.1,
      guided_json: {
        type: 'object',
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
        },
        required: [
          'material_change', 'stance', 'confidence_delta', 'summary', 'risks', 'actions',
          'trade_decision', 'symbol', 'notional_percent', 'decision_confidence', 'catalyst',
          'invalidation', 'bull_case_pass', 'bear_case_answered', 'portfolio_risk_pass',
        ],
      },
    },
    {
      gateway: {
        id: env.AI_GATEWAY_ID,
        skipCache: true,
        collectLog: true,
        metadata: { run_id: task.runId, thesis_id: task.thesis.id, prompt_version: PROMPT_VERSION },
        retries: { maxAttempts: 3, retryDelayMs: 500, backoff: 'exponential' },
      },
      tags: ['thesisforge', liveMode ? 'autonomous-decision' : 'shadow-research'],
    },
  );
  return parseAiOutput(result);
}

async function analyzePosition(
  env: PublicationEnv,
  task: PositionReviewTask,
  position: BrokerAccountSnapshot['positions'][number],
  snapshot: BrokerAccountSnapshot,
  brokerContext: JsonObject,
): Promise<JsonObject> {
  const prompt = [
    'You are a cautious position-management classifier. You cannot call tools or place orders.',
    'Use only the supplied broker context, position, and linked canonical theses. Do not invent facts.',
    'Recommend hold by default. Add requires a fresh positive catalyst and an intact hardening thesis.',
    'Reduce or exit requires specific adverse evidence or a confirmed thesis invalidation.',
    'Return strict JSON with keys: position_action (hold|add|reduce|exit), decision_confidence (0..100),',
    'thesis_state (intact|weakening|invalidated), summary (string), risks (string[]), catalyst (string),',
    'invalidation (string), add_percent (0..2), reduce_percent (0..100), invalidation_confirmed (boolean),',
    'adverse_evidence (boolean), bull_case_pass (boolean), bear_case_answered (boolean), portfolio_risk_pass (boolean).',
    `Review reason: ${task.reason}`,
    `Position: ${JSON.stringify(position)}`,
    `Portfolio: ${JSON.stringify({ total_value: snapshot.totalValue, buying_power: snapshot.buyingPower })}`,
    `Linked theses: ${JSON.stringify(task.theses || [])}`,
    `Broker context: ${JSON.stringify(brokerContext)}`,
  ].join('\n');
  const result = await env.AI.run(AI_MODEL, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 450,
    temperature: 0.1,
    guided_json: {
      type: 'object',
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
      },
      required: [
        'position_action', 'decision_confidence', 'thesis_state', 'summary', 'risks', 'catalyst',
        'invalidation', 'add_percent', 'reduce_percent', 'invalidation_confirmed', 'adverse_evidence',
        'bull_case_pass', 'bear_case_answered', 'portfolio_risk_pass',
      ],
    },
  }, {
    gateway: {
      id: env.AI_GATEWAY_ID, skipCache: true, collectLog: true,
      metadata: { run_id: task.runId, position_key: task.positionKey, prompt_version: PROMPT_VERSION },
      retries: { maxAttempts: 3, retryDelayMs: 500, backoff: 'exponential' },
    },
    tags: ['thesisforge', 'autonomous-position-management'],
  });
  return parseAiOutput(result);
}

export class CloudResearchWorkflow extends WorkflowEntrypoint<PublicationEnv, ResearchCycleParams> {
  async run(event: Readonly<WorkflowEvent<ResearchCycleParams>>, step: WorkflowStep): Promise<JsonObject> {
    const tradingEnabled = String(this.env.TRADING_ENABLED) === 'true';
    const brokerMode = String(this.env.BROKER_GATEWAY_MODE);
    if (tradingEnabled && brokerMode !== 'robinhood_mcp') throw new Error('Live trading requires the Robinhood MCP gateway');
    const scheduledTime = event.schedule?.scheduledTime ?? event.timestamp.getTime();
    const gate = await step.do('evaluate New York research window', async () =>
      marketGate(scheduledTime, event.payload.slot));
    const triggerKey = `cloud:${gate.date}:${gate.slot || event.instanceId}`;
    const source = event.schedule || event.payload.requestedBy === 'cron' ? 'schedule' : 'manual';

    const runRow = await step.do('register canonical cloud run', async () => {
      const result = await cloudControl(this.env, 'upsert_run', {
        trigger_key: triggerKey,
        trigger_source: source,
        market_slot: gate.slot,
        mode: tradingEnabled ? 'live' : 'shadow',
        status: gate.actionable || event.payload.force ? 'running' : 'skipped',
        scheduled_for: new Date(scheduledTime).toISOString(),
        actionable_window: gate.actionable,
        started_at: new Date().toISOString(),
        completed_at: gate.actionable || event.payload.force ? null : new Date().toISOString(),
        summary: { gate, requested_by: event.payload.requestedBy || source, trading_enabled: tradingEnabled },
        updated_at: new Date().toISOString(),
      });
      const row = firstRow(result);
      if (!row || !isJsonString(row.id)) throw new Error('Cloud control did not return a run id');
      return {
        id: row.id,
        startedAt: isJsonString(row.started_at) ? row.started_at : null,
      };
    });

    const runId = runRow.id;
    if (!gate.actionable && !event.payload.force) {
      return { run_id: runId, status: 'skipped', gate, trading_enabled: tradingEnabled };
    }

    const contextJson = await step.do('load bounded canonical research context', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '2 minutes',
    }, async () => JSON.stringify(await cloudControl(this.env, 'context')));
    const context = parseJson(contextJson);
    const theses = parseTheses(context);
    const snapshotVersion = contextVersion(context);
    const previousHashes = latestThesisHashes(context);
    const proposals = approvedTradeProposals(context);
    const executionActive = autonomousExecutionActive(context);
    const brokerReadiness = await step.do('refresh Agentic account state', {
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      timeout: '2 minutes',
    }, async () => {
      if (brokerMode !== 'robinhood_mcp') return { ready: false, reason: 'gateway_disabled' };
      const broker = this.env.ROBINHOOD_BROKER_AGENT.getByName('primary');
      const snapshot = await broker.readAccountSnapshot();
      const accountSnapshotId = await persistBrokerSnapshot(this.env, snapshot);
      return {
        ready: true,
        account_key: snapshot.accountKey,
        account_snapshot_id: accountSnapshotId,
        observed_at: snapshot.observedAt,
        today_agentic_order_count: snapshot.todayAgenticOrderCount,
        snapshot,
      };
    });

    const positionEpisodesJson = await step.do('reconcile canonical position episodes', async () => {
      if (!brokerReadiness.ready || !('snapshot' in brokerReadiness) || !brokerReadiness.snapshot) return '[]';
      const snapshot = brokerReadiness.snapshot;
      return JSON.stringify(await cloudControl(this.env, 'sync_position_episodes', {
        account_key: snapshot.accountKey,
        observed_at: snapshot.observedAt,
        positions: snapshot.positions.map((position) => ({
          symbol: position.symbol,
          quantity: position.quantity,
          average_buy_price: position.averageBuyPrice,
          monitor_policy: {
            policy_version: 'autonomous-position-v1',
            hard_loss_limit_percent: 8,
            max_total_position_percent: 5,
            max_add_percent_per_review: 2,
            max_reduce_percent_per_review: 50,
          },
        })),
      }));
    });
    const positionEpisodes: unknown = JSON.parse(positionEpisodesJson);

    const queued = await step.do('fan out thesis research tasks', async () => {
      const messages: MessageSendRequest<CloudTask>[] = [];
      let skipped = 0;
      for (const thesis of theses) {
        const idempotencyKey = `${runId}:thesis:${thesis.id}:${PROMPT_VERSION}`;
        const inputSha256 = await sha256({ thesis, snapshotVersion });
        const unchanged = !event.payload.force && previousHashes.get(thesis.id) === inputSha256;
        await cloudControl(this.env, 'upsert_task', {
          run_id: runId,
          idempotency_key: idempotencyKey,
          task_type: 'thesis_research',
          entity_type: 'thesis',
          entity_key: thesis.id,
          status: unchanged ? 'skipped' : 'queued',
          prompt_version: PROMPT_VERSION,
          input_sha256: inputSha256,
          output: unchanged ? { reason: 'canonical_thesis_context_unchanged', llm_invoked: false } : null,
          completed_at: unchanged ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        });
        if (unchanged) {
          skipped += 1;
          continue;
        }
        messages.push({ body: {
          kind: 'thesis_research', runId, idempotencyKey, thesis,
          contextVersion: snapshotVersion, marketSlot: gate.slot || 'manual',
        } });
      }
      if (messages.length > 0) await this.env.RESEARCH_TASK_QUEUE.sendBatch(messages);
      return { queued: messages.length, skipped };
    });

    const positionsQueued = await step.do('fan out position monitoring tasks', async () => {
      if (!brokerReadiness.ready || !('snapshot' in brokerReadiness) || !brokerReadiness.snapshot || !Array.isArray(positionEpisodes)) return 0;
      const snapshot = brokerReadiness.snapshot;
      const messages: MessageSendRequest<CloudTask>[] = [];
      for (const row of positionEpisodes) {
        if (!isJsonObject(row) || !isJsonString(row.id) || !isJsonString(row.symbol)) continue;
        const position = snapshot.positions.find((item) => item.symbol === row.symbol);
        if (!position || position.quantity <= 0) continue;
        const positionKey = `${snapshot.accountKey}:${position.symbol}`;
        const idempotencyKey = `${runId}:position:${position.symbol}:${PROMPT_VERSION}`;
        const relatedTheses: PositionThesis[] = theses
          .filter((thesis) => thesis.symbols.includes(position.symbol))
          .map((thesis) => ({
            id: thesis.id, name: thesis.name, status: thesis.status, stance: thesis.stance,
            confidence: thesis.confidence, symbols: thesis.symbols, falsifier: thesis.falsifier,
          }));
        const monitor = this.env.POSITION_MONITOR.getByName(positionKey);
        await monitor.configure({
          positionKey, episodeId: row.id, symbol: position.symbol,
          accountKey: snapshot.accountKey, nextReviewAt: null,
        });
        await cloudControl(this.env, 'upsert_task', {
          run_id: runId,
          idempotency_key: idempotencyKey,
          task_type: 'position_review',
          entity_type: 'position',
          entity_key: positionKey,
          status: 'queued',
          input_sha256: await sha256({ position, relatedTheses, observedAt: snapshot.observedAt }),
          queued_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        messages.push({ body: {
          kind: 'position_review', runId, idempotencyKey, positionKey,
          episodeId: row.id, symbol: position.symbol, theses: relatedTheses, reason: 'scheduled_position_review',
        } });
      }
      if (messages.length > 0) await this.env.RESEARCH_TASK_QUEUE.sendBatch(messages);
      return messages.length;
    });

    const executionQueued = await step.do('queue approved autonomous trade intents', async () => {
      if (!tradingEnabled || !executionActive) return 0;
      const messages: MessageSendRequest<CloudTask>[] = [];
      for (const proposal of proposals) {
        const idempotencyKey = `${runId}:trade-proposal:${proposal.id}`;
        await cloudControl(this.env, 'upsert_task', {
          run_id: runId,
          idempotency_key: idempotencyKey,
          task_type: 'trade_execution',
          entity_type: 'trade_proposal',
          entity_key: String(proposal.id),
          status: 'queued',
          input_sha256: await sha256(proposal),
          queued_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        messages.push({ body: { kind: 'trade_execution', runId, idempotencyKey, proposal } });
      }
      if (messages.length > 0) await this.env.RESEARCH_TASK_QUEUE.sendBatch(messages);
      return messages.length;
    });

    await step.do('record orchestration completion', async () => {
      await cloudControl(this.env, 'upsert_run', {
        trigger_key: triggerKey,
        trigger_source: source,
        market_slot: gate.slot,
        mode: tradingEnabled ? 'live' : 'shadow',
        status: 'running',
        scheduled_for: new Date(scheduledTime).toISOString(),
        actionable_window: gate.actionable,
        started_at: runRow.startedAt || new Date().toISOString(),
        completed_at: null,
        summary: {
          gate,
          orchestration_complete: true,
          queued_tasks: queued.queued,
          queued_trade_intents: executionQueued,
          queued_position_reviews: positionsQueued,
          unchanged_tasks: queued.skipped,
          broker_gateway: brokerMode,
          broker_readiness: brokerReadiness,
          trading_enabled: tradingEnabled,
        },
        updated_at: new Date().toISOString(),
      });
      if (queued.queued === 0 && executionQueued === 0) {
        await finalizeRunAndPublish(this.env, runId);
      }
    });

    return {
      run_id: runId,
      status: 'complete',
      queued_tasks: queued.queued,
      queued_trade_intents: executionQueued,
      queued_position_reviews: positionsQueued,
      unchanged_tasks: queued.skipped,
      gate,
      trading_enabled: tradingEnabled,
    };
  }
}

export class ThesisCoordinator extends DurableObject<PublicationEnv> {
  constructor(ctx: DurableObjectState, env: PublicationEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS analyses (
          job_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          output_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS coordinator_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }

  recordAnalysis(jobId: string, runId: string, output: JsonObject): DeduplicationResult {
    const existing = this.ctx.storage.sql.exec<{ job_id: string }>(
      'SELECT job_id FROM analyses WHERE job_id = ?', jobId,
    ).toArray()[0];
    if (existing) return { duplicate: true };
    const createdAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      'INSERT INTO analyses(job_id, run_id, output_json, created_at) VALUES (?, ?, ?, ?)',
      jobId, runId, JSON.stringify(output), createdAt,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO coordinator_state(key, value) VALUES ('latest', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify({ jobId, runId, output, createdAt }),
    );
    return { duplicate: false };
  }

  getLatest(): JsonObject | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM coordinator_state WHERE key = 'latest'",
    ).toArray()[0];
    if (!row) return null;
    const value = parseJson(row.value);
    return isJsonObject(value) ? value : null;
  }
}

export class PositionMonitor extends DurableObject<PublicationEnv> {
  constructor(ctx: DurableObjectState, env: PublicationEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS monitor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS observations (
          event_id TEXT PRIMARY KEY,
          observed_at TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          evidence_json TEXT NOT NULL
        );
      `);
    });
  }

  async configure(configuration: PositionConfiguration): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO monitor_state(key, value) VALUES ('configuration', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(configuration),
    );
    if (configuration.nextReviewAt === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(configuration.nextReviewAt);
  }

  recordObservation(observation: PositionObservation): DeduplicationResult {
    const existing = this.ctx.storage.sql.exec<{ event_id: string }>(
      'SELECT event_id FROM observations WHERE event_id = ?', observation.eventId,
    ).toArray()[0];
    if (existing) return { duplicate: true };
    this.ctx.storage.sql.exec(
      'INSERT INTO observations(event_id, observed_at, recommendation, evidence_json) VALUES (?, ?, ?, ?)',
      observation.eventId, observation.observedAt, observation.recommendation, JSON.stringify(observation.evidence),
    );
    return { duplicate: false };
  }

  getPolicyHistory(): PositionHistory {
    const rows = this.ctx.storage.sql.exec<{ observed_at: string; recommendation: string; evidence_json: string }>(
      'SELECT observed_at, recommendation, evidence_json FROM observations ORDER BY observed_at DESC LIMIT 200',
    ).toArray();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    let addsToday = 0;
    let addsLifetime = 0;
    let reductionsToday = 0;
    let lastAddAt: string | null = null;
    for (const row of rows) {
      const action = row.recommendation;
      const rowDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(row.observed_at));
      if (action === 'add') {
        addsLifetime += 1;
        if (rowDay === today) addsToday += 1;
        if (!lastAddAt) lastAddAt = row.observed_at;
      }
      if (action === 'reduce' && rowDay === today) reductionsToday += 1;
    }
    return { addsToday, addsLifetime, reductionsToday, lastAddAt };
  }

  async alarm(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM monitor_state WHERE key = 'configuration'",
    ).toArray()[0];
    if (!row) return;
    const configuration = positionConfiguration(row.value);
    const now = new Date();
    const triggerKey = `position-alarm:${configuration.positionKey}:${now.toISOString()}`;
    const run = firstRow(await cloudControl(this.env, 'upsert_run', {
      trigger_key: triggerKey,
      trigger_source: 'event',
      market_slot: 'position_alarm',
      mode: String(this.env.TRADING_ENABLED) === 'true' ? 'live' : 'shadow',
      status: 'running',
      scheduled_for: now.toISOString(),
      actionable_window: false,
      started_at: now.toISOString(),
      summary: { position_key: configuration.positionKey, trading_enabled: String(this.env.TRADING_ENABLED) === 'true' },
      updated_at: now.toISOString(),
    }));
    if (!run || !isJsonString(run.id)) throw new Error('Position alarm could not create a canonical run');
    await this.env.RESEARCH_TASK_QUEUE.send({
      kind: 'position_review',
      runId: run.id,
      idempotencyKey: `${configuration.positionKey}:alarm:${Date.now()}`,
      positionKey: configuration.positionKey,
      episodeId: configuration.episodeId,
      symbol: configuration.symbol,
      reason: 'position_monitor_alarm',
    } satisfies PositionReviewTask);
  }
}

export class BrokerExecutionCoordinator extends DurableObject<PublicationEnv> {
  constructor(ctx: DurableObjectState, env: PublicationEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS intents (
          intent_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS live_intents (
          intent_id TEXT PRIMARY KEY,
          request_sha256 TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    });
  }

  reserveShadowIntent(intentId: string): ShadowIntentReservation {
    const existing = this.ctx.storage.sql.exec<{ intent_id: string }>(
      'SELECT intent_id FROM intents WHERE intent_id = ?', intentId,
    ).toArray()[0];
    if (!existing) {
      this.ctx.storage.sql.exec(
        'INSERT INTO intents(intent_id, status, created_at) VALUES (?, ?, ?)',
        intentId, 'blocked_no_broker_gateway', new Date().toISOString(),
      );
    }
    return { intentId, status: 'blocked_no_broker_gateway', duplicate: Boolean(existing) };
  }

  async executeLiveIntent(
    intentId: string,
    requestSha256: string,
    intent: AutonomousEquityIntent,
  ): Promise<AutonomousExecutionResult> {
    const existing = this.ctx.storage.sql.exec<{
      request_sha256: string;
      status: string;
      result_json: string | null;
    }>('SELECT request_sha256, status, result_json FROM live_intents WHERE intent_id = ?', intentId).toArray()[0];
    if (existing) {
      if (existing.request_sha256 !== requestSha256) throw new Error('Intent id was reused with different content');
      if (existing.status === 'submitted' && existing.result_json) {
        return autonomousExecutionResult(existing.result_json);
      }
      throw new Error('Intent is already reserved or blocked');
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      'INSERT INTO live_intents(intent_id, request_sha256, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      intentId, requestSha256, 'reserved', now, now,
    );
    try {
      const broker = this.env.ROBINHOOD_BROKER_AGENT.getByName('primary');
      const result = await broker.executeAutonomousEquityIntent(intent);
      const resultJson = JSON.stringify(result);
      this.ctx.storage.sql.exec(
        'UPDATE live_intents SET status = ?, result_json = ?, updated_at = ? WHERE intent_id = ?',
        'submitted', resultJson, new Date().toISOString(), intentId,
      );
      return result;
    } catch (error) {
      this.ctx.storage.sql.exec(
        'UPDATE live_intents SET status = ?, updated_at = ? WHERE intent_id = ?',
        'blocked', new Date().toISOString(), intentId,
      );
      throw error;
    }
  }
}

async function processResearchTask(env: PublicationEnv, task: ResearchTask, attempts: number): Promise<void> {
  await cloudControl(env, 'upsert_task', {
    run_id: task.runId,
    idempotency_key: task.idempotencyKey,
    task_type: 'thesis_research',
    entity_type: 'thesis',
    entity_key: task.thesis.id,
    status: 'running',
    attempt_count: attempts,
    prompt_version: PROMPT_VERSION,
    input_sha256: await sha256({ thesis: task.thesis, snapshotVersion: task.contextVersion }),
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await finalizeRunAndPublish(env, task.runId);
  let brokerContext: JsonObject = {};
  let snapshot: BrokerAccountSnapshot | null = null;
  if (String(env.BROKER_GATEWAY_MODE) === 'robinhood_mcp') {
    const broker = env.ROBINHOOD_BROKER_AGENT.getByName('primary');
    const [researchJson, accountSnapshot] = await Promise.all([
      broker.readEquityResearchContext(task.thesis.symbols),
      broker.readAccountSnapshot(),
    ]);
    const parsed = parseJson(researchJson);
    if (!isJsonObject(parsed)) throw new Error('Broker research context was invalid');
    brokerContext = parsed;
    snapshot = accountSnapshot;
  }
  const decisionContext: JsonObject = {
    broker: brokerContext,
    portfolio: snapshot ? {
      observed_at: snapshot.observedAt,
      total_value: snapshot.totalValue,
      buying_power: snapshot.buyingPower,
      positions: snapshot.positions,
      today_agentic_order_count: snapshot.todayAgenticOrderCount,
      today_agentic_order_notional: snapshot.todayAgenticOrderNotional,
    } : null,
  };
  const output = await analyzeThesis(env, task, decisionContext);
  const coordinator = env.THESIS_COORDINATOR.getByName(task.thesis.id);
  const recorded = await coordinator.recordAnalysis(task.idempotencyKey, task.runId, output);
  let approvedProposalId: number | null = null;
  if (!recorded.duplicate && snapshot && String(env.TRADING_ENABLED) === 'true') {
    const candidate = approvedCandidate(task, output, brokerContext, snapshot);
    if (candidate) {
      const proposal = firstRow(await cloudControl(env, 'create_trade_proposal', {
        thesis_id: task.thesis.id,
        symbol: candidate.symbol,
        side: 'buy',
        notional: candidate.notional,
        order_type: 'dollar_market_regular_hours',
        status: 'approved',
        rationale: candidate.rationale,
        created_at: new Date().toISOString(),
        reviewed_at: new Date().toISOString(),
        broker_alerts: {
          autonomous_source: 'cloudflare_workers_ai',
          run_id: task.runId,
          thesis_task: task.idempotencyKey,
          evidence: candidate.evidence,
        },
      }));
      if (!proposal || !Number.isInteger(proposal.id)) throw new Error('Approved proposal could not be persisted');
      approvedProposalId = Number(proposal.id);
      await env.RESEARCH_TASK_QUEUE.send({
        kind: 'trade_execution',
        runId: task.runId,
        idempotencyKey: `${task.runId}:trade-proposal:${approvedProposalId}`,
        proposal: {
          id: approvedProposalId,
          thesisId: task.thesis.id,
          symbol: candidate.symbol,
          side: 'buy',
          notional: candidate.notional,
          positionAction: 'open',
          rationale: candidate.rationale,
          createdAt: new Date().toISOString(),
        },
      } satisfies TradeExecutionTask);
    }
  }
  await cloudControl(env, 'upsert_task', {
    run_id: task.runId,
    idempotency_key: task.idempotencyKey,
    task_type: 'thesis_research',
    entity_type: 'thesis',
    entity_key: task.thesis.id,
    status: 'complete',
    attempt_count: attempts,
    prompt_version: PROMPT_VERSION,
    input_sha256: await sha256({ thesis: task.thesis, snapshotVersion: task.contextVersion }),
    output: { ...output, approved_proposal_id: approvedProposalId },
    ai_gateway_log_id: env.AI.aiGatewayLogId,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await finalizeRunAndPublish(env, task.runId);
}

async function processPositionTask(env: PublicationEnv, task: PositionReviewTask, attempts: number): Promise<void> {
  const startedAt = new Date().toISOString();
  if (!task.episodeId || !task.symbol) throw new Error('Position review is missing its canonical episode');
  await cloudControl(env, 'upsert_task', {
    run_id: task.runId,
    idempotency_key: task.idempotencyKey,
    task_type: 'position_review',
    entity_type: 'position',
    entity_key: task.positionKey,
    status: 'running',
    attempt_count: attempts,
    prompt_version: PROMPT_VERSION,
    input_sha256: await sha256(task),
    started_at: startedAt,
    updated_at: startedAt,
  });
  const broker = env.ROBINHOOD_BROKER_AGENT.getByName('primary');
  const [snapshot, researchJson] = await Promise.all([
    broker.readAccountSnapshot(),
    broker.readEquityResearchContext([task.symbol]),
  ]);
  const brokerContextValue = parseJson(researchJson);
  if (!isJsonObject(brokerContextValue)) throw new Error('Broker position context was invalid');
  const position = snapshot.positions.find((item) => item.symbol === task.symbol && item.quantity > 0);
  if (!position) {
    await cloudControl(env, 'patch_position_episode', {
      id: task.episodeId, status: 'closed', quantity: 0, closed_at: snapshot.observedAt,
      next_review_at: null, updated_at: snapshot.observedAt,
    });
    await cloudControl(env, 'upsert_task', {
      run_id: task.runId, idempotency_key: task.idempotencyKey, task_type: 'position_review',
      entity_type: 'position', entity_key: task.positionKey, status: 'complete', attempt_count: attempts,
      output: { recommendation: 'exit', reason: 'broker_position_closed' },
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    await finalizeRunAndPublish(env, task.runId);
    return;
  }
  const monitor = env.POSITION_MONITOR.getByName(task.positionKey);
  const history = await monitor.getPolicyHistory();
  const modelOutput = await analyzePosition(env, task, position, snapshot, brokerContextValue);
  const decision = decidePositionAction(position, snapshot, task.theses || [], modelOutput, brokerContextValue, history);
  const observedAt = new Date().toISOString();
  const recorded = await monitor.recordObservation({
    eventId: task.idempotencyKey,
    observedAt,
    recommendation: decision.action,
    evidence: { ...decision.evidence, model: modelOutput, rationale: decision.rationale },
  });
  if (!recorded.duplicate) {
    await cloudControl(env, 'record_position_monitor_event', {
      position_episode_id: task.episodeId,
      event_type: task.reason,
      recommendation: decision.action,
      evidence: { ...decision.evidence, model: modelOutput, rationale: decision.rationale },
      observed_at: observedAt,
    });
  }

  let approvedProposalId: number | null = null;
  const positionAction = decision.action === 'add' || decision.action === 'reduce' || decision.action === 'exit'
    ? decision.action
    : null;
  if (!recorded.duplicate && positionAction && String(env.TRADING_ENABLED) === 'true') {
    const executionContext = await cloudControl(env, 'context');
    if (autonomousExecutionActive(executionContext) && autonomousPositionManagementActive(executionContext)) {
      const side = positionAction === 'add' ? 'buy' : 'sell';
      const quantity = side === 'sell' ? decision.quantity : undefined;
      const notional = side === 'buy'
        ? Number(decision.dollarAmount)
        : Math.floor(Number(quantity) * Number(decision.evidence.last) * 100) / 100;
      if (Number.isFinite(notional) && notional > 0) {
        const proposal = firstRow(await cloudControl(env, 'create_trade_proposal', {
          thesis_id: isJsonString(decision.evidence.thesis_id) ? decision.evidence.thesis_id : null,
          symbol: decision.symbol,
          side,
          notional,
          order_type: side === 'buy' ? 'dollar_market_regular_hours' : 'quantity_market_regular_hours',
          status: 'approved',
          rationale: decision.rationale,
          created_at: observedAt,
          reviewed_at: observedAt,
          broker_alerts: {
            autonomous_source: 'cloudflare_position_monitor',
            run_id: task.runId,
            position_episode_id: task.episodeId,
            position_action: positionAction,
            position_quantity: quantity,
            evidence: decision.evidence,
          },
        }));
        if (!proposal || !Number.isInteger(proposal.id)) throw new Error('Position proposal could not be persisted');
        approvedProposalId = Number(proposal.id);
        await env.RESEARCH_TASK_QUEUE.send({
          kind: 'trade_execution', runId: task.runId,
          idempotencyKey: `${task.runId}:trade-proposal:${approvedProposalId}`,
          proposal: {
            id: approvedProposalId,
            thesisId: isJsonString(decision.evidence.thesis_id) ? decision.evidence.thesis_id : null,
            symbol: decision.symbol,
            side,
            notional,
            quantity,
            positionEpisodeId: task.episodeId,
            positionAction,
            rationale: decision.rationale,
            createdAt: observedAt,
          },
        } satisfies TradeExecutionTask);
      }
    }
  }
  await cloudControl(env, 'upsert_task', {
    run_id: task.runId,
    idempotency_key: task.idempotencyKey,
    task_type: 'position_review',
    entity_type: 'position',
    entity_key: task.positionKey,
    status: 'complete',
    attempt_count: attempts,
    prompt_version: PROMPT_VERSION,
    input_sha256: await sha256(task),
    output: { ...modelOutput, deterministic_decision: decision, approved_proposal_id: approvedProposalId },
    ai_gateway_log_id: env.AI.aiGatewayLogId,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await finalizeRunAndPublish(env, task.runId);
}

async function processTradeExecutionTask(
  env: PublicationEnv,
  task: TradeExecutionTask,
  attempts: number,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const proposal = task.proposal;
  if (String(env.TRADING_ENABLED) !== 'true') throw new Error('Autonomous trading is disabled');
  const executionContext = await cloudControl(env, 'context');
  if (!autonomousExecutionActive(executionContext)) {
    throw new Error('Autonomous execution risk control is not active');
  }
  await cloudControl(env, 'upsert_task', {
    run_id: task.runId,
    idempotency_key: task.idempotencyKey,
    task_type: 'trade_execution',
    entity_type: 'trade_proposal',
    entity_key: String(proposal.id),
    status: 'running',
    attempt_count: attempts,
    input_sha256: await sha256(proposal),
    started_at: startedAt,
    updated_at: startedAt,
  });
  const proposalAge = Date.now() - Date.parse(proposal.createdAt);
  if (!Number.isFinite(proposalAge) || proposalAge < 0 || proposalAge > 6 * 60 * 60 * 1_000) {
    throw new Error('Approved trade proposal is stale');
  }
  const positionAction = proposal.positionAction || (proposal.side === 'buy' ? 'open' : undefined);
  if (!positionAction) throw new Error('Approved proposal is missing its position action');
  if (positionAction !== 'open' && !autonomousPositionManagementActive(executionContext)) {
    throw new Error('Autonomous position-management risk control is not active');
  }
  if (proposal.side === 'sell' && (!Number.isFinite(proposal.quantity) || Number(proposal.quantity) <= 0)) {
    throw new Error('Approved sell proposal is missing its share quantity');
  }
  const broker = env.ROBINHOOD_BROKER_AGENT.getByName('primary');
  const snapshot = await broker.readAccountSnapshot();
  const accountSnapshotId = await persistBrokerSnapshot(env, snapshot);
  const refId = await deterministicUuidV4(task.idempotencyKey);
  const rationaleSha256 = await sha256({ rationale: proposal.rationale, proposalId: proposal.id });
  const policy = {
    version: 'autonomous-equity-v2',
    maxTradePercent: 5,
    maxDailyNotionalPercent: 20,
    maxTradesPerDay: 3,
    maxSpreadBps: 80,
    quoteMaxAgeSeconds: 120,
    executionWindow: '09:45-15:45 America/New_York',
  };
  const policySha256 = await sha256(policy);
  const brokerIntent: AutonomousEquityIntent = {
    refId,
    symbol: proposal.symbol,
    side: proposal.side,
    positionAction,
    ...(proposal.side === 'buy' ? { dollarAmount: proposal.notional } : { quantity: proposal.quantity }),
    rationaleSha256,
    maxTradePercent: policy.maxTradePercent,
    maxDailyNotionalPercent: policy.maxDailyNotionalPercent,
    maxTradesPerDay: policy.maxTradesPerDay,
    maxSpreadBps: policy.maxSpreadBps,
  };
  const requestFingerprint = await sha256(brokerIntent);
  const intentRow = firstRow(await cloudControl(env, 'upsert_trade_intent', {
    trade_proposal_id: proposal.id,
    position_episode_id: proposal.positionEpisodeId || null,
    account_key: snapshot.accountKey,
    broker_ref_id: refId,
    mode: 'live',
    status: 'confirmed',
    symbol: proposal.symbol,
    side: proposal.side,
    notional: proposal.side === 'buy' ? proposal.notional : null,
    quantity: proposal.side === 'sell' ? proposal.quantity : null,
    order_type: 'market',
    time_in_force: 'gfd',
    account_snapshot_id: accountSnapshotId,
    policy_sha256: policySha256,
    gate_results: {
      autonomous_execution_control: 'active',
      proposal_status: 'approved',
      proposal_age_ms: proposalAge,
      policy,
    },
    confirmation_actor: 'autonomous_policy:equity-v2',
    confirmed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  if (!intentRow || !isJsonString(intentRow.id)) throw new Error('Trade intent could not be persisted');
  const tradeIntentId = intentRow.id;
  await cloudControl(env, 'upsert_execution_attempt', {
    trade_intent_id: tradeIntentId,
    attempt_number: 1,
    request_fingerprint: requestFingerprint,
    status: 'started',
    started_at: startedAt,
  });

  try {
    const coordinator = env.BROKER_EXECUTION_COORDINATOR.getByName(snapshot.accountKey);
    const execution = await coordinator.executeLiveIntent(tradeIntentId, requestFingerprint, brokerIntent);
    const orderId = execution.brokerOrderId;
    const orderPayload = parseJson(execution.orderJson);
    const reviewPayload = parseJson(execution.reviewJson);
    if (!isJsonObject(orderPayload) || !isJsonObject(reviewPayload)) throw new Error('Broker returned an invalid audit payload');
    await cloudControl(env, 'upsert_trade_intent', {
      trade_proposal_id: proposal.id,
      position_episode_id: proposal.positionEpisodeId || null,
      account_key: snapshot.accountKey,
      broker_ref_id: refId,
      mode: 'live',
      status: 'submitted',
      symbol: proposal.symbol,
      side: proposal.side,
      notional: proposal.side === 'buy' ? proposal.notional : null,
      quantity: proposal.side === 'sell' ? proposal.quantity : null,
      order_type: 'market',
      time_in_force: 'gfd',
      account_snapshot_id: accountSnapshotId,
      policy_sha256: policySha256,
      gate_results: { policy, autonomous_execution_control: 'active', broker_submission: 'accepted' },
      review_payload: reviewPayload,
      reviewed_quote_at: execution.submittedAt,
      confirmation_actor: 'autonomous_policy:equity-v2',
      confirmed_at: startedAt,
      broker_order_id: orderId,
      updated_at: new Date().toISOString(),
    });
    await cloudControl(env, 'upsert_execution_attempt', {
      trade_intent_id: tradeIntentId,
      attempt_number: 1,
      request_fingerprint: requestFingerprint,
      status: 'succeeded',
      broker_order_id: orderId,
      response_payload: orderPayload,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
    const executions = Array.isArray(orderPayload.executions) ? orderPayload.executions.filter(isJsonObject) : [];
    const fills = [];
    for (let index = 0; index < executions.length; index += 1) {
      const execution = executions[index];
      const quantity = Number(execution.quantity);
      const price = Number(execution.price);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) continue;
      fills.push({
        trade_intent_id: tradeIntentId,
        broker_fill_id: isJsonString(execution.id) ? execution.id : `${orderId}:${index}:${String(execution.timestamp || '')}`,
        broker_order_id: orderId,
        quantity,
        price,
        executed_at: String(execution.timestamp || execution.executed_at || execution.updated_at || new Date().toISOString()),
        payload: execution,
      });
    }
    if (fills.length > 0) await cloudControl(env, 'record_broker_fills', { fills });
    if (proposal.positionEpisodeId) {
      await cloudControl(env, 'patch_position_episode', {
        id: proposal.positionEpisodeId,
        status: positionAction === 'exit' ? 'closing' : 'open',
        next_review_at: null,
        last_recommendation: { recommendation: positionAction, submitted_at: execution.submittedAt, broker_order_id: orderId },
        updated_at: new Date().toISOString(),
      });
    }
    await cloudControl(env, 'update_trade_proposal', {
      id: proposal.id,
      status: 'submitted',
      reviewed_at: new Date().toISOString(),
      broker_alerts: { execution: 'submitted', broker_order_id: orderId, ref_id: refId },
    });
    await cloudControl(env, 'upsert_task', {
      run_id: task.runId,
      idempotency_key: task.idempotencyKey,
      task_type: 'trade_execution',
      entity_type: 'trade_proposal',
      entity_key: String(proposal.id),
      status: 'complete',
      attempt_count: attempts,
      input_sha256: await sha256(proposal),
      output: { execution: 'submitted', broker_order_id: orderId, ref_id: refId },
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    const errorText = error instanceof Error ? error.message : 'unknown';
    await cloudControl(env, 'upsert_execution_attempt', {
      trade_intent_id: tradeIntentId,
      attempt_number: 1,
      request_fingerprint: requestFingerprint,
      status: 'failed',
      error_text: errorText,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
    await cloudControl(env, 'upsert_trade_intent', {
      trade_proposal_id: proposal.id,
      position_episode_id: proposal.positionEpisodeId || null,
      account_key: snapshot.accountKey,
      broker_ref_id: refId,
      mode: 'live',
      status: 'blocked',
      symbol: proposal.symbol,
      side: proposal.side,
      notional: proposal.side === 'buy' ? proposal.notional : null,
      quantity: proposal.side === 'sell' ? proposal.quantity : null,
      order_type: 'market',
      time_in_force: 'gfd',
      account_snapshot_id: accountSnapshotId,
      policy_sha256: policySha256,
      gate_results: { policy, autonomous_execution_control: 'active', blocked_reason: errorText },
      confirmation_actor: 'autonomous_policy:equity-v2',
      confirmed_at: startedAt,
      updated_at: new Date().toISOString(),
    });
    await cloudControl(env, 'update_trade_proposal', {
      id: proposal.id,
      status: 'blocked',
      reviewed_at: new Date().toISOString(),
      broker_alerts: { execution: 'blocked', reason: errorText, ref_id: refId },
    });
    await cloudControl(env, 'upsert_task', {
      run_id: task.runId,
      idempotency_key: task.idempotencyKey,
      task_type: 'trade_execution',
      entity_type: 'trade_proposal',
      entity_key: String(proposal.id),
      status: 'failed',
      attempt_count: attempts,
      input_sha256: await sha256(proposal),
      error_text: errorText,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  await finalizeRunAndPublish(env, task.runId);
}

const worker = {
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: PublicationEnv): Promise<void> {
    const gate = marketGate(controller.scheduledTime);
    if (!gate.actionable || !gate.slot) {
      console.log(JSON.stringify({ event: 'cloud_schedule_skipped', cron: controller.cron, gate }));
      return;
    }
    try {
      const instance = await env.CLOUD_RESEARCH_CYCLE.create({
        id: `cloud-${gate.date}-${gate.slot}`,
        params: { requestedBy: 'cron', slot: gate.slot },
      });
      console.log(JSON.stringify({ event: 'cloud_workflow_created', instanceId: instance.id, gate }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      if (message.toLowerCase().includes('already')) {
        console.warn(JSON.stringify({ event: 'cloud_workflow_duplicate', gate }));
        return;
      }
      throw error;
    }
  },
  async queue(batch: MessageBatch<CloudTask>, env: PublicationEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === 'thesis_research') await processResearchTask(env, message.body, message.attempts);
        else if (message.body.kind === 'position_review') await processPositionTask(env, message.body, message.attempts);
        else await processTradeExecutionTask(env, message.body, message.attempts);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'cloud_task_failed',
          messageId: message.id,
          attempt: message.attempts,
          kind: message.body.kind,
          error: error instanceof Error ? error.message : 'unknown',
        }));
        if (message.attempts >= 4) {
          await cloudControl(env, 'upsert_task', {
            run_id: message.body.runId,
            idempotency_key: message.body.idempotencyKey,
            task_type: message.body.kind,
            entity_type: message.body.kind === 'thesis_research'
              ? 'thesis'
              : message.body.kind === 'position_review' ? 'position' : 'trade_proposal',
            entity_key: message.body.kind === 'thesis_research'
              ? message.body.thesis.id
              : message.body.kind === 'position_review' ? message.body.positionKey : String(message.body.proposal.id),
            status: 'failed',
            attempt_count: message.attempts,
            error_text: error instanceof Error ? error.message : 'unknown',
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          await finalizeRunAndPublish(env, message.body.runId);
        }
        message.retry({ delaySeconds: Math.min(900, 30 * (2 ** Math.min(message.attempts, 5))) });
      }
    }
  },
} satisfies ExportedHandler<PublicationEnv, CloudTask>;

export default worker;
