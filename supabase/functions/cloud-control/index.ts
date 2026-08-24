const EXPECTED_TOKEN_SHA256 = 'a1d1ec8f0148d08edd7373dc60b1f2c13e7e86558751e4007fbae7ebd39b2daa';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel('body size limit exceeded');
        throw new Error('body size limit exceeded');
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
  return new TextDecoder().decode(output);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function authorized(request: Request): Promise<boolean> {
  const token = request.headers.get('x-thesisforge-publication-token') || '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return constantTimeEqual(hex(digest), EXPECTED_TOKEN_SHA256);
}

function secretApiKey(): string {
  const namedSecrets = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (namedSecrets) {
    const parsed = JSON.parse(namedSecrets) as Record<string, string>;
    if (parsed.default) return parsed.default;
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('Supabase secret API key is unavailable');
}

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const apiKey = secretApiKey();
  const headers: Record<string, string> = {
    apikey: apiKey,
    'content-type': 'application/json',
    ...extra,
  };
  if (!apiKey.startsWith('sb_secret_')) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) throw new Error('SUPABASE_URL is unavailable');
  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: restHeaders((init.headers || {}) as Record<string, string>),
  });
  const raw = await boundedText(response.body, MAX_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`Data API ${response.status}: ${raw.slice(0, 400)}`);
  return raw ? JSON.parse(raw) : null;
}

function requireObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object');
  return value as JsonObject;
}

async function context(): Promise<unknown> {
  const [snapshotRows, openPositions, recentTasks, riskControls, approvedProposals] = await Promise.all([
    rest('dashboard_snapshots?id=eq.current&select=generated_at,payload'),
    rest('position_episodes?status=in.(proposed,open,closing)&select=*&order=updated_at.desc&limit=100'),
    rest('cloud_tasks?task_type=eq.thesis_research&status=eq.complete&select=entity_key,input_sha256&order=queued_at.desc&limit=500'),
    rest('risk_controls?status=eq.active&select=control_key,scope,control_type,threshold_json,enforcement_level,status,updated_at'),
    rest('trade_proposals?status=eq.approved&notional=gt.0&select=id,thesis_id,symbol,side,notional,order_type,status,rationale,created_at,broker_alerts&order=created_at.asc&limit=20'),
  ]);
  const rows = Array.isArray(snapshotRows) ? snapshotRows : [];
  const latestInputs: Record<string, string> = {};
  for (const row of Array.isArray(recentTasks) ? recentTasks : []) {
    if (!isObject(row) || typeof row.entity_key !== 'string' || typeof row.input_sha256 !== 'string') continue;
    if (!(row.entity_key in latestInputs)) latestInputs[row.entity_key] = row.input_sha256;
  }
  return {
    snapshot: rows[0] || null,
    open_positions: Array.isArray(openPositions) ? openPositions : [],
    latest_thesis_input_sha256: latestInputs,
    risk_controls: Array.isArray(riskControls) ? riskControls : [],
    approved_proposals: Array.isArray(approvedProposals) ? approvedProposals : [],
    broker_gateway: { available: true, mode: 'robinhood_mcp' },
  };
}

async function upsert(table: 'cloud_runs' | 'cloud_tasks', payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  const conflict = table === 'cloud_runs' ? 'trigger_key' : 'idempotency_key';
  return rest(`${table}?on_conflict=${conflict}`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(record),
  });
}

async function finalizeRun(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  if (typeof record.run_id !== 'string') throw new Error('run_id is required');
  const runId = encodeURIComponent(record.run_id);
  const tasks = await rest(`cloud_tasks?run_id=eq.${runId}&select=status`);
  const rows = Array.isArray(tasks) ? tasks : [];
  const terminal = new Set(['complete', 'skipped', 'failed', 'dead_letter']);
  const pending = rows.filter((row) => isObject(row) && !terminal.has(String(row.status))).length;
  if (pending > 0) return { finalized: false, pending };
  await rest(`cloud_runs?id=eq.${runId}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'complete', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  return { finalized: true, pending: 0 };
}

async function recordAccountSnapshot(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  const snapshot = requireObject(record.snapshot);
  const positions = Array.isArray(record.positions) ? record.positions.map(requireObject) : [];
  const inserted = await rest('account_snapshots', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(snapshot),
  });
  if (positions.length > 0) {
    await rest('portfolio_exposure', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify(positions),
    });
  }
  return inserted;
}

async function upsertTradeIntent(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  return rest('trade_intents?on_conflict=broker_ref_id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(record),
  });
}

async function upsertExecutionAttempt(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  return rest('broker_execution_attempts?on_conflict=trade_intent_id,request_fingerprint', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(record),
  });
}

async function updateTradeProposal(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  if (!Number.isInteger(record.id)) throw new Error('proposal id is required');
  const id = Number(record.id);
  const patch: JsonObject = {};
  if (typeof record.status === 'string') patch.status = record.status;
  if (typeof record.reviewed_at === 'string') patch.reviewed_at = record.reviewed_at;
  if (isObject(record.broker_alerts)) patch.broker_alerts = record.broker_alerts;
  return rest(`trade_proposals?id=eq.${id}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
}

async function createTradeProposal(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  return rest('trade_proposals', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(record),
  });
}

