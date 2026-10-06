/**
 * steward-rpc: the HTTPS path for steward ledger writes (BANDIT live_trade_clip, ODDSBORNE pm_enter).
 *
 * Why: the agent box only egresses HTTPS. Raw Postgres (pooler 5432/6543) times out there, so the
 * steward scripts call this function instead of opening a psycopg connection.
 *
 * Auth is the steward's own Postgres login: `Authorization: Basic base64("<steward>_worker:<password>")`.
 * The function opens a connection AS that role, so every grant, RLS policy, trigger and gate the
 * direct connection had still applies (no service_role, no new secret). verify_jwt is off because the
 * stewards hold no Supabase API key; a wrong password fails at Postgres login.
 *
 * Body: {"fn": "<allowlisted function>", "args": {...}}. Each call runs
 *   select public.<fn>($1::text::jsonb)::text
 * in one transaction (the SQL functions are SECURITY INVOKER; supabase/schemas/50_steward_entry_rpc.sql).
 * The jsonb result is returned verbatim as text so numerics keep their exact digits.
 * "ping" is built in: it returns the connected role and the database time (read-only).
 */
import postgres from 'npm:postgres@3.4.5';

const ALLOWED: Record<string, ReadonlySet<string>> = {
  oddsborne_worker: new Set([
    'steward_entry_guidance',
    'oddsborne_entry_upsert_market',
    'oddsborne_entry_record_order',
    'oddsborne_entry_record_fills',
    'oddsborne_entry_upsert_position',
    'oddsborne_entry_heartbeat',
  ]),
  bandit_worker: new Set([
    'steward_entry_guidance',
    'bandit_entry_open_order',
    'bandit_entry_reject_order',
    'bandit_entry_record_fill',
    'bandit_shadow_exit_marks',
    'bandit_write_shadow_exit',
  ]),
};
const FN_RE = /^[a-z][a-z0-9_]{2,62}$/;
const MAX_BODY = 512 * 1024;

function reply(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return reply(status, JSON.stringify({ ok: false, error: { code, message, ...extra } }));
}

function credentials(req: Request): { role: string; password: string } | null {
  const header = req.headers.get('authorization') || '';
  const m = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  let decoded = '';
  try {
    decoded = atob(m[1]);
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i < 1) return null;
  return { role: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

/** Same database the platform hands this function (SUPABASE_DB_URL), logged in as the steward role. */
function dbTarget(role: string): { host: string; port: number; username: string; database: string } {
  const raw = Deno.env.get('SUPABASE_DB_URL');
  if (!raw) throw new Error('SUPABASE_DB_URL not set');
  const url = new URL(raw);
  const platformUser = decodeURIComponent(url.username);
  const dot = platformUser.indexOf('.');
  // Pooler URLs carry "<user>.<project ref>"; direct URLs carry the bare role.
  const username = dot > 0 ? `${role}${platformUser.slice(dot)}` : role;
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    username,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return fail(405, 'method', 'POST only');
  const cred = credentials(req);
  if (!cred || !Object.hasOwn(ALLOWED, cred.role)) return fail(401, 'auth', 'Basic auth as a steward worker role is required');

  const text = await req.text();
  if (text.length > MAX_BODY) return fail(413, 'too_large', 'body over 512 KiB');
  let body: { fn?: unknown; args?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'bad_json', 'body is not JSON');
  }
  const fn = typeof body.fn === 'string' ? body.fn : '';
  const isPing = fn === 'ping';
  if (!isPing && (!FN_RE.test(fn) || !ALLOWED[cred.role].has(fn))) {
    return fail(403, 'fn_not_allowed', `${fn || '(none)'} is not callable by ${cred.role}`);
  }
  const args = body.args === undefined ? {} : body.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return fail(400, 'bad_args', 'args must be a JSON object');
  }

  let target;
  try {
    target = dbTarget(cred.role);
  } catch (e) {
    return fail(500, 'config', (e as Error).message);
  }
  const sql = postgres({
    ...target,
    password: cred.password,
    ssl: 'require',
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
    connection: { application_name: `steward-rpc:${cred.role}` },
  });
  try {
    const query = isPing
      ? `select jsonb_build_object('role', current_user, 'db_time', now(), 'fn', 'ping')::text as r`
      : `select public.${fn}($1::text::jsonb)::text as r`; // text param: sent verbatim, not re-encoded
    const rows = await sql.unsafe(query, isPing ? [] : [JSON.stringify(args)]);
    const result = rows[0]?.r ?? 'null';
    return reply(200, `{"ok":true,"fn":${JSON.stringify(fn)},"result":${result}}`);
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string; hint?: string };
    const code = err.code || '';
    if (code === '28P01' || code === '28000') return fail(401, 'auth', 'Postgres login failed for this role');
    const isSqlState = /^[0-9A-Z]{5}$/.test(code);
    if (!isSqlState || code.startsWith('08')) {
      return fail(502, 'db_unreachable', (err.message || 'connection failed').slice(0, 300));
    }
    return fail(422, 'sql', (err.message || 'error').slice(0, 1000), {
      sqlstate: code,
      detail: err.detail ? String(err.detail).slice(0, 1000) : undefined,
      hint: err.hint ? String(err.hint).slice(0, 300) : undefined,
    });
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
});
