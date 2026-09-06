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
  mapCount,
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
import { publicSupabaseUrl, userRestHeaders } from './auth-env';
import {
  hasDatabaseUrl,
  isPostgresPermissionDenied,
  isPostgresUndefinedRelation,
  openSql,
  type Sql,
} from './postgres';
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
const REST_FETCH_MS = 8_000;

async function restRows(path: string, accessToken: string) {
  const response = await fetch(`${publicSupabaseUrl()}/rest/v1/${path}`, {
    headers: userRestHeaders(accessToken),
    cache: 'no-store',
    signal: AbortSignal.timeout(REST_FETCH_MS),
  });
  if (!response.ok) {
    throw new Error(`Supabase REST ${path} failed: ${response.status}`);
  }
  return JsonArraySchema.parse(await response.json());
}

async function optionalRows(label: string, query: Promise<JsonObjectRow[]>): Promise<JsonObjectRow[]> {
  try {
    return JsonArraySchema.parse(await query);
  } catch (error) {
    if (error instanceof Error && isPostgresPermissionDenied(error.message)) {
      console.error(JSON.stringify({ event: 'ledger_query_denied', table: label, error: error.message }));
      return [];
    }
    throw error;
  }
}

export async function loadDesk(accessToken: string): Promise<DeskPayload> {
  if (hasDatabaseUrl()) return loadDeskFromPostgres();
  return loadDeskFromRest(accessToken);
}

