import { describe, expect, test } from 'bun:test';

import { mapShadowCandidates, shadowPointText, shadowTallyLine, type ShadowCandidate } from './shadow-tally';

function row(extra: Partial<ShadowCandidate> = {}): ShadowCandidate {
  return {
    candidate_key: 'ah_open_holds_prior_close',
    lesson_id: 152,
    test_id: 44,
    thesis_id: 'earnings_gap_structure',
    steward: 'quantanamo',
    kind: 'exit',
    checked: 0,
    flagged: 0,
    n: 0,
    mean_delta_pct: null,
    lcb_delta_pct: null,
    clips_to_decide: 10,
    promotable: false,
    ...extra,
  };
}

describe('shadow tally sentences', () => {
  test('no scored exit clip stays unscored', () => {
    expect(shadowTallyLine(row())).toBe(
      'After-hours sale, cancelled when the regular open is at or above the prior close: no scored clip yet. It does not replace the exit.',
    );
  });

  test('a flat scorecard names the clips still needed', () => {
    expect(shadowTallyLine(row({
      checked: 2,
      flagged: 2,
      n: 2,
      mean_delta_pct: 0,
      lcb_delta_pct: 0,
      clips_to_decide: 8,
    }))).toBe(
      'After-hours sale, cancelled when the regular open is at or above the prior close: 2 clips, flat versus the real sale. The cautious average is still not above zero. 8 more before it can replace that exit.',
    );
  });

  test('a missing mean does not invent a point tally', () => {
    expect(shadowTallyLine(row({ n: 1, mean_delta_pct: null, lcb_delta_pct: null, clips_to_decide: 9 })))
      .toContain('the result is not priced yet');
    expect(shadowTallyLine(row({ n: 1, mean_delta_pct: null, lcb_delta_pct: null, clips_to_decide: 9 })))
      .toContain('The cautious average is not in yet.');
  });

  test('zero that rounds away is flat, and a loss keeps its sign', () => {
    expect(shadowPointText(0)).toBe('flat');
    expect(shadowPointText(0.04)).toBe('flat');
    expect(shadowPointText(-1.24)).toBe('-1.2 points');
    expect(shadowTallyLine(row({
      n: 3,
      mean_delta_pct: -1.24,
      lcb_delta_pct: -2,
      clips_to_decide: 7,
    }))).toContain('-1.2 points versus the real sale');
  });

  test('a promotable exit says it cleared the bar', () => {
    expect(shadowTallyLine(row({
      n: 10,
      mean_delta_pct: 1.25,
      lcb_delta_pct: 0.2,
      clips_to_decide: 0,
      promotable: true,
    }))).toBe(
      'After-hours sale, cancelled when the regular open is at or above the prior close: 10 clips, +1.3 points versus the real sale. The cautious average is above zero. It has cleared the bar to replace that exit.',
    );
  });

  test('a cohort flag that never fired says so', () => {
    expect(shadowTallyLine(row({
      candidate_key: 'cohort_down_3pct',
      lesson_id: 151,
      test_id: 41,
      kind: 'entry_flag',
      checked: 4,
      flagged: 0,
      n: 0,
      clips_to_decide: null,
    }))).toBe(
      'Skip a pre-print buy when its group is down 3% or more that day: 4 entries checked, the group was not down that far, so nothing was skipped. Still a check beside test 41, not a rule.',
    );
  });

  test('a flagged skip with no price, and a scored skip, stay beside test 41', () => {
    expect(shadowTallyLine(row({
      candidate_key: 'cohort_down_3pct',
      lesson_id: 151,
      test_id: 41,
      kind: 'entry_flag',
      checked: 2,
      flagged: 1,
      n: 0,
      clips_to_decide: null,
    }))).toContain('the group was down that far, and the result is not priced yet');
    expect(shadowTallyLine(row({
      candidate_key: 'cohort_down_3pct',
      lesson_id: 151,
      test_id: 41,
      kind: 'entry_flag',
      checked: 3,
      flagged: 2,
      n: 2,
      mean_delta_pct: 1.2,
      lcb_delta_pct: 0.4,
      clips_to_decide: null,
    }))).toBe(
      'Skip a pre-print buy when its group is down 3% or more that day: 2 scored skips, +1.2 points. The cautious average is above zero. Still a check beside test 41, not a rule.',
    );
  });

  test('an unknown candidate renders nothing', () => {
    expect(shadowTallyLine(row({ candidate_key: 'mystery_rule' }))).toBeNull();
    expect(shadowTallyLine(null)).toBeNull();
  });

  test('numeric strings from the ledger coerce, and a bad row is dropped', () => {
    expect(mapShadowCandidates([
      {
        candidate_key: 'ah_open_holds_prior_close',
        lesson_id: '152',
        test_id: '44',
        thesis_id: 'earnings_gap_structure',
        steward: 'quantanamo',
        kind: 'exit',
        checked: '2',
        flagged: '2',
        n: '2',
        mean_delta_pct: '0',
        lcb_delta_pct: '0',
        clips_to_decide: '8',
        promotable: 'true',
      },
      { candidate_key: '', lesson_id: 1, kind: 'exit' },
      'nope',
    ])).toEqual([{
      candidate_key: 'ah_open_holds_prior_close',
      lesson_id: 152,
      test_id: 44,
      thesis_id: 'earnings_gap_structure',
      steward: 'quantanamo',
      kind: 'exit',
      checked: 2,
      flagged: 2,
      n: 2,
      mean_delta_pct: 0,
      lcb_delta_pct: 0,
      clips_to_decide: 8,
      promotable: true,
    }]);
    expect(mapShadowCandidates(null)).toEqual([]);
  });
});
