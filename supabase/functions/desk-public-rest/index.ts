/**
 * GET-only live desk reader for grasshopper-desk.
 * The public Worker has no JWT secret and no service_role. This function
 * SELECTs desk_public_reader tables and returns one bundle. Writes are 405.
 */
import { attachPnlStart, PNL_TAIL_LIMIT } from './pnl-inception.ts';

const ALLOWED_TABLES = new Set([
  'theses', 'thesis_symbols', 'thesis_evidence', 'thesis_scores', 'thesis_relations', 'runs',
  'cloud_runs', 'cloud_tasks', 'codex_automations', 'catalysts', 'research_queue', 'research_lessons',
  'postmortems', 'research_cycles', 'strategy_tests', 'test_scenarios', 'backtest_artifacts', 'agent_runs',
  'account_snapshots', 'position_episodes', 'portfolio_exposure', 'trade_intents', 'trade_proposals',
  'broker_fills', 'insights', 'predictions', 'risk_controls', 'ontology_themes', 'symbols',
  'ontology_candidates', 'ontology_management_actions',
  'pm_markets', 'pm_positions', 'pm_orders', 'pm_fills', 'pm_pnl', 'pm_notes',
  'meme_tokens', 'meme_positions', 'meme_orders', 'meme_fills', 'meme_pnl', 'meme_notes',
  'desk_agents', 'desk_domains', 'desk_domain_stewards', 'desk_accounts',
  'belief_updates', 'thesis_domains',
  // Outcome ledger scorecard (security_invoker views; read-only).
  'v_steward_scorecard', 'v_steward_scorecard_weekly', 'v_steward_trend', 'v_thesis_scorecard',
  // Ledger watchdog backstop (security_invoker views; read-only).
  'v_ledger_watchdog', 'v_invalidation_breaches', 'v_open_lots_missing_invalidation', 'v_ledger_integrity',
]);

const TABLE_RE = /^\/rest\/v1\/([a-z0-9_]+)$/;
const AGENTIC_LAST4 = '7638';

/** Slim /bundle/public keys. Omit beliefs/lessons here and the Worker hydrates []. */
const PUBLIC_KEYS = new Set([
  'theses', 'symbols', 'beliefs', 'lessons',
  'accountLatest', 'accountFirst', 'positions', 'exposures', 'intents', 'fills',
  'themes', 'candidates',
]);

/** Pending window before the phone cap of 40. Memberships sort first, so 72 still fills the queue. */
const PUBLIC_CANDIDATE_FETCH = 72;
/**
 * Recent marks for the phone liveline. When this window is full, `pnl_start`
 * is the ledger's earliest row — kept off the tail so chart density stays.
 * Operator `/bundle` uses PNL_TAIL_LIMIT and the same inception read.
 */
const PUBLIC_PNL_LIMIT = 28;
const PM_PNL_COLS = 'id,account_key,as_of,realized,unrealized,fees,cash,equity,notes';
const PM_PNL_PUBLIC_COLS = 'id,account_key,as_of,realized,unrealized,fees,cash,equity';
const MEME_PNL_COLS = 'id,account_key,as_of,realized,unrealized,fees,cash_sol,equity_sol,notes';
const MEME_PNL_PUBLIC_COLS = 'id,account_key,as_of,realized,unrealized,fees,cash_sol,equity_sol';
const PUBLIC_NOTE_LIMIT = 24;
const PUBLIC_NOTE_BODY = 200;
/** NAV / liveline window. Inception is a 1-row read only when this window is full. */
const PUBLIC_ACCOUNT_LIMIT = 56;
const PUBLIC_ORDER_LIMIT = 48;
const PUBLIC_FILL_LIMIT = 40;
/** Above the Theses rationale cap (180) so truncate-and-match still agrees. */
const PUBLIC_TEXT = 220;
const PUBLIC_RECENT_MS = 21 * 24 * 60 * 60 * 1000;
const ACCOUNT_COLS = 'observed_at,account_label,total_value,equity_value,cash,buying_power,source';
const AGENTIC_FILTER = 'account_label=ilike.*Agentic*';

