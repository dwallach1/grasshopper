import { z } from 'zod';

import { asOptionalNumber, asSmallint, requireIso } from './numbers';
import { parseRunNotes } from './run-notes';
import { parseThesisStatus } from './thesis-status';
import type {
  AccountRow,
  AgentRunRow,
  AutomationRow,
  CatalystRow,
  CloudRunRow,
  CloudTaskRow,
  CycleRow,
  ExposureRow,
  FillRow,
  InsightRow,
  IntentRow,
  LessonRow,
  OntologyActionRow,
  OntologyCandidateRow,
  OntologySymbolRow,
  OntologyThemeRow,
  PositionRow,
  PostmortemRow,
  PredictionRow,
  ProposalRow,
  QueueRow,
  RiskControlRow,
  RunRow,
  StrategyTestRow,
  TestScenarioRow,
  ThesisEvidenceRow,
  ThesisRelationRow,
  ThesisRow,
  ThesisScoreRow,
} from './ledger-types';

const JsonObjectSchema = z.object({}).passthrough();
export type JsonObjectRow = z.infer<typeof JsonObjectSchema>;

const Timestamp = z.union([z.string(), z.date()]).transform((value) => requireIso(value, 'timestamp'));
const OptionalTimestamp = z
  .union([z.string(), z.date(), z.null()])
  .transform((value) => (value === null ? null : requireIso(value, 'timestamp')));
const Numeric = z.union([z.string(), z.number()]).transform((value) => asSmallint(value, 'smallint'));
const Money = z.union([z.string(), z.number()]).transform((value) => Number(value));
const OptionalMoney = z
  .union([z.string(), z.number(), z.null()])
  .transform((value) => asOptionalNumber(value, 'numeric'));
const Id = z.union([z.string(), z.number()]).transform((value) => Number(value));
const Bool = z.union([z.boolean(), z.number()]).transform((value) => value === true || value === 1);

export const ThesisSymbolLinkSchema = z
  .object({
    thesis_id: z.string(),
    symbol: z.string(),
  })
  .passthrough();

export const ThesisRawSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    status: z.string(),
    confidence: z.union([z.string(), z.number()]),
    time_horizon: z.string(),
    stance: z.string(),
    variant_perception: z.string().nullable(),
    falsifier: z.string().nullable(),
    created_at: z.union([z.string(), z.date()]),
    updated_at: z.union([z.string(), z.date()]),
  })
  .passthrough();

export function mapThesis(row: z.infer<typeof ThesisRawSchema>, symbols: string[]): ThesisRow {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    status: parseThesisStatus(row.status),
    confidence: asSmallint(row.confidence, 'thesis.confidence'),
    time_horizon: row.time_horizon,
    stance: row.stance,
    variant_perception: row.variant_perception,
    falsifier: row.falsifier,
    created_at: requireIso(row.created_at, 'thesis.created_at'),
    updated_at: requireIso(row.updated_at, 'thesis.updated_at'),
    symbols,
  };
}

const EvidenceSchema = z
  .object({
    id: Id,
    thesis_id: z.string(),
    evidence_type: z.string(),
    direction: z.string(),
    summary: z.string(),
    source_url: z.string().nullable(),
    confidence: z.union([z.string(), z.number()]),
    created_at: Timestamp,
  })
  .passthrough();

export function mapEvidence(rows: JsonObjectRow[]): ThesisEvidenceRow[] {
  return z.array(EvidenceSchema).parse(rows).map((row) => ({
    id: row.id,
    thesis_id: row.thesis_id,
    evidence_type: row.evidence_type,
    direction: row.direction,
    summary: row.summary,
    source_url: row.source_url,
    confidence: asSmallint(row.confidence, 'evidence.confidence'),
    created_at: row.created_at,
  }));
}

const ScoreSchema = z
  .object({
    id: Id,
    thesis_id: z.string(),
    scored_at: Timestamp,
    confidence: Numeric,
    momentum: Numeric,
    evidence_quality: Numeric,
    catalyst_strength: Numeric,
    portfolio_fit: Numeric,
    risk: Numeric,
    notes: z.string().nullable(),
  })
  .passthrough();

export function mapScores(rows: JsonObjectRow[]): ThesisScoreRow[] {
  return z.array(ScoreSchema).parse(rows);
}

