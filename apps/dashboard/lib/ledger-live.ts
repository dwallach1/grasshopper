import { mapBacktestArtifacts } from './backtest-artifacts';
import { z } from 'zod';

import {
  mapAccount,
  mapAccounts,
  mapAgentRuns,
  mapAutomations,
  mapCandidates,
  mapCatalysts,
  mapCloudRuns,
  mapCloudTasks,
  mapCycles,
  mapEvidence,
  mapExposures,
  mapFills,
  mapInsights,
  mapIntents,
  mapLessons,
  mapOntologyActions,
  mapOntologySymbols,
  mapPositions,
  mapPostmortems,
  mapPredictions,
  mapProposals,
  mapQueue,
  mapRelations,
  mapRiskControls,
  mapRuns,
  mapScores,
  mapScenarios,
  mapTests,
  mapThemes,
  mapTheses,
  mapThesisSymbolLinks,
  type JsonObjectRow,
} from './ledger-map';
import { assembleTeam, emptyTeam } from './desk-team';
import type { DeskPayload, DeskTeamPayload } from './ledger-types';
import {
  emptyMemeCoins,
  hydrateMemeDesk,
  mapMemeCoins,
  openMemeCount,
  type MemeCoinsPayload,
} from './meme-book';
import { AGENTIC_LAST4, assembleBookPerformance, latestBookExposures, snapshotForBook } from './book-performance';
import {
  emptyPredictionMarkets,
  hydratePredictionDesk,
  mapPredictionMarkets,
  openPredictionCount,
  type PredictionMarketsPayload,
} from './prediction-book';
import { assembleRoutines } from './routines';
import { assembleFillLog, attachThesisLots } from './thesis-book';

const JsonArraySchema = z.array(z.object({}).passthrough());
export const REST_FETCH_MS = 8_000;

/** PostgREST credentials for a SELECT-only desk load. Never a service_role JWT. */
export type DeskRestAuth = {
  supabaseUrl: string;
  apiKey: string;
  accessToken: string;
  fetchMs?: number;
};

async function restRows(path: string, auth: DeskRestAuth) {
  const response = await fetch(`${auth.supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`, {
    headers: {
      apikey: auth.apiKey,
      Authorization: `Bearer ${auth.accessToken}`,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(auth.fetchMs ?? REST_FETCH_MS),
  });
  if (!response.ok) {
    throw new Error(`Supabase REST ${path} failed: ${response.status}`);
  }
  return JsonArraySchema.parse(await response.json());
}

async function restOptional(path: string, auth: DeskRestAuth): Promise<JsonObjectRow[]> {
  try {
    return await restRows(path, auth);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'ledger_rest_skipped',
      path,
      error: error instanceof Error ? error.message : 'unknown',
    }));
    return [];
  }
}

