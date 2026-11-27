/**
 * Last-good /bundle body in public.desk_public_bundle.
 * service_role only. A missing table or a lock row (ready=false) is a miss,
 * and the caller rebuilds. The payload is never invented here.
 */

export const BUNDLE_FRESH_MS = 45_000;
/** /api/health only. Desk never waits on a rebuild. */
export const HEALTH_REFRESH_WAIT_MS = 3_000;
export const HEALTH_REFRESH_POLL_MS = 200;
/** Set by the desk Worker on /api/health. Absent on /api/desk. */
export const DESK_HEALTH_WAIT_HEADER = 'x-desk-health-wait';
export const DESK_BUNDLE_REFRESHING_HEADER = 'x-desk-bundle-refreshing';
export const LEDGER_SNAPSHOT_AT_HEADER = 'x-ledger-snapshot-at';
export const LEDGER_MARK_AT_HEADER = 'x-ledger-mark-at';
const WAIT_ATTEMPTS = 40;
const WAIT_DELAY_MS = 500;

export type BundleSlot = 'public' | 'full';
export type RefreshClaim = 'claimed' | 'busy' | 'unavailable';

export type StoredBundle = {
  slot: BundleSlot;
  generatedAt: string;
  payload: Record<string, unknown>;
  refreshFailed: boolean;
  fresh: boolean;
};

function denoEnv(name: string): string {
  const deno = (globalThis as {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
  }).Deno;
  return deno?.env?.get?.(name)?.trim() || '';
}

function supabaseBase(): string {
  return denoEnv('SUPABASE_URL').replace(/\/$/, '');
}

function authHeaders(prefer?: string): Headers {
  const headers = new Headers();
  const serviceKey = denoEnv('SUPABASE_SERVICE_ROLE_KEY');
  headers.set('apikey', serviceKey);
  headers.set('Authorization', `Bearer ${serviceKey}`);
  headers.set('Accept', 'application/json');
  headers.set('Content-Type', 'application/json');
  if (prefer) headers.set('Prefer', prefer);
  return headers;
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields }));
}

/** A stored book has the core arrays the assembler reads. `{}` is a lock, not a book. */
export function usableBundlePayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const row = payload as Record<string, unknown>;
  return Array.isArray(row.positions) && Array.isArray(row.theses);
}

export function bundleIsFresh(generatedAt: string, now = Date.now()): boolean {
  const parsed = Date.parse(generatedAt);
  if (!Number.isFinite(parsed)) return false;
  const age = now - parsed;
  return age < BUNDLE_FRESH_MS && age > -5 * 60_000;
}

export type LedgerFreshness = {
  snapshotAt: string | null;
  markAt: string | null;
};

export function bundleResponse(
  payload: Record<string, unknown>,
  stale: boolean,
  meta?: { refreshing?: boolean; ledger?: LedgerFreshness | null },
): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (stale) headers['X-Desk-Stale'] = '1';
  if (meta?.refreshing) headers[DESK_BUNDLE_REFRESHING_HEADER] = '1';
  if (meta?.ledger?.snapshotAt) headers[LEDGER_SNAPSHOT_AT_HEADER] = meta.ledger.snapshotAt;
  if (meta?.ledger?.markAt) headers[LEDGER_MARK_AT_HEADER] = meta.ledger.markAt;
  return Response.json(payload, { headers });
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

/**
 * Latest account snapshot and equity mark. One indexed read, not the bundle fan-out.
 * A missing function (migration not applied yet) is a miss: the book still serves.
 */