const REQUIRED: Array<[string, string]> = [
  ['theses', 'theses?select=id,name,summary,status,confidence,time_horizon,stance,variant_perception,falsifier,created_at,updated_at&order=confidence.desc,name.asc'],
  ['symbols', 'thesis_symbols?select=thesis_id,symbol,role&order=weight_hint.desc,symbol.asc'],
  ['beliefs', 'belief_updates?select=id,thesis_id,domain_id,agent_id,prior_confidence,new_confidence,rationale,observed_at,meta&order=observed_at.desc,id.desc&limit=80'],
  ['evidence', 'thesis_evidence?select=id,thesis_id,evidence_type,direction,summary,source_url,confidence,created_at&order=created_at.desc,id.desc&limit=200'],
  ['scores', 'thesis_scores?select=id,thesis_id,scored_at,confidence,momentum,evidence_quality,catalyst_strength,portfolio_fit,risk,notes&order=scored_at.desc,id.desc&limit=400'],
  ['relations', 'thesis_relations?select=src_thesis_id,dst_thesis_id,relation_type,strength,rationale'],
  ['runs', 'runs?select=id,run_type,started_at,completed_at,notes&order=started_at.desc,id.desc&limit=80'],
  ['cloudRuns', 'cloud_runs?select=id,trigger_key,trigger_source,market_slot,mode,status,scheduled_for,started_at,completed_at,error_text,summary&order=created_at.desc&limit=40'],
  ['cloudTasks', 'cloud_tasks?select=id,run_id,task_type,entity_type,entity_key,status,attempt_count,error_text,queued_at,started_at,completed_at&order=queued_at.desc&limit=60'],
  ['automations', 'codex_automations?select=id,name,status,rrule,model,next_run_at,last_run_at&order=status.asc,name.asc'],
  ['catalysts', 'catalysts?select=id,thesis_id,symbol,catalyst_type,event_date,summary,source,status,created_at&order=event_date.asc,created_at.desc'],
  ['queue', 'research_queue?select=id,priority,status,topic,reason,source,created_at,updated_at&order=priority.desc,created_at.desc'],
  ['lessons', 'research_lessons?select=id,cycle_id,test_id,thesis_id,lesson_type,summary,market_regime,incorporated,created_at&order=created_at.desc,id.desc'],
  ['postmortems', 'postmortems?select=id,trade_proposal_id,thesis_id,created_at,outcome,lesson&order=created_at.desc,id.desc&limit=40'],
  ['cycles', 'research_cycles?select=id,external_key,thesis_id,hypothesis,preregistered_outcome,preregistered_at,stage,status,iteration,market_regime&order=updated_at.desc,id.desc'],
  ['tests', 'strategy_tests?select=id,external_key,cycle_id,variant_label,status,total_return,max_drawdown,deflated_sharpe,cost_multiplier,stress_regime,failure_reason,autopsy,tested_at,price_source,window_start,window_end,symbols,params_json&order=tested_at.desc,id.desc'],
  ['artifacts', 'backtest_artifacts?select=id,test_id,thesis_id,artifact_kind,title,mime_type,payload_json,storage_bucket,storage_path,source,created_at&order=created_at.desc,id.desc'],
  ['scenarios', 'test_scenarios?select=id,test_id,scenario_key,market_regime,cost_multiplier,outcome,metric_value,breach_type&order=tested_at.desc,id.desc'],
  ['agentRuns', 'agent_runs?select=id,cycle_id,agent_role,independence_group,price_blinded,status,summary,created_at&order=created_at.desc,id.desc'],
  ['accountLatest', 'account_snapshots?select=observed_at,account_label,total_value,equity_value,cash,buying_power,source&account_label=ilike.*Agentic*&order=observed_at.desc,id.desc&limit=200'],
  ['accountFirst', 'account_snapshots?select=observed_at,account_label,total_value,equity_value,cash,buying_power,source&account_label=ilike.*Agentic*&order=observed_at.asc,id.asc&limit=1'],
  ['positions', 'position_episodes?select=id,account_key,symbol,status,quantity,average_cost,opened_at,closed_at,next_review_at,thesis_id,invalidation_price,invalidation_note,untagged:meta->>untagged&status=in.(proposed,open,closing,closed)&order=opened_at.desc.nullslast,symbol.asc&limit=400'],
  ['exposures', `portfolio_exposure?select=symbol,quantity,average_buy_price,last_price,observed_at,account_last4&account_last4=eq.${AGENTIC_LAST4}&order=observed_at.desc,quantity.desc&limit=80`],
  ['intents', 'trade_intents?select=id,account_key,symbol,side,status,mode,notional,quantity,order_type,broker_order_id,created_at,updated_at&order=created_at.desc&limit=200'],
  ['proposals', 'trade_proposals?select=id,thesis_id,symbol,side,notional,order_type,status,rationale,created_at&order=created_at.desc,id.desc&limit=40'],
  ['fills', 'broker_fills?select=id,trade_intent_id,quantity,price,executed_at&order=executed_at.desc&limit=200'],
  ['insights', 'insights?select=id,title,summary,insight_type,novelty,confidence,status&order=updated_at.desc,id.desc&limit=40'],
  ['predictions', 'predictions?select=id,thesis_id,statement,target_date,probability,status&order=updated_at.desc,id.desc'],
  ['riskControls', 'risk_controls?select=id,control_key,scope,control_type,threshold_json,enforcement_level,status&order=control_key.asc'],
  ['themes', 'ontology_themes?select=id,thesis_id,kind,name,description,status,match_threshold,auto_promote_sources&order=status.asc,name.asc'],
  ['ontologySymbols', 'symbols?select=symbol,status,mention_count,source_count,first_seen_at,last_seen_at&order=source_count.desc,mention_count.desc&limit=300'],
  ['candidates', 'ontology_candidates?select=id,candidate_type,candidate_key,proposed_theme_id,proposed_label,proposed_description,score,evidence_count,source_count,status,last_seen_at,review_note,listed_equity&order=candidate_type.asc,status.asc,score.desc,source_count.desc,id.desc&limit=200'],
  ['actions', 'ontology_management_actions?select=id,actor_id,entity_type,entity_key,action,created_at&order=created_at.desc,id.desc&limit=100'],
];