async function syncPositionEpisodes(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  if (typeof record.account_key !== 'string' || typeof record.observed_at !== 'string') {
    throw new Error('account_key and observed_at are required');
  }
  const accountKey = record.account_key;
  const observedAt = record.observed_at;
  const positions = Array.isArray(record.positions) ? record.positions.map(requireObject) : [];
  const accountFilter = encodeURIComponent(accountKey);
  const existingValue = await rest(
    `position_episodes?account_key=eq.${accountFilter}&status=in.(proposed,open,closing)&select=*`,
  );
  const existing = Array.isArray(existingValue) ? existingValue.filter(isObject) : [];
  const activeSymbols = new Set<string>();

  for (const position of positions) {
    const symbol = String(position.symbol || '').trim().toUpperCase();
    const quantity = Number(position.quantity);
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol) || !Number.isFinite(quantity) || quantity <= 0) continue;
    activeSymbols.add(symbol);
    await rest('symbols?on_conflict=symbol', {
      method: 'POST',
      headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        symbol, first_seen_at: observedAt, last_seen_at: observedAt,
        mention_count: 0, source_count: 0, status: 'verified',
      }),
    });
    const current = existing.find((row) => row.symbol === symbol);
    const episodePatch = {
      account_key: accountKey,
      symbol,
      status: 'open',
      quantity,
      average_cost: position.average_buy_price == null ? null : Number(position.average_buy_price),
      opened_at: current?.opened_at || observedAt,
      closed_at: null,
      next_review_at: position.next_review_at || null,
      monitor_policy: isObject(position.monitor_policy) ? position.monitor_policy : {},
      updated_at: observedAt,
    };
    if (current && typeof current.id === 'string') {
      await rest(`position_episodes?id=eq.${encodeURIComponent(current.id)}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(episodePatch),
      });
    } else {
      await rest('position_episodes', {
        method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(episodePatch),
      });
    }
  }

  for (const episode of existing) {
    if (typeof episode.id !== 'string' || typeof episode.symbol !== 'string' || activeSymbols.has(episode.symbol)) continue;
    await rest(`position_episodes?id=eq.${encodeURIComponent(episode.id)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'closed', quantity: 0, closed_at: observedAt, next_review_at: null, updated_at: observedAt }),
    });
  }
  return rest(
    `position_episodes?account_key=eq.${accountFilter}&status=eq.open&select=*&order=symbol.asc`,
  );
}

async function recordPositionMonitorEvent(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  const episodeId = String(record.position_episode_id || '');
  if (!episodeId) throw new Error('position_episode_id is required');
  const event = {
    position_episode_id: episodeId,
    event_type: String(record.event_type || 'scheduled_review'),
    recommendation: record.recommendation == null ? null : String(record.recommendation),
    evidence: isObject(record.evidence) ? record.evidence : {},
    observed_at: String(record.observed_at || new Date().toISOString()),
  };
  const inserted = await rest('position_monitor_events', {
    method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(event),
  });
  await rest(`position_episodes?id=eq.${encodeURIComponent(episodeId)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      last_recommendation: {
        recommendation: event.recommendation,
        evidence: event.evidence,
        observed_at: event.observed_at,
      },
      updated_at: event.observed_at,
    }),
  });
  return inserted;
}

async function patchPositionEpisode(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  const id = String(record.id || '');
  if (!id) throw new Error('position episode id is required');
  const patch: JsonObject = {};
  for (const key of ['status', 'quantity', 'average_cost', 'closed_at', 'next_review_at', 'last_recommendation', 'monitor_policy', 'updated_at']) {
    if (key in record) patch[key] = record[key];
  }
  return rest(`position_episodes?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
}

async function recordBrokerFills(payload: unknown): Promise<unknown> {
  const record = requireObject(payload);
  const fills = Array.isArray(record.fills) ? record.fills.map(requireObject) : [];
  if (fills.length === 0) return [];
  return rest('broker_fills?on_conflict=broker_fill_id', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(fills),
  });
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!(await authorized(request))) return json({ error: 'Unauthorized' }, 401);

  try {
    const raw = await boundedText(request.body, MAX_REQUEST_BYTES);
    const body = requireObject(raw ? JSON.parse(raw) : {});
    const action = body.action;
    if (action === 'context') return json(await context());
    if (action === 'upsert_run') return json(await upsert('cloud_runs', body.payload));
    if (action === 'upsert_task') return json(await upsert('cloud_tasks', body.payload));
    if (action === 'finalize_run') return json(await finalizeRun(body.payload));
    if (action === 'record_account_snapshot') return json(await recordAccountSnapshot(body.payload));
    if (action === 'upsert_trade_intent') return json(await upsertTradeIntent(body.payload));
    if (action === 'upsert_execution_attempt') return json(await upsertExecutionAttempt(body.payload));
    if (action === 'update_trade_proposal') return json(await updateTradeProposal(body.payload));
    if (action === 'create_trade_proposal') return json(await createTradeProposal(body.payload));
    if (action === 'sync_position_episodes') return json(await syncPositionEpisodes(body.payload));
    if (action === 'record_position_monitor_event') return json(await recordPositionMonitorEvent(body.payload));
    if (action === 'patch_position_episode') return json(await patchPositionEpisode(body.payload));
    if (action === 'record_broker_fills') return json(await recordBrokerFills(body.payload));
    return json({ error: 'Unsupported action' }, 400);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'cloud_control_error',
      error: error instanceof Error ? error.message : 'unknown',
    }));
    return json({ error: 'Cloud control request failed' }, 502);
  }
});
