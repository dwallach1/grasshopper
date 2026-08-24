import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';

import type { Snapshot } from './ontology-dashboard';

type SnapshotRow = { payload?: Snapshot };

export async function loadSnapshot(): Promise<Snapshot> {
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
  const rows = (await response.json()) as SnapshotRow[];
  if (!rows[0]?.payload) throw new Error('Supabase has no current dashboard snapshot');

  const snapshot = rows[0].payload;
  const requestHeaders = await headers();
  const managerId = requestHeaders.get('oai-authenticated-user-id') || '';
  const managerToken = env.THESISFORGE_MANAGER_TOKEN;
  const managerIds = new Set(
    (env.THESISFORGE_MANAGER_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean),
  );
  if (!managerId || !managerToken || !managerIds.has(managerId)) return snapshot;

  const apiBase = `${url.replace(/\/$/, '')}/rest/v1`;
  const managerHeaders = {
    apikey: publishableKey,
    'x-thesisforge-dashboard-token': dashboardToken,
    'x-thesisforge-manager-user-id': managerId,
    'x-thesisforge-manager-token': managerToken,
  };
  const endpoints = [
    ['ontology_themes', 'ontology_themes?select=id,thesis_id,kind,name,description,status,match_threshold,auto_promote_sources&order=status,name'],
    ['ontology_symbols', 'symbols?select=symbol,status,mention_count,source_count,first_seen_at,last_seen_at&order=source_count.desc,mention_count.desc&limit=300'],
    ['ontology_candidates', 'ontology_candidates?select=id,candidate_type,candidate_key,proposed_theme_id,proposed_label,proposed_description,score,evidence_count,source_count,status,first_seen_at,last_seen_at,review_note&source_count=gte.2&order=status,source_count.desc,score.desc&limit=100'],
    ['ontology_actions', 'ontology_management_actions?select=id,actor_id,entity_type,entity_key,action,created_at&order=created_at.desc,id.desc&limit=100'],
  ] as const;
  const live = await Promise.all(endpoints.map(async ([key, path]) => {
    const result = await fetch(`${apiBase}/${path}`, { headers: managerHeaders, cache: 'no-store' });
    return [key, result.ok ? await result.json() : undefined] as const;
  }));
  for (const [key, value] of live) {
    if (value !== undefined) (snapshot as unknown as Record<string, unknown>)[key] = value;
  }
  return snapshot;
}
