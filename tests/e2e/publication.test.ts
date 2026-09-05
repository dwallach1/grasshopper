import { describe, expect, test } from 'bun:test';

import { LOCAL } from './env';
import {
  areEdgeFunctionsReady,
  isSupabaseReady,
  publishViaEdgeFunction,
  publishViaRpc,
  readCurrentSnapshot,
} from './harness';

const supabaseReady = await isSupabaseReady();
const edgeReady = supabaseReady ? await areEdgeFunctionsReady() : false;

describe.skipIf(!supabaseReady)('local publication e2e', () => {
  test('rejects publication RPC without a valid token', async () => {
    const response = await fetch(`${LOCAL.supabaseUrl}/rest/v1/rpc/publish_dashboard_snapshot`, {
      method: 'POST',
      headers: {
        apikey: LOCAL.serviceRoleKey,
        authorization: `Bearer ${LOCAL.serviceRoleKey}`,
        'content-type': 'application/json',
        'x-quantanamo-publication-token': 'wrong-token',
      },
      body: JSON.stringify({
        p_trade_policy: {},
        p_publish_current: true,
      }),
    });
    expect(response.ok).toBe(false);
  });

  test('anon cannot read dashboard_snapshots via PostgREST', async () => {
    const response = await fetch(
      `${LOCAL.supabaseUrl}/rest/v1/dashboard_snapshots?id=eq.current&select=payload`,
      { headers: { apikey: LOCAL.anonKey } },
    );
    expect([401, 403]).toContain(response.status);
  });

  test('publishes dashboard_snapshots.current through the PostgREST RPC', async () => {
    const before = await readCurrentSnapshot();
    const result = await publishViaRpc(true);
    expect(result.target_id).toBe('current');
    expect(result.trading_enabled).toBe(false);
    expect(result.normalized_sha256.length).toBe(64);

    const after = await readCurrentSnapshot();
    expect(after.generated_at).not.toBe(before.generated_at);
    expect(after.counts.symbols).toBeGreaterThan(0);
  });

  test.skipIf(!edgeReady)(
    'publishes dashboard_snapshots.current through the dashboard-publication edge function',
    async () => {
      const before = await readCurrentSnapshot();
      const result = await publishViaEdgeFunction(true);
      expect(result.target_id).toBe('current');
      expect(result.trading_enabled).toBe(false);

      const after = await readCurrentSnapshot();
      expect(after.generated_at).not.toBe(before.generated_at);
    },
  );
});

if (!supabaseReady) {
  console.warn(
    '[e2e] Skipping publication tests — start local Supabase with `supabase start && supabase db reset`.',
  );
} else if (!edgeReady) {
  console.warn(
    '[e2e] Edge function publication test skipped — run `supabase functions serve` for full coverage.',
  );
}