export async function loadDeskFromPostgres(): Promise<DeskPayload> {
  const sql = openSql();
  try {
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
      sourceCount,
      symbolCount,
      openResearch,
      testsKilled,
      testsSurvived,
      scenarioCells,
      openPositions,
      queuedTasks,
    ] = await Promise.all([
      sql`
        select id, name, summary, status, confidence, time_horizon, stance,
               variant_perception, falsifier, created_at, updated_at
        from public.theses
        order by confidence desc, name
      `,
      sql`
        select thesis_id, symbol, role
        from public.thesis_symbols
        order by weight_hint desc, symbol
      `,
      sql`
        select id, thesis_id, evidence_type, direction, summary, source_url, confidence, created_at
        from public.thesis_evidence
        order by created_at desc, id desc
        limit 200
      `,
      sql`
        select id, thesis_id, scored_at, confidence, momentum, evidence_quality,
               catalyst_strength, portfolio_fit, risk, notes
        from public.thesis_scores
        order by scored_at desc, id desc
        limit 400
      `,
      sql`
        select src_thesis_id, dst_thesis_id, relation_type, strength, rationale
        from public.thesis_relations
      `,
      sql`
        select id, run_type, started_at, completed_at, notes
        from public.runs
        order by started_at desc, id desc
        limit 80
      `,
      optionalRows(
        'cloud_runs',
        sql`
        select id, trigger_key, trigger_source, market_slot, mode, status,
               scheduled_for, started_at, completed_at, error_text, summary::text as summary
        from public.cloud_runs
        order by coalesce(started_at, scheduled_for, created_at) desc
        limit 40
      `,
      ),
      optionalRows(
        'cloud_tasks',
        sql`
        select id, run_id, task_type, entity_type, entity_key, status, attempt_count,
               error_text, queued_at, started_at, completed_at
        from public.cloud_tasks
        order by
          case status when 'queued' then 0 when 'running' then 1 else 2 end,
          queued_at desc
        limit 60
      `,
      ),
      sql`
        select id, name, status, rrule, model, next_run_at, last_run_at
        from public.codex_automations
        order by status, next_run_at nulls last, name
      `,
      sql`
        select id, thesis_id, symbol, catalyst_type, event_date::text as event_date,
               summary, source, status, created_at
        from public.catalysts
        order by event_date nulls last, created_at desc
      `,
      sql`
        select id, priority, status, topic, reason, source, created_at, updated_at
        from public.research_queue
        order by status, priority desc, created_at desc
      `,
      sql`
        select id, cycle_id, test_id, thesis_id, lesson_type, summary, market_regime,
               incorporated, created_at
        from public.research_lessons
        order by created_at desc, id desc
      `,
      sql`
        select id, trade_proposal_id, thesis_id, created_at, outcome, lesson
        from public.postmortems
        order by created_at desc, id desc
        limit 40
      `,
      sql`
        select id, external_key, thesis_id, hypothesis, preregistered_outcome,
               preregistered_at, stage, status, iteration, market_regime
        from public.research_cycles
        order by updated_at desc, id desc
      `,
      sql`
        select id, external_key, cycle_id, variant_label, status, total_return, max_drawdown,
               deflated_sharpe, cost_multiplier, stress_regime, failure_reason, autopsy, tested_at,
               price_source, window_start::text as window_start, window_end::text as window_end,
               symbols, params_json
        from public.strategy_tests
        order by tested_at desc, id desc
      `,
      optionalRows(
        'backtest_artifacts',
        sql`
        select id, test_id, thesis_id, artifact_kind, title, mime_type, payload_json,
               storage_bucket, storage_path, source, created_at
        from public.backtest_artifacts
        order by created_at desc, id desc
      `,
      ),
      sql`
        select id, test_id, scenario_key, market_regime, cost_multiplier, outcome,
               metric_value, breach_type
        from public.test_scenarios
        order by tested_at desc, id desc
      `,
      sql`
        select id, cycle_id, agent_role, independence_group, price_blinded, status, summary, created_at
        from public.agent_runs
        order by created_at desc, id desc
      `,
      sql`
        select observed_at, account_label, total_value, equity_value, cash, buying_power, source
        from public.account_snapshots
        where account_label ilike '%agentic%'
        order by observed_at desc, id desc
        limit 40
      `,
      sql`
        select observed_at, account_label, total_value, equity_value, cash, buying_power, source
        from public.account_snapshots
        where account_label ilike '%agentic%'
        order by observed_at asc, id asc
        limit 1
      `,
      optionalRows(
        'position_episodes',
        sql`
        select id, account_key, symbol, status, quantity, average_cost, opened_at, next_review_at
        from public.position_episodes
        where status in ('proposed', 'open', 'closing')
        order by opened_at desc nulls last, symbol
      `,
      ),
      sql`
        select symbol, quantity, average_buy_price, last_price, observed_at, account_last4
        from public.portfolio_exposure
        where account_last4 = ${AGENTIC_LAST4}
          and observed_at = (
            select max(observed_at)
            from public.portfolio_exposure
            where account_last4 = ${AGENTIC_LAST4}
          )
        order by quantity desc, symbol
      `,
      optionalRows(
        'trade_intents',
        sql`
        select id, account_key, symbol, side, status, mode, notional, quantity, order_type,
               broker_order_id, created_at, updated_at
        from public.trade_intents
        order by created_at desc
        limit 40
      `,
      ),
      sql`
        select id, thesis_id, symbol, side, notional, order_type, status, rationale, created_at
        from public.trade_proposals
        order by created_at desc, id desc
        limit 40
      `,
      optionalRows(
        'broker_fills',
        sql`
        select id, trade_intent_id, quantity, price, executed_at
        from public.broker_fills
        order by executed_at desc
        limit 40
      `,
      ),
      sql`
        select id, title, summary, insight_type, novelty, confidence, status
        from public.insights
        order by updated_at desc, id desc
        limit 40
      `,
      sql`
        select id, thesis_id, statement, target_date::text as target_date, probability, status
        from public.predictions
        order by updated_at desc, id desc
      `,
      sql`
        select id, control_key, scope, control_type, threshold_json::text as threshold_json,
               enforcement_level, status
        from public.risk_controls
        order by control_key
      `,
      sql`
        select id, thesis_id, kind, name, description, status, match_threshold, auto_promote_sources
        from public.ontology_themes
        order by status, name
      `,
      sql`
        select symbol, status, mention_count, source_count, first_seen_at, last_seen_at
        from public.symbols
        order by source_count desc, mention_count desc
        limit 300
      `,
      sql`
        select id, candidate_type, candidate_key, proposed_theme_id, proposed_label,
               proposed_description, score, evidence_count, source_count, status,
               last_seen_at, review_note
        from public.ontology_candidates
        where source_count >= 2
        order by status, source_count desc, score desc
        limit 100
      `,
      sql`
        select id, actor_id, entity_type, entity_key, action, created_at
        from public.ontology_management_actions
        order by created_at desc, id desc
        limit 100
      `,
      sql`select count(*)::int as n from public.graph_nodes where node_type = 'source'`,
      sql`select count(*)::int as n from public.symbols`,
      sql`select count(*)::int as n from public.research_queue where status = 'open'`,
      sql`select count(*)::int as n from public.strategy_tests where status = 'killed'`,
      sql`select count(*)::int as n from public.strategy_tests where status = 'survived'`,
      sql`select count(*)::int as n from public.test_scenarios`,
      optionalRows(
        'open_positions',
        sql`select count(*)::int as n from public.position_episodes where status in ('proposed', 'open', 'closing')`,
      ),
      optionalRows(
        'queued_tasks',
        sql`select count(*)::int as n from public.cloud_tasks where status in ('queued', 'running')`,
      ),
    ]);

    const [prediction, meme, team] = await Promise.all([
      loadPredictionMarkets(sql),
      loadMemeCoins(sql),
      loadTeam(sql),
    ]);
    return assembleDesk('postgres', decorateDesk(theses, symbols, {
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
      tests: mapTests(tests),
      backtest_artifacts: mapBacktestArtifacts(artifacts),
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
        sources: mapCount(sourceCount),
        symbols: mapCount(symbolCount),
        open_research: mapCount(openResearch),
        tests_killed: mapCount(testsKilled),
        tests_survived: mapCount(testsSurvived),
        scenario_cells: mapCount(scenarioCells),
        open_positions: mapCount(openPositions),
        queued_tasks: mapCount(queuedTasks),
      },
    }, prediction, meme, team));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function loadDeskFromRest(accessToken: string): Promise<DeskPayload> {
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
    restRows('theses?select=id,name,summary,status,confidence,time_horizon,stance,variant_perception,falsifier,created_at,updated_at&order=confidence.desc,name.asc', accessToken),
    restRows('thesis_symbols?select=thesis_id,symbol,role&order=weight_hint.desc,symbol.asc', accessToken),
    restRows('thesis_evidence?select=id,thesis_id,evidence_type,direction,summary,source_url,confidence,created_at&order=created_at.desc,id.desc&limit=200', accessToken),
    restRows('thesis_scores?select=id,thesis_id,scored_at,confidence,momentum,evidence_quality,catalyst_strength,portfolio_fit,risk,notes&order=scored_at.desc,id.desc&limit=400', accessToken),
    restRows('thesis_relations?select=src_thesis_id,dst_thesis_id,relation_type,strength,rationale', accessToken),
    restRows('runs?select=id,run_type,started_at,completed_at,notes&order=started_at.desc,id.desc&limit=80', accessToken),
    restRows('cloud_runs?select=id,trigger_key,trigger_source,market_slot,mode,status,scheduled_for,started_at,completed_at,error_text,summary&order=created_at.desc&limit=40', accessToken),
    restRows('cloud_tasks?select=id,run_id,task_type,entity_type,entity_key,status,attempt_count,error_text,queued_at,started_at,completed_at&order=queued_at.desc&limit=60', accessToken),
    restRows('codex_automations?select=id,name,status,rrule,model,next_run_at,last_run_at&order=status.asc,name.asc', accessToken),
    restRows('catalysts?select=id,thesis_id,symbol,catalyst_type,event_date,summary,source,status,created_at&order=event_date.asc,created_at.desc', accessToken),
    restRows('research_queue?select=id,priority,status,topic,reason,source,created_at,updated_at&order=priority.desc,created_at.desc', accessToken),
    restRows('research_lessons?select=id,cycle_id,test_id,thesis_id,lesson_type,summary,market_regime,incorporated,created_at&order=created_at.desc,id.desc', accessToken),
    restRows('postmortems?select=id,trade_proposal_id,thesis_id,created_at,outcome,lesson&order=created_at.desc,id.desc&limit=40', accessToken),
    restRows('research_cycles?select=id,external_key,thesis_id,hypothesis,preregistered_outcome,preregistered_at,stage,status,iteration,market_regime&order=updated_at.desc,id.desc', accessToken),
    restRows('strategy_tests?select=id,external_key,cycle_id,variant_label,status,total_return,max_drawdown,deflated_sharpe,cost_multiplier,stress_regime,failure_reason,autopsy,tested_at,price_source,window_start,window_end,symbols,params_json&order=tested_at.desc,id.desc', accessToken),
    restRows('backtest_artifacts?select=id,test_id,thesis_id,artifact_kind,title,mime_type,payload_json,storage_bucket,storage_path,source,created_at&order=created_at.desc,id.desc', accessToken),
    restRows('test_scenarios?select=id,test_id,scenario_key,market_regime,cost_multiplier,outcome,metric_value,breach_type&order=tested_at.desc,id.desc', accessToken),
    restRows('agent_runs?select=id,cycle_id,agent_role,independence_group,price_blinded,status,summary,created_at&order=created_at.desc,id.desc', accessToken),
    restRows('account_snapshots?select=observed_at,account_label,total_value,equity_value,cash,buying_power,source&account_label=ilike.*Agentic*&order=observed_at.desc,id.desc&limit=40', accessToken),
    restRows('account_snapshots?select=observed_at,account_label,total_value,equity_value,cash,buying_power,source&account_label=ilike.*Agentic*&order=observed_at.asc,id.asc&limit=1', accessToken),
    restRows('position_episodes?select=id,account_key,symbol,status,quantity,average_cost,opened_at,next_review_at&status=in.(proposed,open,closing)&order=symbol.asc', accessToken),
    restRows(`portfolio_exposure?select=symbol,quantity,average_buy_price,last_price,observed_at,account_last4&account_last4=eq.${AGENTIC_LAST4}&order=observed_at.desc,quantity.desc&limit=80`, accessToken),
    restRows('trade_intents?select=id,account_key,symbol,side,status,mode,notional,quantity,order_type,broker_order_id,created_at,updated_at&order=created_at.desc&limit=40', accessToken),
    restRows('trade_proposals?select=id,thesis_id,symbol,side,notional,order_type,status,rationale,created_at&order=created_at.desc,id.desc&limit=40', accessToken),
    restRows('broker_fills?select=id,trade_intent_id,quantity,price,executed_at&order=executed_at.desc&limit=40', accessToken),
    restRows('insights?select=id,title,summary,insight_type,novelty,confidence,status&order=updated_at.desc,id.desc&limit=40', accessToken),
    restRows('predictions?select=id,thesis_id,statement,target_date,probability,status&order=updated_at.desc,id.desc', accessToken),
    restRows('risk_controls?select=id,control_key,scope,control_type,threshold_json,enforcement_level,status&order=control_key.asc', accessToken),
    restRows('ontology_themes?select=id,thesis_id,kind,name,description,status,match_threshold,auto_promote_sources&order=status.asc,name.asc', accessToken),
    restRows('symbols?select=symbol,status,mention_count,source_count,first_seen_at,last_seen_at&order=source_count.desc,mention_count.desc&limit=300', accessToken),
    restRows('ontology_candidates?select=id,candidate_type,candidate_key,proposed_theme_id,proposed_label,proposed_description,score,evidence_count,source_count,status,last_seen_at,review_note&source_count=gte.2&order=status.asc,source_count.desc,score.desc&limit=100', accessToken),
    restRows('ontology_management_actions?select=id,actor_id,entity_type,entity_key,action,created_at&order=created_at.desc,id.desc&limit=100', accessToken),
  ]);

  const mappedTests = mapTests(tests);
  const mappedArtifacts = mapBacktestArtifacts(artifacts);
  const [prediction, meme, team] = await Promise.all([
    loadPredictionMarketsRest(accessToken),
    loadMemeCoinsRest(accessToken),
    loadTeamRest(accessToken),
  ]);
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

