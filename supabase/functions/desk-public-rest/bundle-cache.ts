/**
 * Last-good /bundle body in public.desk_public_bundle.
 * service_role only. A missing table or a lock row (ready=false) is a miss,
 * and the caller rebuilds. The payload is never invented here.
 */

export const BUNDLE_FRESH_MS = 45_000;
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

export function bundleResponse(payload: Record<string, unknown>, stale: boolean): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (stale) headers['X-Desk-Stale'] = '1';
  return Response.json(payload, { headers });
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

/** Used when another isolate holds the first-build lock and this request has nothing to serve yet. */
export async function waitForDeskBundle(slot: BundleSlot): Promise<StoredBundle | null> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_DELAY_MS));
    const stored = await readDeskBundle(slot);
    if (stored) return stored;
  }
  return null;
}
