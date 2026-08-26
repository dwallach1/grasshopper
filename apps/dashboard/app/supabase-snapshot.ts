import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import postgres from 'postgres';
import { z } from 'zod';

import { authenticatedIdentity, isManagerIdentity } from './access-identity';
import type { Snapshot } from './ontology-dashboard';

const CountsSchema = z.object({
  sources: z.number(),
  symbols: z.number(),
  open_research: z.number(),
  tests_killed: z.number(),
  tests_survived: z.number(),
  scenario_cells: z.number(),
});

const SnapshotSchema = z.object({
  generated_at: z.string().min(1),
  theses: z.array(z.unknown()).default([]),
  cycles: z.array(z.unknown()).default([]),
  tests: z.array(z.unknown()).default([]),
  test_scenarios: z.array(z.unknown()).default([]),
  agent_runs: z.array(z.unknown()).default([]),
  lessons: z.array(z.unknown()).default([]),
  risk_controls: z.array(z.unknown()).default([]),
  relations: z.array(z.unknown()).default([]),
  predictions: z.array(z.unknown()).default([]),
  insights: z.array(z.unknown()).default([]),
  events: z.array(z.unknown()).default([]),
  counts: CountsSchema,
}).passthrough();

const SnapshotRowSchema = z.object({
  payload: SnapshotSchema,
}).passthrough();

const OntologyThemeRowSchema = z.object({
  id: z.string(),
  thesis_id: z.string().nullable(),
  kind: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.string(),
  match_threshold: z.number(),
  auto_promote_sources: z.number(),
}).passthrough();