const RelationSchema = z
  .object({
    src_thesis_id: z.string(),
    dst_thesis_id: z.string(),
    relation_type: z.string(),
    strength: Money,
    rationale: z.string(),
  })
  .passthrough();

export function mapRelations(rows: JsonObjectRow[]): ThesisRelationRow[] {
  return z.array(RelationSchema).parse(rows);
}

const RunSchema = z
  .object({
    id: Id,
    run_type: z.string(),
    started_at: Timestamp,
    completed_at: OptionalTimestamp,
    notes: z.string().nullable(),
  })
  .passthrough();

export function mapRuns(rows: JsonObjectRow[]): RunRow[] {
  return z.array(RunSchema).parse(rows).map((row) => ({
    ...row,
    parsed: parseRunNotes(row.notes, row.run_type, row.completed_at !== null),
  }));
}

const CloudRunSchema = z
  .object({
    id: z.string(),
    trigger_key: z.string(),
    trigger_source: z.string(),
    market_slot: z.string().nullable(),
    mode: z.string(),
    status: z.string(),
    scheduled_for: OptionalTimestamp,
    started_at: OptionalTimestamp,
    completed_at: OptionalTimestamp,
    error_text: z.string().nullable(),
    summary: z.union([
      z.string(),
      z.object({}).passthrough().transform((value) => JSON.stringify(value)),
    ]),
  })
  .passthrough();

export function mapCloudRuns(rows: JsonObjectRow[]): CloudRunRow[] {
  return z.array(CloudRunSchema).parse(rows);
}

const CloudTaskSchema = z
  .object({
    id: z.string(),
    run_id: z.string(),
    task_type: z.string(),
    entity_type: z.string().nullable(),
    entity_key: z.string().nullable(),
    status: z.string(),
    attempt_count: Id,
    error_text: z.string().nullable(),
    queued_at: Timestamp,
    started_at: OptionalTimestamp,
    completed_at: OptionalTimestamp,
  })
  .passthrough();

export function mapCloudTasks(rows: JsonObjectRow[]): CloudTaskRow[] {
  return z.array(CloudTaskSchema).parse(rows);
}

const AutomationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    rrule: z.string(),
    model: z.string().nullable(),
    next_run_at: OptionalTimestamp,
    last_run_at: OptionalTimestamp,
  })
  .passthrough();

export function mapAutomations(rows: JsonObjectRow[]): AutomationRow[] {
  return z.array(AutomationSchema).parse(rows);
}

const CatalystSchema = z
  .object({
    id: Id,
    thesis_id: z.string().nullable(),
    symbol: z.string().nullable(),
    catalyst_type: z.string(),
    event_date: z
      .union([z.string(), z.date(), z.null()])
      .transform((value) => {
        if (value === null) return null;
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        return value.slice(0, 10);
      }),
    summary: z.string(),
    source: z.string(),
    status: z.string(),
    created_at: Timestamp,
  })
  .passthrough();

export function mapCatalysts(rows: JsonObjectRow[]): CatalystRow[] {
  return z.array(CatalystSchema).parse(rows).map((row) => ({
    ...row,
    event_date: row.event_date,
  }));
}