export async function readLedgerFreshness(): Promise<LedgerFreshness | null> {
  try {
    const base = supabaseBase();
    if (!base || !denoEnv('SUPABASE_SERVICE_ROLE_KEY')) return null;
    const response = await fetch(`${base}/rest/v1/rpc/desk_public_ledger_freshness`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;
    return {
      snapshotAt: isoTimestamp(row.snapshot_at),
      markAt: isoTimestamp(row.mark_at),
    };
  } catch (error) {
    logEvent('desk_public_ledger_freshness_failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

export async function readDeskBundle(slot: BundleSlot, now = Date.now()): Promise<StoredBundle | null> {
  try {
    const base = supabaseBase();
    if (!base || !denoEnv('SUPABASE_SERVICE_ROLE_KEY')) return null;
    const response = await fetch(
      `${base}/rest/v1/desk_public_bundle?id=eq.${slot}&select=id,generated_at,payload,ready,refresh_failed_at&limit=1`,
      { headers: authHeaders() },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!Array.isArray(body) || !body[0] || typeof body[0] !== 'object') return null;
    const row = body[0] as Record<string, unknown>;
    if (row.ready !== true) return null;
    if (typeof row.generated_at !== 'string' || !usableBundlePayload(row.payload)) return null;
    return {
      slot,
      generatedAt: row.generated_at,
      payload: { ...row.payload, generated_at: row.generated_at },
      refreshFailed: typeof row.refresh_failed_at === 'string' && row.refresh_failed_at.length > 0,
      fresh: bundleIsFresh(row.generated_at, now),
    };
  } catch (error) {
    logEvent('desk_public_bundle_read_failed', {
      slot,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

export async function claimDeskRefresh(slot: BundleSlot): Promise<RefreshClaim> {
  try {
    const base = supabaseBase();
    if (!base || !denoEnv('SUPABASE_SERVICE_ROLE_KEY')) return 'unavailable';
    const response = await fetch(`${base}/rest/v1/rpc/claim_desk_public_refresh`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ p_id: slot }),
    });
    if (!response.ok) return 'unavailable';
    const body: unknown = await response.json();
    if (body === true) return 'claimed';
    if (body === false) return 'busy';
    return 'unavailable';
  } catch (error) {
    logEvent('desk_public_bundle_claim_failed', {
      slot,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return 'unavailable';
  }
}

export async function saveDeskBundle(
  slot: BundleSlot,
  generatedAt: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const base = supabaseBase();
    if (!base || !denoEnv('SUPABASE_SERVICE_ROLE_KEY')) return false;
    if (!usableBundlePayload(payload)) return false;
    const response = await fetch(`${base}/rest/v1/desk_public_bundle?on_conflict=id`, {
      method: 'POST',
      headers: authHeaders('resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify({
        id: slot,
        ready: true,
        generated_at: generatedAt,
        payload: { ...payload, generated_at: generatedAt },
        refresh_started_at: null,
        refresh_failed_at: null,
      }),
    });
    if (!response.ok) {
      logEvent('desk_public_bundle_save_failed', { slot, status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    logEvent('desk_public_bundle_save_failed', {
      slot,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

export async function markDeskRefreshFailed(slot: BundleSlot): Promise<void> {
  try {
    const base = supabaseBase();
    if (!base || !denoEnv('SUPABASE_SERVICE_ROLE_KEY')) return;
    const response = await fetch(`${base}/rest/v1/desk_public_bundle?id=eq.${slot}`, {
      method: 'PATCH',
      headers: authHeaders('return=minimal'),
      body: JSON.stringify({
        refresh_failed_at: new Date().toISOString(),
        refresh_started_at: null,
      }),
    });
    if (!response.ok) {
      logEvent('desk_public_bundle_fail_mark_failed', { slot, status: response.status });
    }
  } catch (error) {
    logEvent('desk_public_bundle_fail_mark_failed', {
      slot,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

export function scheduleBundleRefresh(work: Promise<void>): void {
  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (typeof runtime?.waitUntil === 'function') {
    runtime.waitUntil(work);
    return;
  }
  void work;
}

/**
 * Poll until a refresh stores a newer book, or the budget runs out.
 * Does not start a second fan-out. The caller already holds or joined the single-flight lock.
 */
export async function pollNewerBundle(
  slot: BundleSlot,
  previousGeneratedAt: string,
  waitMs: number,
): Promise<StoredBundle | null> {
  const previousMs = Date.parse(previousGeneratedAt);
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(HEALTH_REFRESH_POLL_MS, Math.max(remaining, 1))));
    const stored = await readDeskBundle(slot);
    if (!stored) continue;
    const nextMs = Date.parse(stored.generatedAt);
    if (Number.isFinite(nextMs) && (!Number.isFinite(previousMs) || nextMs > previousMs)) return stored;
  }
  return null;
}

/** Used when another isolate holds the first-build lock and this request has nothing to serve yet. */
export async function waitForDeskBundle(slot: BundleSlot): Promise<StoredBundle | null> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_DELAY_MS));
    const stored = await readDeskBundle(slot);
    if (stored) return stored;
  }
  return null;
}
