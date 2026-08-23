import { env } from 'cloudflare:workers';

import type { Snapshot } from './ontology-dashboard';

type SnapshotRow = { payload?: Snapshot };

export async function loadSnapshot(fallback: Snapshot): Promise<Snapshot> {
  const url = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return fallback;

  try {
    const response = await fetch(
      `${url.replace(/\/$/, '')}/rest/v1/dashboard_snapshots?id=eq.current&select=payload`,
      {
        headers: { apikey: secretKey },
        cache: 'no-store',
      },
    );
    if (!response.ok) return fallback;
    const rows = (await response.json()) as SnapshotRow[];
    return rows[0]?.payload ?? fallback;
  } catch {
    return fallback;
  }
}
