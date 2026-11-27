import {
  DESK_PUBLIC_READER_ROLE,
  isPublicSnapshot,
  MAX_SNAPSHOT_BYTES,
  PUBLIC_LIVE_INTERVAL_MS,
  toPublicDeskSnapshot,
} from '@quantanamo/contracts/desk-snapshot';
import { readBoundedJson } from '@quantanamo/shared/http';
import { isPublishableKey } from '../../../apps/dashboard/lib/auth-public';
import { assembleTeam } from '../../../apps/dashboard/lib/desk-team';
import { assemblePublicDeskFromRestBag } from '../../../apps/dashboard/lib/ledger-live';
import type { JsonObjectRow } from '../../../apps/dashboard/lib/ledger-map';
import { mapMemeCoins } from '../../../apps/dashboard/lib/meme-book';
import { mapPredictionMarkets } from '../../../apps/dashboard/lib/prediction-book';
import { mapStewardScorecard } from '../../../apps/dashboard/lib/steward-scorecard';
import { mapLedgerWatchdog } from '../../../apps/dashboard/lib/ledger-watchdog';
import {
  bundleIsFresh,
  DESK_BUNDLE_REFRESHING_HEADER,
  DESK_HEALTH_WAIT_HEADER,
  LEDGER_MARK_AT_HEADER,
  LEDGER_SNAPSHOT_AT_HEADER,
} from '../../../supabase/functions/desk-public-rest/bundle-cache';
import { marketSessionHealth, shouldWarmDeskBundle } from './desk-health';

/** Match the phone poll so a live GET does not re-assemble inside the interval. */
export const LIVE_CACHE_MS = PUBLIC_LIVE_INTERVAL_MS;

export type PublicDeskServe = {
  desk: unknown;
  json: string;
  generated_at: string;
  /** True when this is a previous successful serve, after a fresh read failed. */
  stale?: boolean;
  /** True when desk-public-rest is rebuilding and this body is still the previous book. */
  bundle_refreshing?: boolean;
  /** Latest account_snapshots.observed_at. Null when the freshness read missed. */
  ledger_snapshot_at?: string | null;
  /** Latest portfolio_exposure.observed_at. Null when the freshness read missed. */
  ledger_mark_at?: string | null;
};

export type PublicDeskLoadOptions = {
  /** /api/health. The edge function may wait up to 3s for the single-flight refresh. */
  waitForRefresh?: boolean;
};

let liveCache: { at: number; serve: PublicDeskServe; health: boolean } | null = null;
const liveSlot: { pending: Promise<PublicDeskServe> | null } = { pending: null };
const healthSlot: { pending: Promise<PublicDeskServe> | null } = { pending: null };

export function resetPublicDeskLiveCache(): void {
  liveCache = null;
  liveSlot.pending = null;
  healthSlot.pending = null;
}

/** Age the isolate's last good serve so the next read must hit origin. */
export function expirePublicDeskLiveCache(): void {
  if (liveCache) liveCache.at = 0;
}

/**
 * A failed refresh, or a book older than the fresh window, is retried quickly.
 * A good serve stays for the phone poll. Omit generatedAt to keep the old two-way check.
 */
export function liveCacheMaxAge(stale: boolean | undefined, generatedAt?: string, now = Date.now()): number {
  if (stale) return 5_000;
  if (generatedAt !== undefined && !bundleIsFresh(generatedAt, now)) return 5_000;
  return LIVE_CACHE_MS;
}

function snapshotGeneratedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return value;
}

export function errorFields(error: unknown): { error: string; name: string } {
  if (error instanceof Error) {
    return { error: error.message || 'unknown', name: error.name || 'Error' };
  }
  return { error: 'unknown', name: 'unknown' };
}

/**
 * One in-flight ledger read per isolate. Concurrent /api/health and /api/desk
 * calls share it so a cold isolate does not parse the bundle more than once.
 */
export function coalesceLiveRead<T>(
  state: { pending: Promise<T> | null },
  read: () => Promise<T>,
): Promise<T> {
  if (state.pending) return state.pending;
  const pending = read().finally(() => {
    if (state.pending === pending) state.pending = null;
  });
  state.pending = pending;
  return pending;
}

function asObjectRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> =>
    Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
}

function asObjectRow(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asJsonRows(value: unknown): JsonObjectRow[] {
  return asObjectRows(value) as JsonObjectRow[];
}

function asUnknownRows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export type DeskReaderEnv = {
  DESK_SUPABASE_URL?: string;
  DESK_READER_APIKEY?: string;
  DESK_READER_JWT?: string;
};

export function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = JSON.parse(atob(padded + pad)) as { role?: unknown };
    return typeof json.role === 'string' ? json.role : null;
  } catch {
    return null;
  }
}

