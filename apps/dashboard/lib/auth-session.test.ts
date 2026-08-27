import { describe, expect, test } from 'bun:test';

import { AUTH_LOOKUP_MS, firstSettledOrTimeout } from './auth-session';

describe('auth lookup timeout', () => {
  test('returns the value when Auth is fast', async () => {
    expect(await firstSettledOrTimeout(Promise.resolve('ok'), AUTH_LOOKUP_MS)).toBe('ok');
  });

  test('does not wait out a hung Auth round trip', async () => {
    const hung = new Promise<string>(() => {});
    const started = Date.now();
    const result = await firstSettledOrTimeout(hung, 25);
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
