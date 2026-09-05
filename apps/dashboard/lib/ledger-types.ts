import type { DeskVenue } from './desk-venue';
import type { PredictionMarketsPayload } from './prediction-book';
import type { ParsedRunNotes } from './run-notes';
import type { ThesisStatus } from './thesis-status';

export type ThesisSymbolLink = {
  thesis_id: string;
  symbol: string;
  role: string;
};

export type ThesisLot = {
  symbol: string;
  side: string;
  quantity: number;
  average_cost: number | null;
  invested: number | null;
  mark: number | null;
  pnl: number | null;
  note: string;
  venue?: DeskVenue;
};

export type ThesisRow = {
  id: string;
  name: string;
  summary: string;
  status: ThesisStatus;
  confidence: number;
  time_horizon: string;
  stance: string;
  variant_perception: string | null;
  falsifier: string | null;
  created_at: string;
  updated_at: string;
  symbols: string[];
  lots: ThesisLot[];
  /** QUANTANAMO and/or ODDSBORNE. Default equity when omitted. */
  venues?: DeskVenue[];
};

export type ThesisEvidenceRow = {
  id: number;
  thesis_id: string;
  evidence_type: string;
  direction: string;
  summary: string;
  source_url: string | null;
  confidence: number;
  created_at: string;
};

export type ThesisScoreRow = {
  id: number;
  thesis_id: string;
  scored_at: string;
  confidence: number;
  momentum: number;
  evidence_quality: number;
  catalyst_strength: number;
  portfolio_fit: number;
  risk: number;
  notes: string | null;
};

export type ThesisRelationRow = {
  src_thesis_id: string;
  dst_thesis_id: string;
  relation_type: string;
  strength: number;
  rationale: string;
};

export type RunRow = {
  id: number;
  run_type: string;
  started_at: string;
  completed_at: string | null;
  notes: string | null;
  parsed: ParsedRunNotes;
};

export type CloudRunRow = {
  id: string;
  trigger_key: string;
  trigger_source: string;
  market_slot: string | null;
  mode: string;
  status: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_text: string | null;
  summary: string;
};