export async function loadDeskFromRest(auth: DeskRestAuth): Promise<DeskPayload> {
  const [
    theses,
    symbols,
    evidence,
    scores,
    relations,
    runs,
    cloudRuns,
    cloudTasks,
    automations,
    catalysts,
    queue,
    lessons,
    postmortems,
    cycles,
    tests,
    artifacts,
    scenarios,
    agentRuns,
    accountLatest,
    accountFirst,
    positions,
    exposures,
    intents,
    proposals,
    fills,
    insights,
    predictions,
    riskControls,
    themes,
    ontologySymbols,
    candidates,
    actions,
  ] = await Promise.all([
    restRows('theses?select=id,name,summary,status,confidence,time_horizon,stance,variant_perception,falsifier,created_at,updated_at&order=confidence.desc,name.asc', auth),
    restRows('thesis_symbols?select=thesis_id,symbol,role&order=weight_hint.desc,symbol.asc', auth),
    restRows('thesis_evidence?select=id,thesis_id,evidence_type,direction,summary,source_url,confidence,created_at&order=created_at.desc,id.desc&limit=200', auth),
    restRows('thesis_scores?select=id,thesis_id,scored_at,confidence,momentum,evidence_quality,catalyst_strength,portfolio_fit,risk,notes&order=scored_at.desc,id.desc&limit=400', auth),
    restRows('thesis_relations?select=src_thesis_id,dst_thesis_id,relation_type,strength,rationale', auth),
    restRows('runs?select=id,run_type,started_at,completed_at,notes&order=started_at.desc,id.desc&limit=80', auth),
    restRows('cloud_runs?select=id,trigger_key,trigger_source,market_slot,mode,status,scheduled_for,started_at,completed_at,error_text,summary&order=created_at.desc&limit=40', auth),
    restRows('cloud_tasks?select=id,run_id,task_type,entity_type,entity_key,status,attempt_count,error_text,queued_at,started_at,completed_at&order=queued_at.desc&limit=60', auth),
    restRows('codex_automations?select=id,name,status,rrule,model,next_run_at,last_run_at&order=status.asc,name.asc', auth),
    restRows('catalysts?select=id,thesis_id,symbol,catalyst_type,event_date,summary,source,status,created_at&order=event_date.asc,created_at.desc', auth),
    restRows('research_queue?select=id,priority,status,topic,reason,source,created_at,updated_at&order=priority.desc,created_at.desc', auth),
    restRows('research_lessons?select=id,cycle_id,test_id,thesis_id,lesson_type,summary,market_regime,incorporated,created_at&order=created_at.desc,id.desc', auth),
    restRows('postmortems?select=id,trade_proposal_id,thesis_id,created_at,outcome,lesson&order=created_at.desc,id.desc&limit=40', auth),
    restRows('research_cycles?select=id,external_key,thesis_id,hypothesis,preregistered_outcome,preregistered_at,stage,status,iteration,market_regime&order=updated_at.desc,id.desc', auth),
    restRows('strategy_tests?select=id,external_key,cycle_id,variant_label,status,total_return,max_drawdown,deflated_sharpe,cost_multiplier,stress_regime,failure_reason,autopsy,tested_at,price_source,window_start,window_end,symbols,params_json&order=tested_at.desc,id.desc', auth),
    restRows('backtest_artifacts?select=id,test_id,thesis_id,artifact_kind,title,mime_type,payload_json,storage_bucket,storage_path,source,created_at&order=created_at.desc,id.desc', auth),
    restRows('test_scenarios?select=id,test_id,scenario_key,market_regime,cost_multiplier,outcome,metric_value,breach_type&order=tested_at.desc,id.desc', auth),
    restRows('agent_runs?select=id,cycle_id,agent_role,independence_group,price_blinded,status,summary,created_at&order=created_at.desc,id.desc', auth),
    restRows('account_snapshots?select=observed_at,account_label,total_value,equity_value,cash,buying_power,source&account_label=ilike.*Agentic*&order=observed_at.desc,id.desc&limit=200', auth),
    restRows('account_snapshots?select=observed_at,account_label,total_value,equity_value,cash,buying_power,source&account_label=ilike.*Agentic*&order=observed_at.asc,id.asc&limit=1', auth),
    restRows('position_episodes?select=id,account_key,symbol,status,quantity,average_cost,opened_at,closed_at,next_review_at&status=in.(proposed,open,closing,closed)&order=opened_at.desc.nullslast,symbol.asc&limit=400', auth),
    restRows(`portfolio_exposure?select=symbol,quantity,average_buy_price,last_price,observed_at,account_last4&account_last4=eq.${AGENTIC_LAST4}&order=observed_at.desc,quantity.desc&limit=80`, auth),
    restRows('trade_intents?select=id,account_key,symbol,side,status,mode,notional,quantity,order_type,broker_order_id,created_at,updated_at&order=created_at.desc&limit=200', auth),
    restRows('trade_proposals?select=id,thesis_id,symbol,side,notional,order_type,status,rationale,created_at&order=created_at.desc,id.desc&limit=40', auth),
    restRows('broker_fills?select=id,trade_intent_id,quantity,price,executed_at&order=executed_at.desc&limit=200', auth),
    restRows('insights?select=id,title,summary,insight_type,novelty,confidence,status&order=updated_at.desc,id.desc&limit=40', auth),
    restRows('predictions?select=id,thesis_id,statement,target_date,probability,status&order=updated_at.desc,id.desc', auth),
    restRows('risk_controls?select=id,control_key,scope,control_type,threshold_json,enforcement_level,status&order=control_key.asc', auth),
    restRows('ontology_themes?select=id,thesis_id,kind,name,description,status,match_threshold,auto_promote_sources&order=status.asc,name.asc', auth),
    restRows('symbols?select=symbol,status,mention_count,source_count,first_seen_at,last_seen_at&order=source_count.desc,mention_count.desc&limit=300', auth),
    restRows('ontology_candidates?select=id,candidate_type,candidate_key,proposed_theme_id,proposed_label,proposed_description,score,evidence_count,source_count,status,last_seen_at,review_note&source_count=gte.2&order=status.asc,source_count.desc,score.desc&limit=100', auth),
    restRows('ontology_management_actions?select=id,actor_id,entity_type,entity_key,action,created_at&order=created_at.desc,id.desc&limit=100', auth),
  ]);

  const [prediction, meme, team] = await Promise.all([
    loadPredictionMarketsRest(auth),
    loadMemeCoinsRest(auth),
    loadTeamRest(auth),
  ]);
  return assembleDeskFromRestBag({
    theses, symbols, evidence, scores, relations, runs, cloudRuns, cloudTasks,
    automations, catalysts, queue, lessons, postmortems, cycles, tests, artifacts,
    scenarios, agentRuns, accountLatest, accountFirst, positions, exposures,
    intents, proposals, fills, insights, predictions, riskControls, themes,
    ontologySymbols, candidates, actions, prediction, meme, team,
  });
}

