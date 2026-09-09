import { describe, expect, test } from 'bun:test';

import { PUBLIC_DESK_UNAVAILABLE } from '@quantanamo/contracts/desk-snapshot';

import { parseDeskResponseText } from './desk-client';

describe('parseDeskResponseText', () => {
  test('accepts a desk envelope and never surfaces a raw parse exception', () => {
    expect(parseDeskResponseText('{"generated_at":"2026-09-09T00:00:00.000Z"}')).toEqual({
      generated_at: '2026-09-09T00:00:00.000Z',
    });
    expect(() => parseDeskResponseText('<!DOCTYPE html><html><body>oops</body></html>'))
      .toThrow(PUBLIC_DESK_UNAVAILABLE);
    expect(() => parseDeskResponseText('error code: 1102')).toThrow(PUBLIC_DESK_UNAVAILABLE);
    expect(() => parseDeskResponseText('{not-json')).toThrow(PUBLIC_DESK_UNAVAILABLE);
    expect(() => parseDeskResponseText('')).toThrow(PUBLIC_DESK_UNAVAILABLE);
    try {
      parseDeskResponseText('<!DOCTYPE html>');
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toMatch(/Unexpected token/);
    }
  });
});
