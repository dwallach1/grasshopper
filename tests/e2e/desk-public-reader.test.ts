import { describe, expect, test } from 'bun:test';

import { LOCAL } from './env';
import { isSupabaseReady } from './harness';

const supabaseReady = await isSupabaseReady();

function restHeaders(token: string): HeadersInit {
  return {
    apikey: LOCAL.anonKey,
    authorization: `Bearer ${token}`,
  };
}

describe.skipIf(!supabaseReady)('desk_public_reader PostgREST path', () => {
  test('anon still cannot read live ledger tables', async () => {
    const response = await fetch(
      `${LOCAL.supabaseUrl}/rest/v1/account_snapshots?select=id&limit=1`,
      { headers: { apikey: LOCAL.anonKey, authorization: `Bearer ${LOCAL.anonKey}` } },
    );
    expect([401, 403]).toContain(response.status);
  });

  test('desk_public_reader can SELECT desk tables and cannot INSERT', async () => {
    const read = await fetch(
      `${LOCAL.supabaseUrl}/rest/v1/account_snapshots?select=observed_at&limit=1`,
      { headers: restHeaders(LOCAL.deskPublicReaderKey) },
    );
    expect(read.ok).toBe(true);
    expect(Array.isArray(await read.json())).toBe(true);

    const write = await fetch(`${LOCAL.supabaseUrl}/rest/v1/account_snapshots`, {
      method: 'POST',
      headers: {
        ...restHeaders(LOCAL.deskPublicReaderKey),
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify({
        account_label: 'should-not-write',
        total_value: 1,
        source: 'e2e',
      }),
    });
    expect(write.ok).toBe(false);
    expect([401, 403, 404, 405]).toContain(write.status);

    const snapshot = await fetch(
      `${LOCAL.supabaseUrl}/rest/v1/dashboard_snapshots?select=id&limit=1`,
      { headers: restHeaders(LOCAL.deskPublicReaderKey) },
    );
    expect([401, 403]).toContain(snapshot.status);
  });
});

if (!supabaseReady) {
  console.warn(
    '[e2e] Skipping desk_public_reader tests — start local Supabase with `supabase start && supabase db reset`.',
  );
}