const PM: Array<[string, string]> = [
  ['markets', 'pm_markets?select=id,venue,slug,question,status,close_time,last_yes,last_no,last_marked_at,thesis_id,rules_summary&order=close_time.asc.nullslast&limit=200'],
  ['positions', 'pm_positions?select=id,market_id,account_key,thesis_id,outcome,status,quantity,average_cost,mark,mark_at,opened_at,closed_at,thesis_text,invalidation_price,invalidation_note,untagged:meta->>untagged&order=updated_at.desc&limit=200'],
  ['orders', 'pm_orders?select=id,market_id,thesis_id,outcome,side,order_type,size,price,status,mode,venue_order_id,submitted_at,created_at&order=created_at.desc&limit=200'],
  ['fills', 'pm_fills?select=id,order_id,position_id,outcome,side,quantity,price,executed_at&order=executed_at.desc&limit=200'],
  ['notes', 'pm_notes?select=id,market_id,thesis_id,note_type,title,body,created_at&order=created_at.desc&limit=80'],
];

/** Steward scorecard views. Optional: before the outcome migration these serve []. */
const SCORECARD: Array<[string, string]> = [
  ['stewards', 'v_steward_scorecard?select=*&order=sort_order.asc'],
  ['weekly', 'v_steward_scorecard_weekly?select=steward,unit,week_start,iso_week,is_current,trades,priced_trades,wins,hit_rate,realized_pnl&order=week_start.desc,steward.asc&limit=60'],
  ['trend', 'v_steward_trend?select=steward,recent_n,prior_n,recent_expectancy,prior_expectancy,thin,direction'],
  ['theses', 'v_thesis_scorecard?select=thesis_id,name,steward,stated_confidence,outcome_implied_confidence,confidence_gap,priced_trades,wins,miscalibrated,thin&order=priced_trades.desc'],
];

/** Ledger watchdog views (same queries as apps/dashboard/lib/ledger-watchdog.ts). Optional. */
const WATCHDOG: Array<[string, string]> = [
  ['summary', 'v_ledger_watchdog?select=*'],
  ['breaches', 'v_invalidation_breaches?select=steward,lot_table,lot_id,instrument,unit,thesis_id,invalidation_price,mark,mark_at,mark_age_minutes,action_hint&order=mark_at.desc&limit=50'],
  ['missing', 'v_open_lots_missing_invalidation?select=steward,lot_table,lot_id,instrument,unit,thesis_id,mark,mark_at,opened_at&order=opened_at.asc&limit=50'],
  ['issues', 'v_ledger_integrity?select=check_name,severity,steward,ref_table,ref_id,instrument,detail,at&order=at.desc.nullslast&limit=50'],
];