export function liveReaderReady(env: DeskReaderEnv): boolean {
  const url = env.DESK_SUPABASE_URL?.trim() || '';
  const apiKey = env.DESK_READER_APIKEY?.trim() || '';
  const jwt = env.DESK_READER_JWT?.trim() || '';
  if (!url || !apiKey || !jwt) return false;
  if (!isPublishableKey(apiKey)) {
    console.error(JSON.stringify({ event: 'desk_reader_apikey_rejected' }));
    return false;
  }
  const role = jwtRole(jwt);
  if (role !== DESK_PUBLIC_READER_ROLE) {
    console.error(JSON.stringify({ event: 'desk_reader_jwt_rejected', role: role || 'missing' }));
    return false;
  }
  return true;
}

export async function loadPublicDeskServe(
  env: DeskReaderEnv,
  options?: PublicDeskLoadOptions,
): Promise<PublicDeskServe> {
  const now = Date.now();
  if (liveCache && now - liveCache.at < liveCacheMaxAge(liveCache.serve.stale, liveCache.serve.generated_at, now)) {
    // An aged desk read did not ask for ledger times. Health must not reuse it.
    if (!options?.waitForRefresh || liveCache.health) return liveCache.serve;
  }
  const slot = options?.waitForRefresh ? healthSlot : liveSlot;
  return coalesceLiveRead(slot, () => readPublicDeskServe(env, options));
}

function lastGoodServe(error: unknown): PublicDeskServe | null {
  if (!liveCache) return null;
  const fields = errorFields(error);
  console.error(JSON.stringify({
    event: 'desk_live_stale',
    error: fields.error,
    name: fields.name,
    generated_at: liveCache.serve.generated_at,
  }));
  return {
    ...liveCache.serve,
    stale: true,
  };
}

async function readPublicDeskServe(
  env: DeskReaderEnv,
  options?: PublicDeskLoadOptions,
): Promise<PublicDeskServe> {
  try {
    const serve = await fetchPublicDeskServe(env, options);
    liveCache = { at: Date.now(), serve, health: options?.waitForRefresh === true };
    return serve;
  } catch (error) {
    const stale = lastGoodServe(error);
    if (stale) return stale;
    throw error;
  }
}

function headerTime(response: Response, name: string): string | null {
  const value = response.headers.get(name);
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

async function fetchPublicDeskServe(
  env: DeskReaderEnv,
  options?: PublicDeskLoadOptions,
): Promise<PublicDeskServe> {
  const supabaseUrl = env.DESK_SUPABASE_URL?.trim() || '';
  const apiKey = env.DESK_READER_APIKEY?.trim() || '';
  const accessToken = env.DESK_READER_JWT?.trim() || '';
  if (!liveReaderReady(env) || !supabaseUrl || !apiKey || !accessToken) {
    throw new Error('desk_reader_unconfigured');
  }
  const headers: Record<string, string> = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  if (options?.waitForRefresh) headers[DESK_HEALTH_WAIT_HEADER] = '1';
  const base = supabaseUrl.replace(/\/$/, '');
  let response = await fetch(`${base}/bundle/public`, {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  });
  if (response.status === 404) {
    response = await fetch(`${base}/bundle`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
    });
  }
  if (!response.ok) {
    throw new Error(`desk_bundle_${response.status}`);
  }
  const refreshFailed = response.headers.get('x-desk-stale') === '1';
  const raw = await readBoundedJson(response, MAX_SNAPSHOT_BYTES);
  const serve = assemblePublicBundle(raw);
  if (refreshFailed) serve.stale = true;
  serve.bundle_refreshing = response.headers.get(DESK_BUNDLE_REFRESHING_HEADER) === '1';
  serve.ledger_snapshot_at = headerTime(response, LEDGER_SNAPSHOT_AT_HEADER);
  serve.ledger_mark_at = headerTime(response, LEDGER_MARK_AT_HEADER);
  return serve;
}

/**
 * Touch /bundle/public during the core session so the stored book does not
 * sit for hours. The edge function returns the last good row immediately and
 * refreshes it off this request. Holidays, weekends, and the time after an
 * early close do not fetch.
 */
