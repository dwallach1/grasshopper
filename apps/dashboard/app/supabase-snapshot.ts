import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
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

export async function loadSnapshot(): Promise<Snapshot> {
  const requestHeaders = await headers();
  const viewerIdentity = await authenticatedIdentity(requestHeaders);
  if (!viewerIdentity) {
    throw new Error('Dashboard authentication required');
  }

  const url = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
  const dashboardToken = env.THESISFORGE_DASHBOARD_TOKEN;
  if (!url || !publishableKey || !dashboardToken) {
    throw new Error('Supabase environment is not configured');
  }

  const response = await fetch(
    `${url.replace(/\/$/, '')}/rest/v1/dashboard_snapshots?id=eq.current&select=payload`,
    {
      headers: {
        apikey: publishableKey,
        'x-thesisforge-dashboard-token': dashboardToken,
      },
      cache: 'no-store',
    },
  );
  if (!response.ok) throw new Error(`Supabase snapshot request failed: ${response.status}`);
  const rows = z.array(SnapshotRowSchema).safeParse(await response.json());
  if (!rows.success || !rows.data[0]?.payload) throw new Error('Supabase has no current dashboard snapshot');

  const snapshot = rows.data[0].payload as Snapshot;
  const managerToken = env.THESISFORGE_MANAGER_TOKEN;
  if (!managerToken || !isManagerIdentity(viewerIdentity)) return snapshot;

  const apiBase = `${url.replace(/\/$/, '')}/rest/v1`;
  const managerHeaders = {
    apikey: publishableKey,
    'x-thesisforge-dashboard-token': dashboardToken,
    'x-thesisforge-manager-user-id': viewerIdentity,
    'x-thesisforge-manager-token': managerToken,
  };
  const [themes, symbols, candidates, actions] = await Promise.all([
    fetchRows(`${apiBase}/ontology_themes?select=id,thesis_id,kind,name,description,status,match_threshold,auto_promote_sources&order=status,name`, managerHeaders, OntologyThemeRowSchema),
    fetchRows(`${apiBase}/symbols?select=symbol,status,mention_count,source_count,first_seen_at,last_seen_at&order=source_count.desc,mention_count.desc&limit=300`, managerHeaders, OntologySymbolRowSchema),
    fetchRows(`${apiBase}/ontology_candidates?select=id,candidate_type,candidate_key,proposed_theme_id,proposed_label,proposed_description,score,evidence_count,source_count,status,first_seen_at,last_seen_at,review_note&source_count=gte.2&order=status,source_count.desc,score.desc&limit=100`, managerHeaders, OntologyCandidateRowSchema),
    fetchRows(`${apiBase}/ontology_management_actions?select=id,actor_id,entity_type,entity_key,action,created_at&order=created_at.desc,id.desc&limit=100`, managerHeaders, OntologyActionRowSchema),
  ]);
  const managerSnapshot: Snapshot = { ...snapshot };
  if (themes) managerSnapshot.ontology_themes = themes as NonNullable<Snapshot['ontology_themes']>;
  if (symbols) managerSnapshot.ontology_symbols = symbols as NonNullable<Snapshot['ontology_symbols']>;
  if (candidates) managerSnapshot.ontology_candidates = candidates as NonNullable<Snapshot['ontology_candidates']>;
  if (actions) managerSnapshot.ontology_actions = actions as NonNullable<Snapshot['ontology_actions']>;
  return managerSnapshot;
}