export type RestDeskBag = {
  theses: JsonObjectRow[];
  symbols: JsonObjectRow[];
  evidence: JsonObjectRow[];
  scores: JsonObjectRow[];
  relations: JsonObjectRow[];
  runs: JsonObjectRow[];
  cloudRuns: JsonObjectRow[];
  cloudTasks: JsonObjectRow[];
  automations: JsonObjectRow[];
  catalysts: JsonObjectRow[];
  queue: JsonObjectRow[];
  lessons: JsonObjectRow[];
  postmortems: JsonObjectRow[];
  cycles: JsonObjectRow[];
  tests: JsonObjectRow[];
  artifacts: JsonObjectRow[];
  scenarios: JsonObjectRow[];
  agentRuns: JsonObjectRow[];
  accountLatest: JsonObjectRow[];
  accountFirst: JsonObjectRow[];
  positions: JsonObjectRow[];
  exposures: JsonObjectRow[];
  intents: JsonObjectRow[];
  proposals: JsonObjectRow[];
  fills: JsonObjectRow[];
  insights: JsonObjectRow[];
  predictions: JsonObjectRow[];
  riskControls: JsonObjectRow[];
  themes: JsonObjectRow[];
  ontologySymbols: JsonObjectRow[];
  candidates: JsonObjectRow[];
  actions: JsonObjectRow[];
  prediction: PredictionMarketsPayload;
  meme: MemeCoinsPayload;
  team: DeskTeamPayload;
};

/** Phone Worker path — skip operator tables the public snapshot already drops. */
export function assemblePublicDeskFromRestBag(bag: Pick<
  RestDeskBag,
  | 'theses'
  | 'symbols'
  | 'accountLatest'
  | 'accountFirst'
  | 'positions'
  | 'exposures'
  | 'intents'
  | 'fills'
  | 'themes'
  | 'prediction'
  | 'meme'
  | 'team'
>): DeskPayload {
  return assembleDesk('postgrest', decorateDesk(bag.theses, bag.symbols, {
    evidence: [],
    scores: [],
    relations: [],
    runs: [],
    cloud_runs: [],
    cloud_tasks: [],
    automations: [],
    catalysts: [],
    queue: [],
    lessons: [],
    postmortems: [],
    cycles: [],
    tests: [],
    backtest_artifacts: [],
    scenarios: [],
    agent_runs: [],
    ...bookFields(bag.accountLatest, bag.accountFirst, bag.positions, bag.exposures),
    intents: mapIntents(bag.intents),
    proposals: [],
    fills: mapFills(bag.fills),
    insights: [],
    predictions: [],
    risk_controls: [],
    ontology_themes: mapThemes(bag.themes),
    ontology_symbols: [],
    ontology_candidates: [],
    ontology_actions: [],
    counts: {
      sources: 0,
      symbols: 0,
      open_research: 0,
      tests_killed: 0,
      tests_survived: 0,
      scenario_cells: 0,
      open_positions: 0,
      queued_tasks: 0,
    },
  }, bag.prediction, bag.meme, bag.team));
}

