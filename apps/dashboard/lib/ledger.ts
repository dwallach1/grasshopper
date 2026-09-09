import { mapBacktestArtifacts } from './backtest-artifacts';
import { z } from 'zod';

import {
  mapAgentRuns,
  mapAutomations,
  mapCandidates,
  mapCatalysts,
  mapCloudRuns,
  mapCloudTasks,
  mapCount,
  mapCycles,
  mapEvidence,
  mapFills,
  mapInsights,
  mapIntents,
  mapLessons,
  mapOntologyActions,
  mapOntologySymbols,
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
  type JsonObjectRow,
} from './ledger-map';
import { assembleTeam, emptyTeam } from './desk-team';
import type { DeskPayload, DeskTeamPayload } from './ledger-types';
import {
  emptyMemeCoins,
  mapMemeCoins,
  type MemeCoinsPayload,
} from './meme-book';
import { publicPublishableKey, publicSupabaseUrl } from './auth-env';
import {
  hasDatabaseUrl,
  isPostgresPermissionDenied,
  isPostgresUndefinedRelation,
  openSql,
  type Sql,
} from './postgres';
import { AGENTIC_LAST4 } from './book-performance';
import {
  emptyPredictionMarkets,
  mapPredictionMarkets,
  type PredictionMarketsPayload,
} from './prediction-book';
import {
  assembleDesk,
  bookFields,
  decorateDesk,
  loadDeskFromRest,
} from './ledger-live';

const JsonArraySchema = z.array(z.object({}).passthrough());

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
  return loadDeskFromRest({
    supabaseUrl: publicSupabaseUrl(),
    apiKey: publicPublishableKey(),
    accessToken,
  });
}

export { loadDeskFromRest, REST_FETCH_MS } from './ledger-live';

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
        limit 200
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
        select id, account_key, symbol, status, quantity, average_cost, opened_at, closed_at, next_review_at
        from public.position_episodes
        where status in ('proposed', 'open', 'closing', 'closed')
        order by opened_at desc nulls last, symbol
        limit 400
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
        limit 200
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
        limit 200
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
               average_cost, mark, mark_at, opened_at, closed_at, thesis_text
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
        limit 200
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

async function loadMemeCoins(sql: Sql): Promise<MemeCoinsPayload> {
  try {
    // Empty arrays with tables present usually means GRANT without
    // quantanamo_worker_select RLS. Permission errors log as
    // meme_ledger_skipped; silent empty is RLS.
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
               average_cost_sol, mark_sol, mark_at, opened_at, closed_at, thesis_text
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
        limit 200
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
