import { describe, expect, test } from 'bun:test';

import type { LessonRow, StrategyTestRow } from './ledger-types';
import {
  lessonsWaitingLine,
  namedTestIds,
  nyCalendarDaysSince,
  stuckReason,
  testCheckLine,
  waitingBlurb,
  waitingDaysLine,
  waitingTestsForThesis,
} from './waiting-tests';

const NOW = Date.parse('2026-11-02T18:30:00.000Z');

function lesson(partial: Partial<LessonRow> & Pick<LessonRow, 'id' | 'summary'>): LessonRow {
  return {
    cycle_id: 1,
    test_id: null,
    thesis_id: 'earnings_gap_structure',
    lesson_type: 'pattern_confirm',
    market_regime: null,
    incorporated: false,
    created_at: '2026-10-20T00:00:00.000Z',
    ...partial,
  };
}

function queued(partial: Partial<StrategyTestRow> & Pick<StrategyTestRow, 'id' | 'cycle_id'>): StrategyTestRow {
  return {
    external_key: `t-${partial.id}`,
    variant_label: 'internal-label-v1',
    status: 'queued',
    total_return: null,
    max_drawdown: null,
    deflated_sharpe: null,
    cost_multiplier: 1,
    stress_regime: null,
    failure_reason: 'queued_needs_universe_build: qualifying count not yet computed.',
    autopsy: null,
    tested_at: '2026-10-15T23:29:57.000Z',
    price_source: null,
    window_start: null,
    window_end: null,
    symbols: null,
    params_json: null,
    ...partial,
  };
}