export function assembleDeskFromRestBag(bag: RestDeskBag): DeskPayload {
  const mappedTests = mapTests(bag.tests);
  const mappedArtifacts = mapBacktestArtifacts(bag.artifacts);
  const {
    theses, symbols, evidence, scores, relations, runs, cloudRuns, cloudTasks,
    automations, catalysts, queue, lessons, postmortems, cycles, scenarios,
    agentRuns, accountLatest, accountFirst, positions, exposures, intents,
    proposals, fills, insights, predictions, riskControls, themes,
    ontologySymbols, candidates, actions, prediction, meme, team,
  } = bag;
  return assembleDesk('postgrest', decorateDesk(theses, symbols, {
    evidence: mapEvidence(evidence),
    scores: mapScores(scores),
    relations: mapRelations(relations),
    runs: mapRuns(runs),
    cloud_runs: mapCloudRuns(cloudRuns),
    cloud_tasks: mapCloudTasks(cloudTasks),
    automations: mapAutomations(automations),
    catalysts: mapCatalysts(catalysts),
    queue: mapQueue(queue),
    lessons: mapLessons(lessons),
    postmortems: mapPostmortems(postmortems),
    cycles: mapCycles(cycles),
    tests: mappedTests,
    backtest_artifacts: mappedArtifacts,
    scenarios: mapScenarios(scenarios),
    agent_runs: mapAgentRuns(agentRuns),
    ...bookFields(accountLatest, accountFirst, positions, exposures),
    intents: mapIntents(intents),
    proposals: mapProposals(proposals),
    fills: mapFills(fills),
    insights: mapInsights(insights),
    predictions: mapPredictions(predictions),
    risk_controls: mapRiskControls(riskControls),
    ontology_themes: mapThemes(themes),
    ontology_symbols: mapOntologySymbols(ontologySymbols),
    ontology_candidates: mapCandidates(candidates),
    ontology_actions: mapOntologyActions(actions),
    counts: {
      sources: 0,
      symbols: ontologySymbols.length,
      open_research: mapQueue(queue).filter((row) => row.status === 'open').length,
      tests_killed: mappedTests.filter((row) => row.status === 'killed').length,
      tests_survived: mappedTests.filter((row) => row.status === 'survived').length,
      scenario_cells: mapScenarios(scenarios).length,
      open_positions: mapPositions(positions).length,
      queued_tasks: mapCloudTasks(cloudTasks).filter((row) =>
        row.status === 'queued' || row.status === 'running',
      ).length,
    },
  }, prediction, meme, team));
}

async function loadTeamRest(auth: DeskRestAuth): Promise<DeskTeamPayload> {
  const [agents, domains, stewards, accounts] = await Promise.all([
    restOptional('desk_agents?select=id,slug,display_name,role_title,charter,accent,avatar_key,status,heartbeat_at,sort_order,meta&order=sort_order.asc,slug.asc', auth),
    restOptional('desk_domains?select=id,slug,name,kind,description,accent,status,sort_order,meta&order=sort_order.asc,slug.asc', auth),
    restOptional('desk_domain_stewards?select=id,domain_id,agent_id,is_primary,assigned_at,ended_at,note&ended_at=is.null&order=assigned_at.asc,id.asc', auth),
    restOptional('desk_accounts?select=id,domain_id,account_key,label,currency,status&order=account_key.asc', auth),
  ]);
  return assembleTeam({ agents, domains, stewards, accounts });
}

async function loadMemeCoinsRest(auth: DeskRestAuth): Promise<MemeCoinsPayload> {
  const [tokens, positions, orders, fills, pnl, notes] = await Promise.all([
    restOptional('meme_tokens?select=id,venue,mint,symbol,name,status,bonding_curve_status,graduated_at,last_price_sol,last_mcap_sol,last_marked_at,thesis_id,kill_criteria&order=updated_at.desc&limit=200', auth),
    restOptional('meme_positions?select=id,token_id,account_key,thesis_id,status,quantity,average_cost_sol,mark_sol,mark_at,opened_at,closed_at,thesis_text&order=updated_at.desc&limit=200', auth),
    restOptional('meme_orders?select=id,token_id,account_key,thesis_id,side,order_type,size_sol,size_tokens,price_sol,status,mode,venue_order_id,submitted_at,created_at&order=created_at.desc&limit=200', auth),
    restOptional('meme_fills?select=id,order_id,position_id,account_key,side,quantity,price_sol,fee_sol,executed_at&order=executed_at.desc&limit=200', auth),
    restOptional('meme_pnl?select=id,account_key,as_of,realized,unrealized,fees,cash_sol,equity_sol,notes&order=as_of.desc&limit=200', auth),
    restOptional('meme_notes?select=id,token_id,thesis_id,note_type,title,body,created_at&order=created_at.desc&limit=80', auth),
  ]);
  return mapMemeCoins({ tokens, positions, orders, fills, pnl, notes });
}

