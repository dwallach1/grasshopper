import { describe, expect, test } from 'bun:test';

import { handleBundle } from '../../../supabase/functions/desk-public-rest/index';

function installDenoEnv(): void {
  (globalThis as { Deno?: { env: { get: (key: string) => string | undefined } } }).Deno = {
    env: {
      get: (key: string) => {
        if (key === 'SUPABASE_URL') return 'https://ledger.test';
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'service-role-test';
        return undefined;
      },
    },
  };
}

function mockLedger(fail: (url: string) => boolean): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (fail(url)) {
      return new Response(JSON.stringify({ message: 'statement timeout' }), { status: url.includes('504') ? 504 : 500 });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('desk-public-rest bundle section failures', () => {
  test('backtest_artifacts:500 empties that section and notes it', async () => {
    installDenoEnv();
    const original = globalThis.fetch;
    globalThis.fetch = mockLedger((url) => url.includes('/rest/v1/backtest_artifacts'));
    try {
      const response = await handleBundle('public');
      expect(response.status).toBe(200);
      const body = await response.json() as {
        read_notes?: string[];
        artifacts: unknown[];
        tests: unknown[];
        theses: unknown[];
      };
      expect(body.read_notes).toEqual(['backtest_artifacts:500']);
      expect(body.artifacts).toEqual([]);
      expect(body.tests).toEqual([]);
      expect(body.theses).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('two table failures still fail the bundle', async () => {
    installDenoEnv();
    const original = globalThis.fetch;
    globalThis.fetch = mockLedger((url) =>
      url.includes('/rest/v1/backtest_artifacts') || url.includes('/rest/v1/theses?'),
    );
    try {
      const response = await handleBundle('public');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Desk ledger unavailable' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('both reads of one pnl table still count as a single failure', async () => {
    installDenoEnv();
    const original = globalThis.fetch;
    globalThis.fetch = mockLedger((url) => url.includes('/rest/v1/pm_pnl'));
    try {
      const response = await handleBundle('public');
      expect(response.status).toBe(200);
      const body = await response.json() as { read_notes?: string[]; pm: { pnl: unknown[] } };
      expect(body.read_notes).toEqual(['pm_pnl:500']);
      expect(body.pm.pnl).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('an optional earnings miss does not count as the one allowed failure', async () => {
    installDenoEnv();
    const original = globalThis.fetch;
    globalThis.fetch = mockLedger((url) => url.includes('/rest/v1/equity_implied_moves'));
    try {
      const response = await handleBundle('public');
      expect(response.status).toBe(200);
      const body = await response.json() as { read_notes?: string[]; earnings: unknown[] };
      expect(body.read_notes).toBeUndefined();
      expect(body.earnings).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