const QueueSchema = z
  .object({
    id: Id,
    priority: Numeric,
    status: z.string(),
    topic: z.string(),
    reason: z.string(),
    source: z.string(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .passthrough();

export function mapQueue(rows: JsonObjectRow[]): QueueRow[] {
  return z.array(QueueSchema).parse(rows);
}

const LessonSchema = z
  .object({
    id: Id,
    cycle_id: Id,
    test_id: z.union([z.string(), z.number(), z.null()]).transform((value) =>
      value === null ? null : Number(value),
    ),
    thesis_id: z.string(),
    lesson_type: z.string(),
    summary: z.string(),
    market_regime: z.string().nullable(),
    incorporated: Bool,
    created_at: Timestamp,
  })
  .passthrough();

export function mapLessons(rows: JsonObjectRow[]): LessonRow[] {
  return z.array(LessonSchema).parse(rows);
}

const PostmortemSchema = z
  .object({
    id: Id,
    trade_proposal_id: z.union([z.string(), z.number(), z.null()]).transform((value) =>
      value === null ? null : Number(value),
    ),
    thesis_id: z.string().nullable(),
    created_at: Timestamp,
    outcome: z.string(),
    lesson: z.string(),
  })
  .passthrough();

export function mapPostmortems(rows: JsonObjectRow[]): PostmortemRow[] {
  return z.array(PostmortemSchema).parse(rows);
}

const CycleSchema = z
  .object({
    id: Id,
    external_key: z.string(),
    thesis_id: z.string(),
    hypothesis: z.string(),
    preregistered_outcome: z.string(),
    preregistered_at: Timestamp,
    stage: z.string(),
    status: z.string(),
    iteration: Id,
    market_regime: z.string().nullable(),
  })
  .passthrough();

export function mapCycles(rows: JsonObjectRow[]): CycleRow[] {
  return z.array(CycleSchema).parse(rows);
}

const TestSchema = z
  .object({
    id: Id,
    external_key: z.string(),
    cycle_id: Id,
    variant_label: z.string(),
    status: z.string(),
    total_return: OptionalMoney,
    max_drawdown: OptionalMoney,
    deflated_sharpe: OptionalMoney,
    cost_multiplier: Money,
    stress_regime: z.string().nullable(),
    failure_reason: z.string().nullable(),
    autopsy: z.string().nullable(),
    tested_at: Timestamp,
  })
  .passthrough();

export function mapTests(rows: JsonObjectRow[]): StrategyTestRow[] {
  return z.array(TestSchema).parse(rows);
}

const ScenarioSchema = z
  .object({
    id: Id,
    test_id: Id,
    scenario_key: z.string(),
    market_regime: z.string(),
    cost_multiplier: Money,
    outcome: z.string(),
    metric_value: OptionalMoney,
    breach_type: z.string().nullable(),
  })
  .passthrough();

export function mapScenarios(rows: JsonObjectRow[]): TestScenarioRow[] {
  return z.array(ScenarioSchema).parse(rows);
}

const AgentRunSchema = z
  .object({
    id: Id,
    cycle_id: Id,
    agent_role: z.string(),
    independence_group: z.string().nullable(),
    price_blinded: Bool,
    status: z.string(),
    summary: z.string(),
    created_at: Timestamp,
  })
  .passthrough();

export function mapAgentRuns(rows: JsonObjectRow[]): AgentRunRow[] {
  return z.array(AgentRunSchema).parse(rows);
}

const AccountSchema = z
  .object({
    observed_at: Timestamp,
    account_label: z.string(),
    total_value: Money,
    equity_value: Money,
    cash: Money,
    buying_power: Money,
    source: z.string(),
  })
  .passthrough();

export function mapAccounts(rows: JsonObjectRow[]): AccountRow[] {
  return z.array(AccountSchema).parse(rows);
}

export function mapAccount(rows: JsonObjectRow[]): AccountRow | null {
  return mapAccounts(rows)[0] ?? null;
}

const PositionSchema = z
  .object({
    id: z.string(),
    account_key: z.string(),
    symbol: z.string(),
    status: z.string(),
    quantity: Money,
    average_cost: OptionalMoney,
    opened_at: OptionalTimestamp,
    next_review_at: OptionalTimestamp,
  })
  .passthrough();

export function mapPositions(rows: JsonObjectRow[]): PositionRow[] {
  return z.array(PositionSchema).parse(rows);
}

const ExposureSchema = z
  .object({
    symbol: z.string(),
    quantity: Money,
    average_buy_price: OptionalMoney,
    observed_at: Timestamp,
  })
  .passthrough();

export function mapExposures(rows: JsonObjectRow[]): ExposureRow[] {
  return z.array(ExposureSchema).parse(rows);
}

const IntentSchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    side: z.string(),
    status: z.string(),
    mode: z.string(),
    notional: OptionalMoney,
    quantity: OptionalMoney,
    order_type: z.string(),
    broker_order_id: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .passthrough();

export function mapIntents(rows: JsonObjectRow[]): IntentRow[] {
  return z.array(IntentSchema).parse(rows);
}

const ProposalSchema = z
  .object({
    id: Id,
    thesis_id: z.string().nullable(),
    symbol: z.string(),
    side: z.string(),
    notional: Money,
    order_type: z.string(),
    status: z.string(),
    rationale: z.string(),
    created_at: Timestamp,
  })
  .passthrough();

export function mapProposals(rows: JsonObjectRow[]): ProposalRow[] {
  return z.array(ProposalSchema).parse(rows);
}

const FillSchema = z
  .object({
    id: z.string(),
    trade_intent_id: z.string(),
    quantity: Money,
    price: Money,
    executed_at: Timestamp,
  })
  .passthrough();

export function mapFills(rows: JsonObjectRow[]): FillRow[] {
  return z.array(FillSchema).parse(rows);
}

const InsightSchema = z
  .object({
    id: Id,
    title: z.string(),
    summary: z.string(),
    insight_type: z.string(),
    novelty: Numeric,
    confidence: Numeric,
    status: z.string(),
  })
  .passthrough();

export function mapInsights(rows: JsonObjectRow[]): InsightRow[] {
  return z.array(InsightSchema).parse(rows);
}

const PredictionSchema = z
  .object({
    id: Id,
    thesis_id: z.string(),
    statement: z.string(),
    target_date: z
      .union([z.string(), z.date(), z.null()])
      .transform((value) => {
        if (value === null) return null;
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        return value.slice(0, 10);
      }),
    probability: Numeric,
    status: z.string(),
  })
  .passthrough();

export function mapPredictions(rows: JsonObjectRow[]): PredictionRow[] {
  return z.array(PredictionSchema).parse(rows);
}

const RiskSchema = z
  .object({
    id: Id,
    control_key: z.string(),
    scope: z.string(),
    control_type: z.string(),
    threshold_json: z.union([
      z.string(),
      z.object({}).passthrough().transform((value) => JSON.stringify(value)),
    ]),
    enforcement_level: z.string(),
    status: z.string(),
  })
  .passthrough();

export function mapRiskControls(rows: JsonObjectRow[]): RiskControlRow[] {
  return z.array(RiskSchema).parse(rows);
}

const ThemeSchema = z
  .object({
    id: z.string(),
    thesis_id: z.string().nullable(),
    kind: z.string(),
    name: z.string(),
    description: z.string(),
    status: z.string(),
    match_threshold: Numeric,
    auto_promote_sources: Numeric,
  })
  .passthrough();

export function mapThemes(rows: JsonObjectRow[]): OntologyThemeRow[] {
  return z.array(ThemeSchema).parse(rows);
}

const OntologySymbolSchema = z
  .object({
    symbol: z.string(),
    status: z.string(),
    mention_count: Id,
    source_count: Id,
    first_seen_at: Timestamp,
    last_seen_at: Timestamp,
  })
  .passthrough();

export function mapOntologySymbols(rows: JsonObjectRow[]): OntologySymbolRow[] {
  return z.array(OntologySymbolSchema).parse(rows);
}

const CandidateSchema = z
  .object({
    id: Id,
    candidate_type: z.string(),
    candidate_key: z.string(),
    proposed_theme_id: z.string().nullable(),
    proposed_label: z.string(),
    proposed_description: z.string(),
    score: Numeric,
    evidence_count: Id,
    source_count: Id,
    status: z.string(),
    last_seen_at: Timestamp,
    review_note: z.string().nullable(),
  })
  .passthrough();

export function mapCandidates(rows: JsonObjectRow[]): OntologyCandidateRow[] {
  return z.array(CandidateSchema).parse(rows);
}

const ActionSchema = z
  .object({
    id: Id,
    actor_id: z.string(),
    entity_type: z.string(),
    entity_key: z.string(),
    action: z.string(),
    created_at: Timestamp,
  })
  .passthrough();

export function mapOntologyActions(rows: JsonObjectRow[]): OntologyActionRow[] {
  return z.array(ActionSchema).parse(rows);
}

const CountSchema = z.object({ n: Id }).passthrough();

export function mapCount(rows: JsonObjectRow[]): number {
  const parsed = z.array(CountSchema).parse(rows);
  return parsed[0]?.n ?? 0;
}

export function groupSymbols(rows: JsonObjectRow[]): Map<string, string[]> {
  const parsed = z.array(ThesisSymbolLinkSchema).parse(rows);
  const grouped = new Map<string, string[]>();
  for (const row of parsed) {
    const current = grouped.get(row.thesis_id) ?? [];
    current.push(row.symbol);
    grouped.set(row.thesis_id, current);
  }
  return grouped;
}

export function mapTheses(rows: JsonObjectRow[], symbolRows: JsonObjectRow[]): ThesisRow[] {
  const symbols = groupSymbols(z.array(JsonObjectSchema).parse(symbolRows));
  return z.array(ThesisRawSchema).parse(z.array(JsonObjectSchema).parse(rows)).map((row) => mapThesis(row, symbols.get(row.id) ?? []));
}