async function loadPredictionMarketsRest(auth: DeskRestAuth): Promise<PredictionMarketsPayload> {
  const [markets, positions, orders, fills, pnl, notes] = await Promise.all([
    restOptional('pm_markets?select=id,venue,slug,question,status,close_time,last_yes,last_no,last_marked_at,thesis_id,rules_summary&order=close_time.asc.nullslast&limit=200', auth),
    restOptional('pm_positions?select=id,market_id,account_key,thesis_id,outcome,status,quantity,average_cost,mark,mark_at,opened_at,closed_at,thesis_text&order=updated_at.desc&limit=200', auth),
    restOptional('pm_orders?select=id,market_id,thesis_id,outcome,side,order_type,size,price,status,mode,venue_order_id,submitted_at,created_at&order=created_at.desc&limit=200', auth),
    restOptional('pm_fills?select=id,order_id,position_id,outcome,side,quantity,price,executed_at&order=executed_at.desc&limit=200', auth),
    restOptional('pm_pnl?select=id,account_key,as_of,realized,unrealized,fees,cash,equity,notes&order=as_of.desc&limit=200', auth),
    restOptional('pm_notes?select=id,market_id,thesis_id,note_type,title,body,created_at&order=created_at.desc&limit=80', auth),
  ]);
  return mapPredictionMarkets({ markets, positions, orders, fills, pnl, notes });
}

export function bookFields(
  latestRows: JsonObjectRow[],
  firstRows: JsonObjectRow[],
  positionRows: JsonObjectRow[],
  exposureRows: JsonObjectRow[],
) {
  const snapshots = mapAccounts(latestRows);
  const starting = mapAccount(firstRows);
  const positions = mapPositions(positionRows);
  const exposures = latestBookExposures(mapExposures(exposureRows));
  const book = assembleBookPerformance({
    snapshotsNewestFirst: snapshots,
    starting,
    exposures,
  });
  return {
    account: book.observed_at
      ? snapshotForBook(snapshots, book.observed_at)
      : snapshots[0] ?? starting,
    snapshots,
    book,
    positions,
    exposures,
  };
}

export function decorateDesk(
  thesisRows: JsonObjectRow[],
  symbolRows: JsonObjectRow[],
  body: Omit<DeskPayload, 'generated_at' | 'source' | 'routines' | 'theses' | 'fill_log' | 'team'>,
  prediction: PredictionMarketsPayload = emptyPredictionMarkets(),
  meme: MemeCoinsPayload = emptyMemeCoins(),
  team: DeskTeamPayload = emptyTeam(),
): Omit<DeskPayload, 'generated_at' | 'source' | 'routines'> {
  const theses = attachThesisLots(mapTheses(thesisRows, symbolRows), {
    links: mapThesisSymbolLinks(symbolRows),
    proposals: body.proposals,
    exposures: body.exposures,
  });
  const fillLog = assembleFillLog({ fills: body.fills, intents: body.intents });
  const withPrediction = hydratePredictionDesk(theses, fillLog, prediction);
  return {
    ...body,
    team,
    ...hydrateMemeDesk(withPrediction.theses, withPrediction.fill_log, meme),
    prediction_markets: withPrediction.prediction_markets,
  };
}

export function assembleDesk(
  source: DeskPayload['source'],
  body: Omit<DeskPayload, 'generated_at' | 'source' | 'routines'>,
): DeskPayload {
  return {
    ...body,
    generated_at: new Date().toISOString(),
    source,
    routines: assembleRoutines({
      runs: body.runs,
      automations: body.automations,
      cloudRuns: body.cloud_runs,
    }),
    counts: {
      ...body.counts,
      open_positions: body.exposures.length
        + openPredictionCount(body.prediction_markets ?? emptyPredictionMarkets())
        + openMemeCount(body.meme_coins ?? emptyMemeCoins()),
    },
  };
}
