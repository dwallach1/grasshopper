import { describe, expect, test } from 'bun:test';

import { lessonWaitLine, mapLessonWaits } from './lesson-waits';

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
    expect(lessonWaitLine({ test_id: 40, test_status: 'survived', age_days: 4 })).toBeNull();
    expect(lessonWaitLine({ test_id: 36, test_status: 'killed', age_days: 20 })).toBeNull();
    expect(lessonWaitLine({ test_id: null, test_status: 'queued', age_days: 4 })).toBeNull();
    expect(lessonWaitLine(null)).toBeNull();
  });
});
