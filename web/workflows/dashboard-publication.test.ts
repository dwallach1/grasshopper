import { describe, expect, test } from 'bun:test';

import { boundedJson, isPublicationResult } from './publication-contract';

const validResult = {
  target_id: 'cloudflare-shadow',
  generated_at: '2026-08-24T16:00:00Z',
  normalized_sha256: 'a'.repeat(64),
  current_normalized_sha256: 'a'.repeat(64),
  matches_current: true,
  changed_keys: [],
  thesis_count: 8,
  trading_enabled: false,
};

describe('dashboard publication guardrails', () => {
  test('accepts a non-trading publication result', () => {
    expect(isPublicationResult(validResult)).toBe(true);
  });

  test('rejects any result that claims trading is enabled', () => {
    expect(isPublicationResult({ ...validResult, trading_enabled: true })).toBe(false);
  });

  test('rejects an unexpected snapshot target', () => {
    expect(isPublicationResult({ ...validResult, target_id: 'other' })).toBe(false);
  });

  test('parses a bounded JSON response', async () => {
    const response = Response.json(validResult);
    expect(await boundedJson(response)).toEqual(validResult);
  });

  test('rejects a response larger than the publication contract', async () => {
    const response = new Response('x', {
      headers: { 'content-length': String(65 * 1024) },
    });
    expect(boundedJson(response)).rejects.toThrow('exceeded the size limit');
  });
});
