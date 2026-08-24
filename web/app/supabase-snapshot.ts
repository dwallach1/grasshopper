import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';

import { authenticatedIdentity, isManagerIdentity } from './access-identity';
import type { Snapshot } from './ontology-dashboard';

type SnapshotRow = { payload?: Snapshot };

async function fetchRows<Row>(url: string, requestHeaders: HeadersInit): Promise<Row[] | undefined> {
  const response = await fetch(url, { headers: requestHeaders, cache: 'no-store' });
  return response.ok ? response.json<Row[]>() : undefined;
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
  const rows = await response.json<SnapshotRow[]>();
  if (!rows[0]?.payload) throw new Error('Supabase has no current dashboard snapshot');

  const snapshot = rows[0].payload;
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
    fetchRows<NonNullable<Snapshot['ontology_themes']>[number]>(`${apiBase}/ontology_themes?select=id,thesis_id,kind,name,description,status,match_threshold,auto_promote_sources&order=status,name`, managerHeaders),
    fetchRows<NonNullable<Snapshot['ontology_symbols']>[number]>(`${apiBase}/symbols?select=symbol,status,mention_count,source_count,first_seen_at,last_seen_at&order=source_count.desc,mention_count.desc&limit=300`, managerHeaders),
    fetchRows<NonNullable<Snapshot['ontology_candidates']>[number]>(`${apiBase}/ontology_candidates?select=id,candidate_type,candidate_key,proposed_theme_id,proposed_label,proposed_description,score,evidence_count,source_count,status,first_seen_at,last_seen_at,review_note&source_count=gte.2&order=status,source_count.desc,score.desc&limit=100`, managerHeaders),
    fetchRows<NonNullable<Snapshot['ontology_actions']>[number]>(`${apiBase}/ontology_management_actions?select=id,actor_id,entity_type,entity_key,action,created_at&order=created_at.desc,id.desc&limit=100`, managerHeaders),
  ]);
  const managerSnapshot: Snapshot = { ...snapshot };
  if (themes) managerSnapshot.ontology_themes = themes;
  if (symbols) managerSnapshot.ontology_symbols = symbols;
  if (candidates) managerSnapshot.ontology_candidates = candidates;
  if (actions) managerSnapshot.ontology_actions = actions;
  return managerSnapshot;
}
