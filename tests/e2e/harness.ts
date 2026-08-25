import { z } from 'zod';

import tradePolicy from '../../config/trade_policy.json' with { type: 'json' };
import { parsePublicationResult, type PublicationResult } from '@thesisforge/contracts/publication';
import { withDatabase } from '../../workers/knowledge/src/database';
import { LOCAL } from './env';

const SnapshotPayloadSchema = z.object({
  generated_at: z.string().min(1),
  predictions: z.array(z.unknown()).default([]),
  insights: z.array(z.unknown()).default([]),
  theses: z.array(z.unknown()).default([]),
  counts: z.object({
    sources: z.number(),
    symbols: z.number(),
    open_research: z.number(),
    tests_killed: z.number(),
    tests_survived: z.number(),
    scenario_cells: z.number(),
  }),
}).passthrough();

export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

let supabaseReady: boolean | undefined;
let edgeFunctionsReady: boolean | undefined;

async function probe(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2_000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** True when local API + Postgres are reachable (`supabase start`). */
export async function isSupabaseReady(): Promise<boolean> {
  if (supabaseReady !== undefined) return supabaseReady;
  const apiOk = await probe(`${LOCAL.supabaseUrl}/rest/v1/`, {
    headers: { apikey: LOCAL.anonKey },
  });
  if (!apiOk) {
    supabaseReady = false;
    return false;
  }
  try {
    await withDatabase(LOCAL.databaseUrl, async (database) => {
      await database.query('select 1 as ok');
    });
    supabaseReady = true;
  } catch {
    supabaseReady = false;
  }
  return supabaseReady;
}

/** True when `supabase functions serve` answers on the functions path. */
export async function areEdgeFunctionsReady(): Promise<boolean> {
  if (edgeFunctionsReady !== undefined) return edgeFunctionsReady;
  // Unauthorized is fine — it proves the function runtime is up.
  edgeFunctionsReady = await probe(`${LOCAL.supabaseUrl}/functions/v1/dashboard-publication`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return edgeFunctionsReady;
}

export async function publishViaRpc(publishCurrent = true): Promise<PublicationResult> {
  const response = await fetch(`${LOCAL.supabaseUrl}/rest/v1/rpc/publish_dashboard_snapshot`, {
    method: 'POST',
    headers: {
      apikey: LOCAL.serviceRoleKey,
      authorization: `Bearer ${LOCAL.serviceRoleKey}`,
      'content-type': 'application/json',
      'x-thesisforge-publication-token': LOCAL.publicationToken,
    },
    body: JSON.stringify({
      p_trade_policy: tradePolicy,
      p_publish_current: publishCurrent,
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`publish RPC failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return parsePublicationResult(body);
}

export async function publishViaEdgeFunction(publishCurrent = true): Promise<PublicationResult> {
  const response = await fetch(`${LOCAL.supabaseUrl}/functions/v1/dashboard-publication`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-thesisforge-publication-token': LOCAL.publicationToken,
    },
    body: JSON.stringify({ publishCurrent }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`publish edge function failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return parsePublicationResult(body);
}

export async function readCurrentSnapshot(): Promise<SnapshotPayload> {
  const response = await fetch(
    `${LOCAL.supabaseUrl}/rest/v1/dashboard_snapshots?id=eq.current&select=payload`,
    {
      headers: {
        apikey: LOCAL.anonKey,
        'x-thesisforge-dashboard-token': LOCAL.dashboardToken,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`snapshot read failed (${response.status})`);
  }
  const rows = z.array(z.object({ payload: SnapshotPayloadSchema })).parse(await response.json());
  if (!rows[0]) throw new Error('dashboard_snapshots.current is missing');
  return rows[0].payload;
}

export async function ensureE2eThesis(thesisId = 'e2e_power'): Promise<string> {
  await withDatabase(LOCAL.databaseUrl, async (database) => {
    await database.execute(
      `insert into theses(
         id, name, summary, status, confidence, time_horizon,
         created_at, updated_at, stance, variant_perception, falsifier
       ) values ($1, $2, $3, 'forming', 55, 'days_to_weeks', now(), now(), 'neutral', $4, $5)
       on conflict (id) do update set
         name = excluded.name,
         summary = excluded.summary,
         updated_at = now()`,
      [
        thesisId,
        'E2E Power Thesis',
        'Local end-to-end fixture thesis for publication and capture.',
        'Local variant used only in tests.',
        'Local falsifier used only in tests.',
      ],
    );
  });
  return thesisId;
}