const OntologySymbolRowSchema = z.object({
  symbol: z.string(),
  status: z.string(),
  mention_count: z.number(),
  source_count: z.number(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
}).passthrough();

const OntologyCandidateRowSchema = z.object({
  id: z.number(),
  candidate_type: z.string(),
  candidate_key: z.string(),
  proposed_theme_id: z.string().nullable(),
  proposed_label: z.string(),
  proposed_description: z.string(),
  score: z.number(),
  evidence_count: z.number(),
  source_count: z.number(),
  status: z.string(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  review_note: z.string().nullable(),
}).passthrough();

const OntologyActionRowSchema = z.object({
  id: z.number(),
  actor_id: z.string(),
  entity_type: z.string(),
  entity_key: z.string(),
  action: z.string(),
  created_at: z.string(),
}).passthrough();

function isLocalDevAccess(): boolean {
  return (env.CF_ACCESS_AUD || '').trim() === 'local-dev';
}

async function fetchRows<Row>(
  url: string,
  requestHeaders: HeadersInit,
  schema: z.ZodType<Row>,
): Promise<Row[] | undefined> {
  const response = await fetch(url, { headers: requestHeaders, cache: 'no-store' });
  if (!response.ok) return undefined;
  const parsed = z.array(schema).safeParse(await response.json());
  return parsed.success ? parsed.data : undefined;
}

function restAuthHeaders(): HeadersInit {
  const url = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const dashboardToken = env.THESISFORGE_DASHBOARD_TOKEN?.trim();

  if (!url) throw new Error('SUPABASE_URL is not configured');

  // Local / operator path: service_role bypasses RLS. No Cloudflare dashboard token required.
  if (secretKey) {
    return {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    };
  }

  if (!publishableKey || !dashboardToken) {
    throw new Error(
      'Supabase is not configured. For local web:app set SUPABASE_SECRET_KEY (Supabase → Settings → API) or THESISFORGE_DATABASE_URL, or set SUPABASE_PUBLISHABLE_KEY + THESISFORGE_DASHBOARD_TOKEN.',
    );
  }

  return {
    apikey: publishableKey,
    'x-thesisforge-dashboard-token': dashboardToken,
  };
}

async function loadSnapshotFromDatabase(connectionString: string, includeManager: boolean): Promise<Snapshot> {
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    prepare: false,
    ssl: 'require',
  });
  try {
    const rows = await sql<{ payload: unknown }>`
      select payload
      from public.dashboard_snapshots
      where id = 'current'
      limit 1
    `;
    const parsed = SnapshotRowSchema.safeParse(rows[0]);
    if (!parsed.success) throw new Error('Supabase has no current dashboard snapshot');
    // SAFETY: SnapshotRowSchema validated the payload shape above.
    const snapshot = parsed.data.payload as Snapshot;
    if (!includeManager) return snapshot;

    const [themes, symbols, candidates, actions] = await Promise.all([
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
        select id, candidate_type, candidate_key, proposed_theme_id, proposed_label, proposed_description,
               score, evidence_count, source_count, status, first_seen_at, last_seen_at, review_note
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
    ]);

    const managerSnapshot: Snapshot = { ...snapshot };
    const themeRows = z.array(OntologyThemeRowSchema).safeParse(themes);
    const symbolRows = z.array(OntologySymbolRowSchema).safeParse(symbols);
    const candidateRows = z.array(OntologyCandidateRowSchema).safeParse(candidates);
    const actionRows = z.array(OntologyActionRowSchema).safeParse(actions);
    if (themeRows.success) {
      managerSnapshot.ontology_themes = themeRows.data as NonNullable<Snapshot['ontology_themes']>;
    }
    if (symbolRows.success) {
      managerSnapshot.ontology_symbols = symbolRows.data as NonNullable<Snapshot['ontology_symbols']>;
    }
    if (candidateRows.success) {
      managerSnapshot.ontology_candidates = candidateRows.data as NonNullable<Snapshot['ontology_candidates']>;
    }
    if (actionRows.success) {
      managerSnapshot.ontology_actions = actionRows.data as NonNullable<Snapshot['ontology_actions']>;
    }
    return managerSnapshot;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function loadSnapshotFromRest(viewerIdentity: string): Promise<Snapshot> {
  const url = env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not configured');
  const authHeaders = restAuthHeaders();

  const response = await fetch(
    `${url.replace(/\/$/, '')}/rest/v1/dashboard_snapshots?id=eq.current&select=payload`,
    { headers: authHeaders, cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`Supabase snapshot request failed: ${response.status}`);
  const rows = z.array(SnapshotRowSchema).safeParse(await response.json());
  if (!rows.success || !rows.data[0]?.payload) throw new Error('Supabase has no current dashboard snapshot');

  // SAFETY: SnapshotRowSchema only accepts payload objects from the canonical dashboard snapshot row.
  const snapshot = rows.data[0].payload as Snapshot;
  const managerToken = env.THESISFORGE_MANAGER_TOKEN?.trim();
  const usingSecretKey = Boolean(env.SUPABASE_SECRET_KEY?.trim());
  const canManage = isManagerIdentity(viewerIdentity) && (usingSecretKey || Boolean(managerToken));
  if (!canManage) return snapshot;

  const apiBase = `${url.replace(/\/$/, '')}/rest/v1`;
  const managerHeaders: HeadersInit = usingSecretKey
    ? authHeaders
    : {
        ...authHeaders,
        'x-thesisforge-manager-user-id': viewerIdentity,
        'x-thesisforge-manager-token': managerToken!,
      };

  const [themes, symbols, candidates, actions] = await Promise.all([
    fetchRows(`${apiBase}/ontology_themes?select=id,thesis_id,kind,name,description,status,match_threshold,auto_promote_sources&order=status,name`, managerHeaders, OntologyThemeRowSchema),
    fetchRows(`${apiBase}/symbols?select=symbol,status,mention_count,source_count,first_seen_at,last_seen_at&order=source_count.desc,mention_count.desc&limit=300`, managerHeaders, OntologySymbolRowSchema),
    fetchRows(`${apiBase}/ontology_candidates?select=id,candidate_type,candidate_key,proposed_theme_id,proposed_label,proposed_description,score,evidence_count,source_count,status,first_seen_at,last_seen_at,review_note&source_count=gte.2&order=status,source_count.desc,score.desc&limit=100`, managerHeaders, OntologyCandidateRowSchema),
    fetchRows(`${apiBase}/ontology_management_actions?select=id,actor_id,entity_type,entity_key,action,created_at&order=created_at.desc,id.desc&limit=100`, managerHeaders, OntologyActionRowSchema),
  ]);
  const managerSnapshot: Snapshot = { ...snapshot };
  if (themes) {
    // SAFETY: fetchRows parses every row with OntologyThemeRowSchema before returning the array.
    managerSnapshot.ontology_themes = themes as NonNullable<Snapshot['ontology_themes']>;
  }
  if (symbols) {
    // SAFETY: fetchRows parses every row with OntologySymbolRowSchema before returning the array.
    managerSnapshot.ontology_symbols = symbols as NonNullable<Snapshot['ontology_symbols']>;
  }
  if (candidates) {
    // SAFETY: fetchRows parses every row with OntologyCandidateRowSchema before returning the array.
    managerSnapshot.ontology_candidates = candidates as NonNullable<Snapshot['ontology_candidates']>;
  }
  if (actions) {
    // SAFETY: fetchRows parses every row with OntologyActionRowSchema before returning the array.
    managerSnapshot.ontology_actions = actions as NonNullable<Snapshot['ontology_actions']>;
  }
  return managerSnapshot;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const requestHeaders = await headers();
  const viewerIdentity = await authenticatedIdentity(requestHeaders);
  if (!viewerIdentity) {
    throw new Error('Dashboard authentication required');
  }

  const databaseUrl = env.THESISFORGE_DATABASE_URL?.trim();
  if (databaseUrl && isLocalDevAccess()) {
    return loadSnapshotFromDatabase(databaseUrl, isManagerIdentity(viewerIdentity));
  }

  return loadSnapshotFromRest(viewerIdentity);
}
