import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dashboardRoot = join(import.meta.dir, '..');

async function readDashboard(relative: string): Promise<string> {
  return readFile(join(dashboardRoot, relative), 'utf8');
}

describe('desk load path', () => {
  test('proxy and operator session share getClaims, never hang on getUser', async () => {
    const proxy = await readDashboard('proxy.ts');
    const operator = await readDashboard('lib/operator-session.ts');
    const auth = await readDashboard('lib/auth-session.ts');
    expect(proxy).toContain('refreshAuthCookies');
    expect(proxy).not.toContain('getUser');
    expect(proxy).toContain("_next/static");
    expect(operator).toContain('verifyAuthClaims');
    expect(operator).toContain("rpc('claim_ledger_operator')");
    expect(operator).not.toContain('getUser');
    expect(auth).toContain('getClaims');
    expect(auth).toContain('AUTH_LOOKUP_MS = 2_000');
    expect(auth).toContain('claims.email');
    expect(auth).not.toMatch(/user_metadata/);
  });

  test('loadDesk uses postgres when DATABASE_URL is set; REST has an abort', async () => {
    const ledger = await readDashboard('lib/ledger.ts');
    const live = await readDashboard('lib/ledger-live.ts');
    expect(ledger).toContain('if (hasDatabaseUrl()) return loadDeskFromPostgres()');
    expect(ledger).toContain('return loadDeskFromRest({');
    expect(live).toContain('AbortSignal.timeout(auth.fetchMs ?? REST_FETCH_MS)');
    expect(ledger).toContain('last_price');
    expect(live).toContain('export const REST_FETCH_MS = 8_000');
    expect(ledger).toContain('loadPredictionMarkets');
    expect(ledger).toContain('pm_markets');
    expect(ledger).toContain('loadMemeCoins');
    expect(ledger).toContain('meme_tokens');
    expect(ledger).toContain('meme_positions');
    expect(ledger).toContain('closed_at');
    expect(ledger).toContain("status in ('proposed', 'open', 'closing', 'closed')");
    expect(ledger).toContain('limit 200');
    expect(live).toContain('limit=200');
    expect(ledger).toContain('loadTeam');
    expect(ledger).toContain('desk_agents');
    expect(ledger).toContain('desk_domain_stewards');
    expect(ledger).toContain("ended_at is null");
    expect(ledger).toContain('to_regclass');
    expect(ledger).toContain('opened_at, closed_at');
  });

  test('public /api/desk reads live postgres only', async () => {
    const route = await readDashboard('app/api/desk/route.ts');
    expect(route).toContain('loadDeskFromPostgres');
    expect(route).toContain('toPublicDeskSnapshot');
    expect(route).not.toContain('filePublicDesk');
    expect(route).not.toContain('current.json');
    expect(route).toContain("headers: { 'Cache-Control': 'no-store' }");
  });
});