describe('waiting tests on a thesis', () => {
  test('names the same preregistered ids the ledger helper does', () => {
    expect(namedTestIds('Preregistered as strategy_test #41 and queued test 36.')).toEqual([41, 36]);
    expect(namedTestIds('Test 42 preregistered. Killed by test 30.')).toEqual([42]);
    expect(namedTestIds('cycle prereg, no id')).toEqual([]);
  });

  test('counts New York calendar days and does not invent a start', () => {
    expect(nyCalendarDaysSince('2026-10-15T23:29:57.000Z', NOW)).toBe(18);
    expect(nyCalendarDaysSince('2026-10-30T23:28:09.000Z', NOW)).toBe(3);
    expect(nyCalendarDaysSince(null, NOW)).toBeNull();
    expect(waitingDaysLine(18)).toBe('Waiting 18 days.');
    expect(waitingDaysLine(1)).toBe('Waiting 1 day.');
    expect(waitingDaysLine(0)).toBe('Queued today.');
    expect(waitingDaysLine(null)).toBe('Still waiting.');
  });

  test('rewrites the stuck reason without the machine tag', () => {
    expect(stuckReason('queued_needs_universe_build: qualifying count not yet computed.')).toBe(
      'The price history for this test has not been built yet.',
    );
    expect(stuckReason(
      'queued_needs_universe_build: Financial Datasets is out of credits (10/26), so build on Robinhood daily bars.',
    )).toBe('The price history was never built. The market-data feed ran out of credits.');
    expect(stuckReason(
      'queued_needs_universe_build: there was no time in this autopsy run (the 10/28 and 10/29 runs timed out).',
    )).toBe('The price history was never built. The last run ran out of time.');
    expect(stuckReason(null)).toBeNull();
  });

  test('takes one short line from the hypothesis, preferring the question', () => {
    expect(testCheckLine(
      'Fri 10/30 autopsy: tech beats fell. Does the beat get rewarded by sector in a risk-off tape?',
    )).toBe('Does the beat get rewarded by sector in a risk-off tape?');
    expect(testCheckLine('The gap follows through.')).toBe('The gap follows through.');
    expect(testCheckLine('')).toBeNull();
  });

  test('a thesis lists each queued test, its wait, and the open lessons that depend on it', () => {
    const rows = waitingTestsForThesis({
      thesisId: 'earnings_gap_structure',
      nowMs: NOW,
      cycles: [
        { id: 143, thesis_id: 'earnings_gap_structure', hypothesis: 'Thu 10/15 autopsy. The second gap continues.' },
        { id: 170, thesis_id: 'earnings_gap_structure', hypothesis: 'HAS was the missed swing.' },
        { id: 173, thesis_id: 'earnings_gap_structure', hypothesis: 'Verified report dates, not anniversaries.' },
        { id: 184, thesis_id: 'earnings_gap_structure', hypothesis: 'The line inside the implied move fired before the print.' },
        { id: 211, thesis_id: 'earnings_gap_structure', hypothesis: 'Fri autopsy. Does the beat get rewarded by sector in a risk-off tape?' },
        { id: 9, thesis_id: 'other', hypothesis: 'Not this thesis.' },
      ],
      tests: [
        queued({ id: 39, cycle_id: 143, tested_at: '2026-10-15T23:29:57.000Z' }),
        queued({
          id: 43,
          cycle_id: 170,
          tested_at: '2026-10-20T23:27:30.000Z',
          failure_reason: 'queued_needs_universe_build: rules locked 2026-10-20.',
        }),
        queued({ id: 44, cycle_id: 173, tested_at: '2026-10-21T23:30:26.000Z' }),
        queued({
          id: 47,
          cycle_id: 184,
          tested_at: '2026-10-26T23:29:36.000Z',
          failure_reason: 'queued_needs_universe_build: Financial Datasets is out of credits (10/26).',
        }),
        queued({
          id: 49,
          cycle_id: 211,
          tested_at: '2026-10-30T23:28:09.000Z',
          failure_reason: 'queued_needs_universe_build: the 10/28 and 10/29 runs timed out.',
        }),
        queued({ id: 8, cycle_id: 9, tested_at: '2026-10-01T00:00:00.000Z' }),
      ],
      lessons: [
        lesson({ id: 140, cycle_id: 170, test_id: 43, summary: 'Serial positive reactor (seed HAS 10/20 AM +11.2%). Preconditions follow.' }),
        lesson({ id: 142, cycle_id: 170, test_id: null, summary: 'On 10/20 the guide decided every beat. That is for test 41, not a rule.' }),
        lesson({ id: 153, cycle_id: 174, test_id: 43, summary: 'Serial-positive forward check (cycle 170). The prediction is on track to fail.' }),
        lesson({ id: 164, cycle_id: 184, test_id: 47, summary: 'Print-day line inside the implied move is a noise stop. CLS was sold early.' }),
        lesson({ id: 170, cycle_id: 190, test_id: 47, summary: 'CLS finalized the shadow. Test #47 stays queued; no rule change yet.' }),
        lesson({ id: 193, cycle_id: 211, test_id: null, summary: 'Sector split in a beat-selling tape. Next tests: VRTX versus AMD (cycle prereg).' }),
        lesson({ id: 200, cycle_id: 211, test_id: null, incorporated: true, summary: 'Already in the playbook. cycle prereg.' }),
      ],
    });

    expect(rows.map((row) => row.id)).toEqual([39, 43, 44, 47, 49]);
    expect(rows.find((row) => row.id === 43)).toMatchObject({
      days: 13,
      daysLine: 'Waiting 13 days.',
      why: 'The price history for this test has not been built yet.',
    });
    expect(rows.find((row) => row.id === 43)?.lessons.map((row) => row.id)).toEqual([140, 153]);
    expect(rows.find((row) => row.id === 47)?.why).toBe(
      'The price history was never built. The market-data feed ran out of credits.',
    );
    expect(rows.find((row) => row.id === 47)?.lessons.map((row) => row.id)).toEqual([164, 170]);
    expect(rows.find((row) => row.id === 49)?.lessons.map((row) => row.id)).toEqual([193]);
    expect(rows.find((row) => row.id === 49)?.check).toBe(
      'Does the beat get rewarded by sector in a risk-off tape?',
    );
    expect(rows.find((row) => row.id === 39)?.lessons).toEqual([]);
    expect(rows.find((row) => row.id === 39)?.lessonsLine).toBeNull();
    expect(lessonsWaitingLine(['Serial positive reactor (seed HAS 10/20 AM +11', 'Serial-positive forward check (cycle 170)'])).toContain(
      'Lessons still open:',
    );
    expect(waitingBlurb(rows)).toBe('5 tests are still waiting, the oldest for 18 days.');
    const text = JSON.stringify(rows);
    expect(text).not.toContain('queued_needs_universe_build');
    expect(text).not.toContain('internal-label');
    expect(text).not.toContain('test_id');
  });
});