const MEME: Array<[string, string]> = [
  ['tokens', 'meme_tokens?select=id,venue,mint,symbol,name,status,bonding_curve_status,graduated_at,last_price_sol,last_mcap_sol,last_marked_at,thesis_id,kill_criteria&order=updated_at.desc&limit=200'],
  ['positions', 'meme_positions?select=id,token_id,account_key,thesis_id,status,quantity,average_cost_sol,mark_sol,mark_at,opened_at,closed_at,thesis_text,invalidation_price,invalidation_note,untagged:meta->>untagged&order=updated_at.desc&limit=200'],
  ['orders', 'meme_orders?select=id,token_id,account_key,thesis_id,side,order_type,size_sol,size_tokens,price_sol,status,mode,venue_order_id,submitted_at,created_at&order=created_at.desc&limit=200'],
  ['fills', 'meme_fills?select=id,order_id,position_id,account_key,side,quantity,price_sol,fee_sol,executed_at&order=executed_at.desc&limit=200'],
  ['notes', 'meme_notes?select=id,token_id,thesis_id,note_type,title,body,created_at&order=created_at.desc&limit=80'],
];

const TEAM: Array<[string, string]> = [
  ['agents', 'desk_agents?select=id,slug,display_name,role_title,charter,accent,avatar_key,status,heartbeat_at,sort_order,meta&order=sort_order.asc,slug.asc'],
  ['domains', 'desk_domains?select=id,slug,name,kind,description,accent,status,sort_order,meta&order=sort_order.asc,slug.asc'],
  ['stewards', 'desk_domain_stewards?select=id,domain_id,agent_id,is_primary,assigned_at,ended_at,note&ended_at=is.null&order=assigned_at.asc,id.asc'],
  ['accounts', 'desk_accounts?select=id,domain_id,account_key,label,currency,status&order=account_key.asc'],
];

function restPath(url: URL): string | null {
  const raw = url.pathname.replace(/\/+$/, '') || '/';
  const marker = '/desk-public-rest';
  const idx = raw.indexOf(marker);
  const suffix = idx >= 0 ? raw.slice(idx + marker.length) : raw;
  if (
    suffix === '/bundle/public' || suffix === 'bundle/public' || raw.endsWith('/bundle/public')
  ) return '/bundle/public';
  if (suffix === '/bundle' || suffix === 'bundle' || raw.endsWith('/bundle')) return '/bundle';
  const path = suffix.startsWith('/rest/v1/') ? suffix : `/rest/v1/${suffix.replace(/^\//, '')}`;
  return path === '/rest/v1' ? null : path;
}

function restHeaders(): HeadersInit {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: 'application/json',
    Prefer: 'count=none',
  };
}

