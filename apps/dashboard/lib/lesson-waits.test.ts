import { describe, expect, test } from 'bun:test';

import {
  lessonAgeLine,
  lessonWaitLine,
  mapLessonWaits,
  openLessonGroup,
  OPEN_LESSON_STALE_DAYS,
} from './lesson-waits';

describe('open lesson waits', () => {
  test('a blank age stays unknown, and a bad row is dropped', () => {
    expect(mapLessonWaits([
      {
        lesson_id: '134',
        thesis_id: ' earnings_gap_structure ',
        test_id: '41',
        test_status: ' queued ',
        age_days: '4',
      },
      { lesson_id: 137, thesis_id: 'earnings_gap_structure', test_id: null, test_status: null, age_days: '' },
      { lesson_id: 0, thesis_id: 'earnings_gap_structure' },
      { lesson_id: 12, thesis_id: '' },
      null,
      'not a row',
    ])).toEqual([
      {
        lesson_id: 134,
        thesis_id: 'earnings_gap_structure',
        test_id: 41,
        test_status: 'queued',
        age_days: 4,
      },
      {
        lesson_id: 137,
        thesis_id: 'earnings_gap_structure',
        test_id: null,
        test_status: null,
        age_days: null,
      },
    ]);
    expect(mapLessonWaits(undefined)).toEqual([]);
  });

  test('the Book line names a queued test and its age, and stays quiet once the test has a result', () => {
    expect(lessonWaitLine({ test_id: 41, test_status: 'queued', age_days: 4 }))
      .toBe('Waiting on test 41, queued 4 days');
    expect(lessonWaitLine({ test_id: 41, test_status: 'queued', age_days: 1 }))
      .toBe('Waiting on test 41, queued 1 day');
    expect(lessonWaitLine({ test_id: 41, test_status: 'queued', age_days: 0 }))
      .toBe('Waiting on test 41, queued today');
    expect(lessonWaitLine({ test_id: 99, test_status: 'queued', age_days: null }))
      .toBe('Waiting on test 99, still queued');
    expect(lessonWaitLine({ test_id: 99, test_status: 'queued', age_days: -1 }))
      .toBe('Waiting on test 99, still queued');
    expect(lessonWaitLine({ test_id: 42, test_status: null, age_days: null }))
      .toBe('Waiting on test 42');
    expect(lessonWaitLine({ test_id: 40, test_status: 'survived', age_days: 4 }))
      .toBe('Test finished, ready to decide');
    expect(lessonWaitLine({ test_id: 36, test_status: 'killed', age_days: 20 }))
      .toBe('Test finished, ready to decide');
    expect(lessonWaitLine({ test_id: 5, test_status: 'retired', age_days: 30 }))
      .toBe('Test finished, ready to decide');
    expect(lessonWaitLine({ test_id: 51, test_status: 'lookahead_invalid', age_days: 2 }))
      .toBe('Test finished, ready to decide');
    expect(lessonWaitLine({ test_id: 7, test_status: 'passed', age_days: 3 })).toBeNull();
    expect(lessonWaitLine({ test_id: null, test_status: 'queued', age_days: 4 })).toBeNull();
    expect(lessonWaitLine(null)).toBeNull();
  });

  test('a finished test is ready to write, and only a queued or unnamed test is still waiting', () => {
    const cases = [
      { test_id: 51, test_status: 'killed', age_days: 1 },
      { test_id: 40, test_status: 'survived', age_days: 4 },
      { test_id: 5, test_status: 'retired', age_days: 30 },
      { test_id: 51, test_status: 'lookahead_invalid', age_days: 2 },
      { test_id: 7, test_status: 'passed', age_days: 3 },
      { test_id: 41, test_status: 'queued', age_days: 4 },
      { test_id: 41, test_status: 'queued', age_days: 0 },
      { test_id: 99, test_status: 'queued', age_days: null },
      { test_id: 42, test_status: null, age_days: null },
      { test_id: null, test_status: 'queued', age_days: 4 },
    ] as const;
    for (const wait of cases) {
      const line = lessonWaitLine(wait);
      const group = openLessonGroup(wait);
      if (line !== null && line.startsWith('Waiting on test')) expect(group).toBe('waiting');
      else expect(group).toBe('ready');
    }
    expect(openLessonGroup(null)).toBe('ready');
    expect(openLessonGroup(undefined)).toBe('ready');
    expect(openLessonGroup({ test_id: 51, test_status: 'killed', age_days: 1 })).toBe('ready');
    expect(openLessonGroup({ test_id: 41, test_status: 'queued', age_days: 4 })).toBe('waiting');
    expect(openLessonGroup({ test_id: 42, test_status: null, age_days: null })).toBe('waiting');
  });

  test('an open lesson says how long it has been open', () => {
    const now = Date.parse('2026-11-04T18:00:00.000Z');
    expect(lessonAgeLine('2026-11-04T16:07:31.000Z', now)).toBe('Opened today');
    expect(lessonAgeLine('2026-11-03T16:07:31.000Z', now)).toBe('Open 1 day');
    expect(lessonAgeLine('2026-10-20T16:07:31.000Z', now)).toBe('Open 15 days');
    expect(lessonAgeLine('not-a-time', now)).toBeNull();
    expect(OPEN_LESSON_STALE_DAYS).toBe(7);
  });
});