export async function warmDeskBundleIfSession(
  env: DeskReaderEnv,
  now = Date.now(),
): Promise<'warmed' | 'closed' | 'unconfigured' | 'failed'> {
  const session = marketSessionHealth(now);
  if (!shouldWarmDeskBundle(now)) {
    console.error(JSON.stringify({
      event: 'desk_bundle_warm_skipped',
      status: session.status,
      date: session.date,
    }));
    return 'closed';
  }
  if (!liveReaderReady(env)) {
    console.error(JSON.stringify({ event: 'desk_bundle_warm_unconfigured' }));
    return 'unconfigured';
  }
  const base = (env.DESK_SUPABASE_URL || '').replace(/\/$/, '');
  const response = await fetch(`${base}/bundle/public`, {
    headers: {
      apikey: env.DESK_READER_APIKEY || '',
      Authorization: `Bearer ${env.DESK_READER_APIKEY || ''}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  });
  await response.body?.cancel();
  console.error(JSON.stringify({
    event: response.ok ? 'desk_bundle_warm' : 'desk_bundle_warm_failed',
    status: response.status,
    date: session.date,
  }));
  return response.ok ? 'warmed' : 'failed';
}

/** Zod-parse a `/bundle/public` body and publish the phone snapshot. */
export function assemblePublicBundle(raw: unknown): PublicDeskServe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('desk_bundle_not_json');
  }
  const bag = raw as {
    theses?: unknown;
    symbols?: unknown;
    beliefs?: unknown;
    evidence?: unknown;
    scores?: unknown;
    relations?: unknown;
    runs?: unknown;
    cloudRuns?: unknown;
    cloudTasks?: unknown;
    automations?: unknown;
    catalysts?: unknown;
    queue?: unknown;
    lessons?: unknown;
    postmortems?: unknown;
    cycles?: unknown;
    tests?: unknown;
    artifacts?: unknown;
    scenarios?: unknown;
    agentRuns?: unknown;
    accountLatest?: unknown;
    accountFirst?: unknown;
    positions?: unknown;
    exposures?: unknown;
    intents?: unknown;
    proposals?: unknown;
    fills?: unknown;
    insights?: unknown;
    predictions?: unknown;
    riskControls?: unknown;
    themes?: unknown;
    ontologySymbols?: unknown;
    candidates?: unknown;
    actions?: unknown;
    pm?: { markets?: unknown[]; positions?: unknown[]; orders?: unknown[]; fills?: unknown[]; pnl?: unknown[]; pnl_start?: unknown; notes?: unknown[] };
    meme?: { tokens?: unknown[]; positions?: unknown[]; orders?: unknown[]; fills?: unknown[]; pnl?: unknown[]; pnl_start?: unknown; notes?: unknown[] };
    team?: { agents?: unknown[]; domains?: unknown[]; stewards?: unknown[]; accounts?: unknown[] };
    scorecard?: unknown;
    watchdog?: unknown;
    earnings?: unknown;
    lesson_waits?: unknown;
    shadows?: unknown;
    read_notes?: unknown;
    generated_at?: unknown;
  };
  const live = assemblePublicDeskFromRestBag({
    theses: asJsonRows(bag.theses),
    symbols: asJsonRows(bag.symbols),
    beliefs: asJsonRows(bag.beliefs),
    lessons: asJsonRows(bag.lessons),
    cycles: asJsonRows(bag.cycles),
    tests: asJsonRows(bag.tests),
    artifacts: asJsonRows(bag.artifacts),
    scenarios: asJsonRows(bag.scenarios),
    accountLatest: asJsonRows(bag.accountLatest),
    accountFirst: asJsonRows(bag.accountFirst),
    positions: asJsonRows(bag.positions),
    exposures: asJsonRows(bag.exposures),
    intents: asJsonRows(bag.intents),
    fills: asJsonRows(bag.fills),
    themes: asJsonRows(bag.themes),
    candidates: asJsonRows(bag.candidates),
    prediction: mapPredictionMarkets({
      markets: asObjectRows(bag.pm?.markets),
      positions: asObjectRows(bag.pm?.positions),
      orders: asObjectRows(bag.pm?.orders),
      fills: asObjectRows(bag.pm?.fills),
      pnl: asObjectRows(bag.pm?.pnl),
      pnl_start: asObjectRow(bag.pm?.pnl_start),
      notes: asObjectRows(bag.pm?.notes),
    }),
    meme: mapMemeCoins({
      tokens: asObjectRows(bag.meme?.tokens),
      positions: asObjectRows(bag.meme?.positions),
      orders: asObjectRows(bag.meme?.orders),
      fills: asObjectRows(bag.meme?.fills),
      pnl: asObjectRows(bag.meme?.pnl),
      pnl_start: asObjectRow(bag.meme?.pnl_start),
      notes: asObjectRows(bag.meme?.notes),
    }),
    runs: asJsonRows(bag.runs),
    cloudRuns: asJsonRows(bag.cloudRuns),
    automations: asJsonRows(bag.automations),
    team: assembleTeam({
      agents: asUnknownRows(bag.team?.agents),
      domains: asUnknownRows(bag.team?.domains),
      stewards: asUnknownRows(bag.team?.stewards),
      accounts: asUnknownRows(bag.team?.accounts),
    }),
    scorecard: mapStewardScorecard(bag.scorecard),
    watchdog: mapLedgerWatchdog(bag.watchdog),
    earnings: asJsonRows(bag.earnings),
    lessonWaits: asJsonRows(bag.lesson_waits),
    shadows: asJsonRows(bag.shadows),
  });
  const published = toPublicDeskSnapshot({
    ...live,
    source: 'postgrest',
  });
  const notes = readNotes(bag.read_notes);
  if (notes.length) {
    (published as { read_notes?: string[] }).read_notes = notes;
  }
  const stamped = snapshotGeneratedAt(bag.generated_at);
  if (stamped) {
    (published as { generated_at: string }).generated_at = stamped;
  }
  if (!isPublicSnapshot(published)) {
    throw new Error('desk_live_rejected');
  }
  const json = JSON.stringify(published);
  return { desk: published, json, generated_at: published.generated_at };
}

function readNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export async function loadPublicDeskLive(env: DeskReaderEnv): Promise<unknown> {
  return (await loadPublicDeskServe(env)).desk;
}

