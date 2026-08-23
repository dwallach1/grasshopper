import { env } from 'cloudflare:workers';

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
  return rows[0].payload;
}