async function loadPredictionMarkets(sql: Sql): Promise<PredictionMarketsPayload> {
  try {
    const present = await sql`select to_regclass('public.pm_markets') is not null as ok`;
    if (!present[0]?.ok) return emptyPredictionMarkets();
    const [markets, positions, orders, fills, pnl, notes] = await Promise.all([
      sql`
        select id, venue, slug, question, status, close_time, last_yes, last_no,
               last_marked_at, thesis_id, rules_summary
        from public.pm_markets
        order by close_time nulls last, updated_at desc
        limit 200
      `,
      sql`
        select id, market_id, account_key, thesis_id, outcome, status, quantity,
               average_cost, mark, mark_at, thesis_text
        from public.pm_positions
        order by updated_at desc
        limit 200
      `,
      sql`
        select id, market_id, thesis_id, outcome, side, order_type, size, price,
               status, mode, venue_order_id, submitted_at, created_at
        from public.pm_orders
        order by created_at desc
        limit 200
      `,
      sql`
        select id, order_id, position_id, outcome, side, quantity, price, executed_at
        from public.pm_fills
        order by executed_at desc
        limit 200
      `,
      sql`
        select id, account_key, as_of, realized, unrealized, fees, cash, equity, notes
        from public.pm_pnl
        order by as_of desc
        limit 20
      `,
      sql`
        select id, market_id, thesis_id, note_type, title, body, created_at
        from public.pm_notes
        order by created_at desc
        limit 80
      `,
    ]);
    return mapPredictionMarkets({
      markets: markets as unknown as Record<string, unknown>[],
      positions: positions as unknown as Record<string, unknown>[],
      orders: orders as unknown as Record<string, unknown>[],
      fills: fills as unknown as Record<string, unknown>[],
      pnl: pnl as unknown as Record<string, unknown>[],
      notes: notes as unknown as Record<string, unknown>[],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (isPostgresPermissionDenied(message) || isPostgresUndefinedRelation(message)) {
      console.error(JSON.stringify({ event: 'prediction_ledger_skipped', error: message }));
      return emptyPredictionMarkets();
    }
    throw error;
  }
}

async function restOptional(path: string, accessToken: string): Promise<JsonObjectRow[]> {
  try {
    return await restRows(path, accessToken);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'ledger_rest_skipped',
      path,
      error: error instanceof Error ? error.message : 'unknown',
    }));
    return [];
  }
}

