import { describe, expect, test } from 'bun:test';

import { coalesceLiveRead, loadPublicDeskServe, resetPublicDeskLiveCache } from './desk-live';

const localAnon =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

function fakeJwt(role: string): string {
  const payload = Buffer.from(JSON.stringify({ iss: 'supabase-demo', role, exp: 1983812996 })).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

const readerEnv = {
  DESK_SUPABASE_URL: 'https://desk.example.test/functions/v1/desk-public-rest',
  DESK_READER_APIKEY: localAnon,
  DESK_READER_JWT: fakeJwt('desk_public_reader'),
};

describe('coalesceLiveRead', () => {
  test('concurrent callers share one read, and a failure can be retried', async () => {
    const state: { pending: Promise<string> | null } = { pending: null };
    let calls = 0;
    const read = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve(`ok-${calls}`), 20);
      });
    };
    const [a, b, c] = await Promise.all([
      coalesceLiveRead(state, read),
      coalesceLiveRead(state, read),
      coalesceLiveRead(state, read),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe('ok-1');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(state.pending).toBeNull();

    const again = await coalesceLiveRead(state, read);
    expect(calls).toBe(2);
    expect(again).toBe('ok-2');

    const failing: { pending: Promise<string> | null } = { pending: null };
    await expect(coalesceLiveRead(failing, () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(failing.pending).toBeNull();
    await expect(coalesceLiveRead(failing, () => Promise.resolve('back'))).resolves.toBe('back');
  });
});

describe('loadPublicDeskServe', () => {
  test('concurrent cold reads fetch /bundle/public once', async () => {
    resetPublicDeskLiveCache();
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const [a, b, c] = await Promise.all([
        loadPublicDeskServe(readerEnv),
        loadPublicDeskServe(readerEnv),
        loadPublicDeskServe(readerEnv),
      ]);
      expect(calls).toBe(1);
      expect(a.json).toBe(b.json);
      expect(c.generated_at).toBe(a.generated_at);
      const before = calls;
      await loadPublicDeskServe(readerEnv);
      expect(calls).toBe(before);
    } finally {
      globalThis.fetch = original;
      resetPublicDeskLiveCache();
    }
  });
});
