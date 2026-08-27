import { describe, expect, test } from 'bun:test';

import { nyClock, nyStamp } from './ny-date';

describe('nyStamp', () => {
  test('is hydration-stable: comma, not ICU at, pinned hour12', () => {
    expect(nyStamp('2026-08-27T16:37:52.267794Z')).toBe('Aug 27, 12:37 PM ET');
    expect(nyStamp('2026-08-27T16:37:52.267794Z')).not.toContain(' at ');
    expect(nyClock('2026-08-27T16:37:52.267794Z')).toBe('12:37:52 PM');
  });

  test('empty timestamps stay a dash', () => {
    expect(nyStamp(null)).toBe('—');
    expect(nyClock(undefined)).toBe('—');
  });
});