async function restGet(query: string, optional = false): Promise<unknown[]> {
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
  const table = query.split('?')[0];
  if (!table || !ALLOWED_TABLES.has(table)) {
    if (optional) return [];
    throw new Error(`${table || 'unknown'}:not_allowed`);
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/${query}`, { headers: restHeaders() });
  if (!response.ok) {
    if (optional) return [];
    throw new Error(`${table}:${response.status}`);
  }
  const body: unknown = await response.json();
  return Array.isArray(body) ? body : [];
}

async function objectFrom(pairs: Array<[string, string]>, optional = true): Promise<Record<string, unknown[]>> {
  const entries = await Promise.all(pairs.map(async ([key, query]) => [key, await restGet(query, optional)] as const));
  return Object.fromEntries(entries);
}

function asRows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clipText(value: unknown, max: number): unknown {
  if (typeof value !== 'string' || value.length <= max) return value;
  return value.slice(0, max);
}

function clipRows(rows: unknown[], field: string, max: number): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const record = row as Record<string, unknown>;
    const next = clipText(record[field], max);
    if (next === record[field]) return row;
    return { ...record, [field]: next };
  });
}

/** Open (not filled/canceled/rejected/expired) plus rows newer than `since`. */
function openOrRecent(timeColumn: string, since: string): string {
  const live = [
    'status.neq.filled',
    'status.neq.canceled',
    'status.neq.cancelled',
    'status.neq.rejected',
    'status.neq.expired',
  ].join(',');
  return `or=(and(${live}),${timeColumn}.gte.${since})`;
}

function publicCandidateQuery(): string {
  return `ontology_candidates?select=id,candidate_type,candidate_key,proposed_theme_id,proposed_label,proposed_description,score,evidence_count,source_count,status,last_seen_at,review_note,listed_equity&status=eq.pending&order=candidate_type.asc,score.desc,source_count.desc,id.desc&limit=${PUBLIC_CANDIDATE_FETCH}`;
}

function publicPm(since: string): Array<[string, string]> {
  const orders = openOrRecent('created_at', since);
  return [
    ['markets', 'pm_markets?select=id,venue,slug,question,status,close_time,last_yes,last_no,last_marked_at,thesis_id&order=close_time.asc.nullslast&limit=200'],
    ['positions', 'pm_positions?select=id,market_id,account_key,thesis_id,outcome,status,quantity,average_cost,mark,mark_at,opened_at,closed_at,invalidation_price,invalidation_note,untagged:meta->>untagged&order=updated_at.desc&limit=200'],
    ['orders', `pm_orders?select=id,market_id,thesis_id,outcome,side,order_type,size,price,status,mode,venue_order_id,submitted_at,created_at&${orders}&order=created_at.desc&limit=${PUBLIC_ORDER_LIMIT}`],
    ['fills', `pm_fills?select=id,order_id,position_id,outcome,side,quantity,price,executed_at&order=executed_at.desc&limit=${PUBLIC_FILL_LIMIT}`],
    ['notes', `pm_notes?select=id,market_id,thesis_id,note_type,title,body,created_at&order=created_at.desc&limit=${PUBLIC_NOTE_LIMIT}`],
  ];
}

function publicMeme(since: string): Array<[string, string]> {
  const orders = openOrRecent('created_at', since);
  return [
    ['tokens', 'meme_tokens?select=id,venue,mint,symbol,name,status,bonding_curve_status,graduated_at,last_price_sol,last_mcap_sol,last_marked_at,thesis_id&order=updated_at.desc&limit=200'],
    ['positions', 'meme_positions?select=id,token_id,account_key,thesis_id,status,quantity,average_cost_sol,mark_sol,mark_at,opened_at,closed_at,invalidation_price,invalidation_note,untagged:meta->>untagged&order=updated_at.desc&limit=200'],
    ['orders', `meme_orders?select=id,token_id,account_key,thesis_id,side,order_type,size_sol,size_tokens,price_sol,status,mode,venue_order_id,submitted_at,created_at&${orders}&order=created_at.desc&limit=${PUBLIC_ORDER_LIMIT}`],
    ['fills', `meme_fills?select=id,order_id,position_id,account_key,side,quantity,price_sol,fee_sol,executed_at&order=executed_at.desc&limit=${PUBLIC_FILL_LIMIT}`],
    ['notes', `meme_notes?select=id,token_id,thesis_id,note_type,title,body,created_at&order=created_at.desc&limit=${PUBLIC_NOTE_LIMIT}`],
  ];
}

/**
 * Recent pnl tail plus the ledger's earliest mark when the tail is full.
 * The start row is `pnl_start`, not another point on the liveline.
 * Account snapshots still skip the inception read when their own window is short.
 */
async function pnlWindow(table: 'pm_pnl' | 'meme_pnl', cols: string, limit: number): Promise<{ pnl: unknown[]; pnl_start: unknown | null }> {
  const [latest, first] = await Promise.all([
    restGet(`${table}?select=${cols}&order=as_of.desc,id.desc&limit=${limit}`),
    restGet(`${table}?select=${cols}&order=as_of.asc,id.asc&limit=1`),
  ]);
  return attachPnlStart(latest, first[0] ?? null, limit);
}

async function publicAccountWindow(): Promise<{ accountLatest: unknown[]; accountFirst: unknown[] }> {
  const latest = await restGet(
    `account_snapshots?select=${ACCOUNT_COLS}&${AGENTIC_FILTER}&order=observed_at.desc,id.desc&limit=${PUBLIC_ACCOUNT_LIMIT}`,
  );
  if (latest.length < PUBLIC_ACCOUNT_LIMIT) {
    const oldest = latest.length ? latest[latest.length - 1] : null;
    return { accountLatest: latest, accountFirst: oldest ? [oldest] : [] };
  }
  const first = await restGet(
    `account_snapshots?select=${ACCOUNT_COLS}&${AGENTIC_FILTER}&order=observed_at.asc,id.asc&limit=1`,
  );
  return { accountLatest: latest, accountFirst: first };
}

async function handleBundle(mode: 'full' | 'public'): Promise<Response> {
  try {
    const since = mode === 'public' ? new Date(Date.now() - PUBLIC_RECENT_MS).toISOString() : '';
    const tables = (mode === 'public'
      ? REQUIRED.filter(([key]) => PUBLIC_KEYS.has(key) && key !== 'accountLatest' && key !== 'accountFirst')
      : REQUIRED
    ).map(([key, query]) => {
      if (mode !== 'public') return [key, query] as const;
      if (key === 'candidates') return [key, publicCandidateQuery()] as const;
      if (key === 'intents') {
        return [key, `trade_intents?select=id,account_key,symbol,side,status,mode,notional,quantity,order_type,broker_order_id,created_at,updated_at&${openOrRecent('created_at', since)}&order=created_at.desc&limit=${PUBLIC_ORDER_LIMIT}`] as const;
      }
      if (key === 'fills') {
        return [key, `broker_fills?select=id,trade_intent_id,quantity,price,executed_at&order=executed_at.desc&limit=${PUBLIC_FILL_LIMIT}`] as const;
      }
      return [key, query] as const;
    });
    const pnlLimit = mode === 'public' ? PUBLIC_PNL_LIMIT : PNL_TAIL_LIMIT;
    const pmPnlCols = mode === 'public' ? PM_PNL_PUBLIC_COLS : PM_PNL_COLS;
    const memePnlCols = mode === 'public' ? MEME_PNL_PUBLIC_COLS : MEME_PNL_COLS;
    const [required, pmRaw, memeRaw, team, accounts, pmPnl, memePnl, scorecard, watchdog] = await Promise.all([
      Promise.all(tables.map(async ([key, query]) => [key, await restGet(query)] as const)),
      objectFrom(mode === 'public' ? publicPm(since) : PM),
      objectFrom(mode === 'public' ? publicMeme(since) : MEME),
      objectFrom(TEAM),
      mode === 'public' ? publicAccountWindow() : Promise.resolve(null),
      pnlWindow('pm_pnl', pmPnlCols, pnlLimit),
      pnlWindow('meme_pnl', memePnlCols, pnlLimit),
      objectFrom(SCORECARD),
      objectFrom(WATCHDOG),
    ]);
    const body: Record<string, unknown> = Object.fromEntries(required);
    let pm: Record<string, unknown> = { ...pmRaw, pnl: pmPnl.pnl, pnl_start: pmPnl.pnl_start };
    let meme: Record<string, unknown> = { ...memeRaw, pnl: memePnl.pnl, pnl_start: memePnl.pnl_start };
    if (accounts) {
      body.accountLatest = accounts.accountLatest;
      body.accountFirst = accounts.accountFirst;
      body.beliefs = clipRows(asRows(body.beliefs), 'rationale', PUBLIC_TEXT);
      body.lessons = clipRows(asRows(body.lessons), 'summary', PUBLIC_TEXT);
      pm = { ...pm, notes: clipRows(asRows(pm.notes), 'body', PUBLIC_NOTE_BODY) };
      meme = { ...meme, notes: clipRows(asRows(meme.notes), 'body', PUBLIC_NOTE_BODY) };
    }
    return Response.json({
      ...body,
      pm,
      meme,
      team,
      scorecard,
      watchdog,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'desk_public_rest_bundle_failed',
      mode,
      error: error instanceof Error ? error.message : 'unknown',
    }));
    return Response.json({ error: 'Desk ledger unavailable' }, { status: 503 });
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const url = new URL(req.url);
  const path = restPath(url);
  if (path === '/bundle/public') return handleBundle('public');
  if (path === '/bundle') return handleBundle('full');
  if (!path) return Response.json({ error: 'Not found' }, { status: 404 });
  const match = TABLE_RE.exec(path);
  const table = match?.[1];
  if (!table || !ALLOWED_TABLES.has(table)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: 'Desk ledger unavailable' }, { status: 503 });
  }

  const upstream = `${supabaseUrl}${path}${url.search}`;
  const response = await fetch(upstream, { method: 'GET', headers: restHeaders() });
  const body = await response.arrayBuffer();
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  const contentType = response.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);
  return new Response(body, { status: response.status, headers });
});
