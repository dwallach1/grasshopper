import {
  DESK_PUBLIC_READER_ROLE,
  isPublicSnapshot,
  MAX_SNAPSHOT_BYTES,
  toPublicDeskSnapshot,
} from '@quantanamo/contracts/desk-snapshot';
import { readBoundedJson } from '@quantanamo/shared/http';
import { isPublishableKey } from '../../../apps/dashboard/lib/auth-public';
import { assembleTeam } from '../../../apps/dashboard/lib/desk-team';
import { assemblePublicDeskFromRestBag } from '../../../apps/dashboard/lib/ledger-live';
import type { JsonObjectRow } from '../../../apps/dashboard/lib/ledger-map';
import { mapMemeCoins } from '../../../apps/dashboard/lib/meme-book';
import { mapPredictionMarkets } from '../../../apps/dashboard/lib/prediction-book';

/** Match the phone poll so a 15s GET does not re-assemble under 1102. */
export const LIVE_CACHE_MS = 15_000;

export type PublicDeskServe = {
  desk: unknown;
  json: string;
  generated_at: string;
};

let liveCache: { at: number; serve: PublicDeskServe } | null = null;

export function resetPublicDeskLiveCache(): void {
  liveCache = null;
}

function asObjectRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> =>
    Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
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

export async function loadPublicDeskServe(env: DeskReaderEnv): Promise<PublicDeskServe> {
  const now = Date.now();
  if (liveCache && now - liveCache.at < LIVE_CACHE_MS) {
    return liveCache.serve;
  }
  const supabaseUrl = env.DESK_SUPABASE_URL?.trim() || '';
  const apiKey = env.DESK_READER_APIKEY?.trim() || '';
  const accessToken = env.DESK_READER_JWT?.trim() || '';
  if (!liveReaderReady(env) || !supabaseUrl || !apiKey || !accessToken) {
    throw new Error('desk_reader_unconfigured');
  }
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
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
  const raw = await readBoundedJson(response, MAX_SNAPSHOT_BYTES);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('desk_bundle_not_json');
  }
  const bag = raw as {
    theses?: unknown;
    symbols?: unknown;
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
    pm?: { markets?: unknown[]; positions?: unknown[]; orders?: unknown[]; fills?: unknown[]; pnl?: unknown[]; notes?: unknown[] };
    meme?: { tokens?: unknown[]; positions?: unknown[]; orders?: unknown[]; fills?: unknown[]; pnl?: unknown[]; notes?: unknown[] };
    team?: { agents?: unknown[]; domains?: unknown[]; stewards?: unknown[]; accounts?: unknown[] };
  };
  const live = assemblePublicDeskFromRestBag({
    theses: asJsonRows(bag.theses),
    symbols: asJsonRows(bag.symbols),
    accountLatest: asJsonRows(bag.accountLatest),
    accountFirst: asJsonRows(bag.accountFirst),
    positions: asJsonRows(bag.positions),
    exposures: asJsonRows(bag.exposures),
    intents: asJsonRows(bag.intents),
    fills: asJsonRows(bag.fills),
    themes: asJsonRows(bag.themes),
    prediction: mapPredictionMarkets({
      markets: asObjectRows(bag.pm?.markets),
      positions: asObjectRows(bag.pm?.positions),
      orders: asObjectRows(bag.pm?.orders),
      fills: asObjectRows(bag.pm?.fills),
      pnl: asObjectRows(bag.pm?.pnl),
      notes: asObjectRows(bag.pm?.notes),
    }),
    meme: mapMemeCoins({
      tokens: asObjectRows(bag.meme?.tokens),
      positions: asObjectRows(bag.meme?.positions),
      orders: asObjectRows(bag.meme?.orders),
      fills: asObjectRows(bag.meme?.fills),
      pnl: asObjectRows(bag.meme?.pnl),
      notes: asObjectRows(bag.meme?.notes),
    }),
    team: assembleTeam({
      agents: asUnknownRows(bag.team?.agents),
      domains: asUnknownRows(bag.team?.domains),
      stewards: asUnknownRows(bag.team?.stewards),
      accounts: asUnknownRows(bag.team?.accounts),
    }),
  });
  const published = toPublicDeskSnapshot({
    ...live,
    source: 'postgrest',
  });
  if (!isPublicSnapshot(published)) {
    throw new Error('desk_live_rejected');
  }
  const json = JSON.stringify(published);
  const serve = { desk: published, json, generated_at: published.generated_at };
  liveCache = { at: Date.now(), serve };
  return serve;
}

export async function loadPublicDeskLive(env: DeskReaderEnv): Promise<unknown> {
  return (await loadPublicDeskServe(env)).desk;
}