async function loadTeam(sql: Sql): Promise<DeskTeamPayload> {
  try {
    const present = await sql`select to_regclass('public.desk_agents') is not null as ok`;
    if (!present[0]?.ok) return assembleTeam(emptyTeam());
    const [agents, domains, stewards, accounts] = await Promise.all([
      sql`
        select id, slug, display_name, role_title, charter, accent, avatar_key,
               status, heartbeat_at, sort_order, meta
        from public.desk_agents
        order by sort_order, slug
      `,
      sql`
        select id, slug, name, kind, description, accent, status, sort_order, meta
        from public.desk_domains
        order by sort_order, slug
      `,
      sql`
        select id, domain_id, agent_id, is_primary, assigned_at, ended_at, note
        from public.desk_domain_stewards
        where ended_at is null
        order by assigned_at, id
      `,
      sql`
        select id, domain_id, account_key, label, currency, status
        from public.desk_accounts
        order by account_key
      `,
    ]);
    return assembleTeam({
      agents: agents as unknown as Record<string, unknown>[],
      domains: domains as unknown as Record<string, unknown>[],
      stewards: stewards as unknown as Record<string, unknown>[],
      accounts: accounts as unknown as Record<string, unknown>[],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (isPostgresPermissionDenied(message) || isPostgresUndefinedRelation(message)) {
      console.error(JSON.stringify({ event: 'team_ledger_skipped', error: message }));
      return assembleTeam(emptyTeam());
    }
    throw error;
  }
}

async function loadTeamRest(accessToken: string): Promise<DeskTeamPayload> {
  const [agents, domains, stewards, accounts] = await Promise.all([
    restOptional('desk_agents?select=id,slug,display_name,role_title,charter,accent,avatar_key,status,heartbeat_at,sort_order,meta&order=sort_order.asc,slug.asc', accessToken),
    restOptional('desk_domains?select=id,slug,name,kind,description,accent,status,sort_order,meta&order=sort_order.asc,slug.asc', accessToken),
    restOptional('desk_domain_stewards?select=id,domain_id,agent_id,is_primary,assigned_at,ended_at,note&ended_at=is.null&order=assigned_at.asc,id.asc', accessToken),
    restOptional('desk_accounts?select=id,domain_id,account_key,label,currency,status&order=account_key.asc', accessToken),
  ]);
  return assembleTeam({ agents, domains, stewards, accounts });
}

async function loadMemeCoins(sql: Sql): Promise<MemeCoinsPayload> {
  try {
    // Empty arrays with tables present usually means GRANT without
    // quantanamo_worker_select RLS — the BANDIT desk:publish miss. Permission
    // errors log as meme_ledger_skipped; silent empty is RLS.
    const present = await sql`select to_regclass('public.meme_tokens') is not null as ok`;
    if (!present[0]?.ok) return emptyMemeCoins();
    const [tokens, positions, orders, fills, pnl, notes] = await Promise.all([
      sql`
        select id, venue, mint, symbol, name, status, bonding_curve_status, graduated_at,
               last_price_sol, last_mcap_sol, last_marked_at, thesis_id, kill_criteria
        from public.meme_tokens
        order by updated_at desc
        limit 200
      `,
      sql`
        select id, token_id, account_key, thesis_id, status, quantity,
               average_cost_sol, mark_sol, mark_at, thesis_text
        from public.meme_positions
        order by updated_at desc
        limit 200
      `,
      sql`
        select id, token_id, account_key, thesis_id, side, order_type, size_sol, size_tokens,
               price_sol, status, mode, venue_order_id, submitted_at, created_at
        from public.meme_orders
        order by created_at desc
        limit 200
      `,
      sql`
        select id, order_id, position_id, account_key, side, quantity, price_sol, fee_sol, executed_at
        from public.meme_fills
        order by executed_at desc
        limit 200
      `,
      sql`
        select id, account_key, as_of, realized, unrealized, fees, cash_sol, equity_sol, notes
        from public.meme_pnl
        order by as_of desc
        limit 20
      `,
      sql`
        select id, token_id, thesis_id, note_type, title, body, created_at
        from public.meme_notes
        order by created_at desc
        limit 80
      `,
    ]);
    return mapMemeCoins({
      tokens: tokens as unknown as Record<string, unknown>[],
      positions: positions as unknown as Record<string, unknown>[],
      orders: orders as unknown as Record<string, unknown>[],
      fills: fills as unknown as Record<string, unknown>[],
      pnl: pnl as unknown as Record<string, unknown>[],
      notes: notes as unknown as Record<string, unknown>[],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (isPostgresPermissionDenied(message) || isPostgresUndefinedRelation(message)) {
      console.error(JSON.stringify({ event: 'meme_ledger_skipped', error: message }));
      return emptyMemeCoins();
    }
    throw error;
  }
}

async function loadMemeCoinsRest(accessToken: string): Promise<MemeCoinsPayload> {
  const [tokens, positions, orders, fills, pnl, notes] = await Promise.all([
    restOptional('meme_tokens?select=id,venue,mint,symbol,name,status,bonding_curve_status,graduated_at,last_price_sol,last_mcap_sol,last_marked_at,thesis_id,kill_criteria&order=updated_at.desc&limit=200', accessToken),
    restOptional('meme_positions?select=id,token_id,account_key,thesis_id,status,quantity,average_cost_sol,mark_sol,mark_at,thesis_text&order=updated_at.desc&limit=200', accessToken),
    restOptional('meme_orders?select=id,token_id,account_key,thesis_id,side,order_type,size_sol,size_tokens,price_sol,status,mode,venue_order_id,submitted_at,created_at&order=created_at.desc&limit=200', accessToken),
    restOptional('meme_fills?select=id,order_id,position_id,account_key,side,quantity,price_sol,fee_sol,executed_at&order=executed_at.desc&limit=200', accessToken),
    restOptional('meme_pnl?select=id,account_key,as_of,realized,unrealized,fees,cash_sol,equity_sol,notes&order=as_of.desc&limit=20', accessToken),
    restOptional('meme_notes?select=id,token_id,thesis_id,note_type,title,body,created_at&order=created_at.desc&limit=80', accessToken),
  ]);
  return mapMemeCoins({ tokens, positions, orders, fills, pnl, notes });
}

async function loadPredictionMarketsRest(accessToken: string): Promise<PredictionMarketsPayload> {
  const [markets, positions, orders, fills, pnl, notes] = await Promise.all([
    restOptional('pm_markets?select=id,venue,slug,question,status,close_time,last_yes,last_no,last_marked_at,thesis_id,rules_summary&order=close_time.asc.nullslast&limit=200', accessToken),
    restOptional('pm_positions?select=id,market_id,account_key,thesis_id,outcome,status,quantity,average_cost,mark,mark_at,thesis_text&order=updated_at.desc&limit=200', accessToken),
    restOptional('pm_orders?select=id,market_id,thesis_id,outcome,side,order_type,size,price,status,mode,venue_order_id,submitted_at,created_at&order=created_at.desc&limit=200', accessToken),
    restOptional('pm_fills?select=id,order_id,position_id,outcome,side,quantity,price,executed_at&order=executed_at.desc&limit=200', accessToken),
    restOptional('pm_pnl?select=id,account_key,as_of,realized,unrealized,fees,cash,equity,notes&order=as_of.desc&limit=20', accessToken),
    restOptional('pm_notes?select=id,market_id,thesis_id,note_type,title,body,created_at&order=created_at.desc&limit=80', accessToken),
  ]);
  return mapPredictionMarkets({ markets, positions, orders, fills, pnl, notes });
}

function bookFields(
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

function decorateDesk(
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

function assembleDesk(
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