export type CloudTaskRow = {
  id: string;
  run_id: string;
  task_type: string;
  entity_type: string | null;
  entity_key: string | null;
  status: string;
  attempt_count: number;
  error_text: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type AutomationRow = {
  id: string;
  name: string;
  status: string;
  rrule: string;
  model: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
};

export type CatalystRow = {
  id: number;
  thesis_id: string | null;
  symbol: string | null;
  catalyst_type: string;
  event_date: string | null;
  summary: string;
  source: string;
  status: string;
  created_at: string;
};

export type QueueRow = {
  id: number;
  priority: number;
  status: string;
  topic: string;
  reason: string;
  source: string;
  created_at: string;
  updated_at: string;
};

export type LessonRow = {
  id: number;
  cycle_id: number;
  test_id: number | null;
  thesis_id: string;
  lesson_type: string;
  summary: string;
  market_regime: string | null;
  incorporated: boolean;
  created_at: string;
};

export type PostmortemRow = {
  id: number;
  trade_proposal_id: number | null;
  thesis_id: string | null;
  created_at: string;
  outcome: string;
  lesson: string;
};

export type CycleRow = {
  id: number;
  external_key: string;
  thesis_id: string;
  hypothesis: string;
  preregistered_outcome: string;
  preregistered_at: string;
  stage: string;
  status: string;
  iteration: number;
  market_regime: string | null;
};

export type JsonScalar = string | number | boolean | null;
export type JsonBag = {
  [key: string]: JsonScalar | JsonScalar[] | JsonBag | JsonBag[] | undefined;
};

export type StrategyTestRow = {
  id: number;
  external_key: string;
  cycle_id: number;
  variant_label: string;
  status: string;
  total_return: number | null;
  max_drawdown: number | null;
  deflated_sharpe: number | null;
  cost_multiplier: number;
  stress_regime: string | null;
  failure_reason: string | null;
  autopsy: string | null;
  tested_at: string;
  price_source: string | null;
  window_start: string | null;
  window_end: string | null;
  symbols: string[] | null;
  params_json: JsonBag | null;
};

export type BacktestArtifactKind =
  | 'summary_json'
  | 'equity_curve'
  | 'trades'
  | 'daily_returns'
  | 'params_json'
  | 'price_source'
  | 'chart_svg';

export type BacktestArtifactRow = {
  id: number;
  test_id: number;
  thesis_id: string | null;
  artifact_kind: BacktestArtifactKind;
  title: string;
  mime_type: string;
  payload_json: JsonBag | null;
  payload_items: JsonBag[] | null;
  payload_text: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  source: string;
  created_at: string;
};

export type EquityPoint = {
  t: string | null;
  equity: number;
  drawdown: number | null;
};

export type BacktestTrade = {
  t: string | null;
  symbol: string | null;
  side: string | null;
  qty: number | null;
  price: number | null;
  reason: string | null;
};

export type BacktestMetric = {
  key: string;
  numeric: number | null;
  text: string | null;
};

export type BacktestParam = {
  key: string;
  value: string | null;
};

export type BacktestPriceSource = {
  tickers: string[] | null;
  interval: string | null;
  bar_start: string | null;
  bar_end: string | null;
  source: string | null;
  label: string | null;
};

export type BacktestView = {
  test: StrategyTestRow;
  thesis_id: string | null;
  thesis_name: string | null;
  artifact_kinds: BacktestArtifactKind[];
  artifact_count: number;
  window_start: string | null;
  window_end: string | null;
  symbols: string[] | null;
  price_source_column: string | null;
  total_return: number | null;
  max_drawdown: number | null;
  trade_count: number | null;
  summary: BacktestMetric[];
  equity_points: EquityPoint[];
  chart_svg: string | null;
  trades: BacktestTrade[];
  params: BacktestParam[];
  price_source: BacktestPriceSource | null;
};

export type TestScenarioRow = {
  id: number;
  test_id: number;
  scenario_key: string;
  market_regime: string;
  cost_multiplier: number;
  outcome: string;
  metric_value: number | null;
  breach_type: string | null;
};

export type AgentRunRow = {
  id: number;
  cycle_id: number;
  agent_role: string;
  independence_group: string | null;
  price_blinded: boolean;
  status: string;
  summary: string;
  created_at: string;
};

export type AccountRow = {
  observed_at: string;
  account_label: string;
  total_value: number;
  equity_value: number;
  cash: number;
  buying_power: number;
  source: string;
};

export type BookNameLine = {
  symbol: string;
  quantity: number;
  average_cost: number | null;
  cost: number | null;
  mark: number | null;
  pnl: number | null;
  note: string;
  venue?: DeskVenue;
};

export type BookPerformance = {
  account_label: string | null;
  observed_at: string | null;
  last4: string | null;
  buying_power: number | null;
  starting_nav: number | null;
  current_nav: number | null;
  cash: number | null;
  deployed: number | null;
  vs_start: number | null;
  vs_start_note: string;
  day_pnl: number | null;
  day_pnl_note: string;
  vs_cost: number | null;
  vs_cost_note: string;
  names: BookNameLine[];
};

export type DeskRoutine = {
  id: string;
  name: string;
  cadence: string;
  status: 'live' | 'retired';
  last_run_at: string | null;
  last_run_type: string | null;
  last_outcome: string | null;
  last_summary: string | null;
};

export type PositionRow = {
  id: string;
  account_key: string;
  symbol: string;
  status: string;
  quantity: number;
  average_cost: number | null;
  opened_at: string | null;
  next_review_at: string | null;
};

export type ExposureRow = {
  symbol: string;
  quantity: number;
  average_buy_price: number | null;
  last_price: number | null;
  observed_at: string;
  account_last4: string;
};

export type IntentRow = {
  id: string;
  account_key: string;
  symbol: string;
  side: string;
  status: string;
  mode: string;
  notional: number | null;
  quantity: number | null;
  order_type: string;
  broker_order_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ProposalRow = {
  id: number;
  thesis_id: string | null;
  symbol: string;
  side: string;
  notional: number;
  order_type: string;
  status: string;
  rationale: string;
  created_at: string;
};

export type FillRow = {
  id: string;
  trade_intent_id: string;
  quantity: number;
  price: number;
  executed_at: string;
};

export type FillLogRow = {
  id: string;
  at: string;
  symbol: string;
  side: string;
  quantity: number | null;
  price: number | null;
  notional: number | null;
  status: string;
  source: 'broker_fill' | 'filled_intent' | 'prediction_fill';
  note: string;
  venue?: DeskVenue;
};

export type InsightRow = {
  id: number;
  title: string;
  summary: string;
  insight_type: string;
  novelty: number;
  confidence: number;
  status: string;
};

export type PredictionRow = {
  id: number;
  thesis_id: string;
  statement: string;
  target_date: string | null;
  probability: number;
  status: string;
};

export type RiskControlRow = {
  id: number;
  control_key: string;
  scope: string;
  control_type: string;
  threshold_json: string;
  enforcement_level: string;
  status: string;
};

export type OntologyThemeRow = {
  id: string;
  thesis_id: string | null;
  kind: string;
  name: string;
  description: string;
  status: string;
  match_threshold: number;
  auto_promote_sources: number;
};

export type OntologySymbolRow = {
  symbol: string;
  status: string;
  mention_count: number;
  source_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

export type OntologyCandidateRow = {
  id: number;
  candidate_type: string;
  candidate_key: string;
  proposed_theme_id: string | null;
  proposed_label: string;
  proposed_description: string;
  score: number;
  evidence_count: number;
  source_count: number;
  status: string;
  last_seen_at: string;
  review_note: string | null;
};

export type OntologyActionRow = {
  id: number;
  actor_id: string;
  entity_type: string;
  entity_key: string;
  action: string;
  created_at: string;
};

export type DeskCounts = {
  sources: number;
  symbols: number;
  open_research: number;
  tests_killed: number;
  tests_survived: number;
  scenario_cells: number;
  open_positions: number;
  queued_tasks: number;
};

export type DeskPayload = {
  generated_at: string;
  source: 'postgres' | 'postgrest' | 'snapshot';
  /** ODDSBORNE `pm_*` snapshot. Empty object when those tables are missing. */
  prediction_markets?: PredictionMarketsPayload;
  theses: ThesisRow[];
  evidence: ThesisEvidenceRow[];
  scores: ThesisScoreRow[];
  relations: ThesisRelationRow[];
  runs: RunRow[];
  cloud_runs: CloudRunRow[];
  cloud_tasks: CloudTaskRow[];
  automations: AutomationRow[];
  catalysts: CatalystRow[];
  queue: QueueRow[];
  lessons: LessonRow[];
  postmortems: PostmortemRow[];
  cycles: CycleRow[];
  tests: StrategyTestRow[];
  backtest_artifacts: BacktestArtifactRow[];
  scenarios: TestScenarioRow[];
  agent_runs: AgentRunRow[];
  account: AccountRow | null;
  snapshots: AccountRow[];
  book: BookPerformance;
  positions: PositionRow[];
  exposures: ExposureRow[];
  intents: IntentRow[];
  proposals: ProposalRow[];
  fills: FillRow[];
  fill_log: FillLogRow[];
  insights: InsightRow[];
  predictions: PredictionRow[];
  risk_controls: RiskControlRow[];
  routines: DeskRoutine[];
  ontology_themes: OntologyThemeRow[];
  ontology_symbols: OntologySymbolRow[];
  ontology_candidates: OntologyCandidateRow[];
  ontology_actions: OntologyActionRow[];
  counts: DeskCounts;
};
