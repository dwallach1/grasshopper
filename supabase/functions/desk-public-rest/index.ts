/**
 * GET-only PostgREST proxy for grasshopper-desk.
 * The public Worker has no JWT secret and no service_role. This function
 * forwards SELECT paths for desk_public_reader tables using the platform
 * service role, then drops the privileged key. Writes are 405.
 */
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
]);

const TABLE_RE = /^\/rest\/v1\/([a-z0-9_]+)$/;

function restPath(url: URL): string | null {
  const raw = url.pathname.replace(/\/+$/, '') || '/';
  const marker = '/desk-public-rest';
  const idx = raw.indexOf(marker);
  const suffix = idx >= 0 ? raw.slice(idx + marker.length) : raw;
  const path = suffix.startsWith('/rest/v1/') ? suffix : `/rest/v1/${suffix.replace(/^\//, '')}`;
  return path === '/rest/v1' ? null : path;
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const url = new URL(req.url);
  const path = restPath(url);
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
  const response = await fetch(upstream, {
    method: 'GET',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: req.headers.get('Accept') || 'application/json',
      Prefer: req.headers.get('Prefer') || 'count=none',
    },
  });
  const body = await response.arrayBuffer();
  const headers = new Headers();
  const contentType = response.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'no-store');
  return new Response(body, { status: response.status, headers });
});
