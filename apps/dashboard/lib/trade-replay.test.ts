import { describe, expect, test } from 'bun:test';

import { NOT_IN_LEDGER } from './book-performance';
import type { FillLogRow } from './ledger-types';
import {
  maxAbsNotional,
  replayFills,
  replayIntensity,
  replayProgress,
  tapeCaption,
  tapeIdentity,
} from './trade-replay';

function fill(partial: Partial<FillLogRow> & Pick<FillLogRow, 'id' | 'at' | 'symbol'>): FillLogRow {
  return {
    side: 'buy',
    quantity: 1,
    price: 10,
    notional: 10,
    status: 'filled',
    source: 'broker_fill',
    note: '',
    venue: 'equity',
    ...partial,
  };
}

describe('trade replay tape', () => {
  test('plays oldest-first and does not invent ids or symbols', () => {
    const newestFirst = [
      fill({ id: 'later', at: '2026-09-06T13:43:43.294Z', symbol: 'AOUT', notional: 1796.472 }),
      fill({
        id: 'pm',
        at: '2026-09-06T13:43:43.294Z',
        symbol: 'YES · rdc-usfed-fomc-2026-09-16-hike25',
        source: 'prediction_fill',
        venue: 'prediction',
        notional: 65.4891,
      }),
      fill({ id: 'early', at: '2026-08-28T13:46:18.317Z', symbol: 'IREN', side: 'sell', notional: 941.755 }),
    ];
    const tape = replayFills(newestFirst);
    expect(tape.map((row) => row.id)).toEqual(['early', 'later', 'pm']);
    expect(tape.map((row) => row.symbol)).toEqual([
      'IREN',
      'AOUT',
      'YES · rdc-usfed-fomc-2026-09-16-hike25',
    ]);
    expect(new Set(tape.map((row) => row.id))).toEqual(new Set(newestFirst.map((row) => row.id)));
  });

  test('empty ledger stays empty — no synthetic fill', () => {
    expect(replayFills([])).toEqual([]);
    expect(replayProgress(0, 0)).toBe(0);
    expect(replayIntensity(undefined, 100)).toBe(0);
    expect(tapeCaption([])).toBe(NOT_IN_LEDGER);
  });

  test('progress maps index onto 0–100 without inventing a step past the tape', () => {
    expect(replayProgress(0, 1)).toBe(100);
    expect(replayProgress(0, 4)).toBe(0);
    expect(replayProgress(3, 4)).toBe(100);
    expect(replayProgress(9, 4)).toBe(100);
    expect(replayProgress(-1, 4)).toBe(0);
  });

  test('intensity uses ledger notional only; missing notional is 0', () => {
    const rows = [
      fill({ id: 'a', at: '2026-08-28T13:46:18.317Z', symbol: 'IREN', notional: 941.755 }),
      fill({ id: 'b', at: '2026-09-03T17:21:54.583Z', symbol: 'AOUT', notional: 1796.472 }),
      fill({ id: 'c', at: '2026-09-06T13:43:43.294Z', symbol: 'YES', notional: null, note: 'notional not in ledger' }),
    ];
    const max = maxAbsNotional(rows);
    expect(max).toBeCloseTo(1796.472);
    expect(replayIntensity(rows[1], max)).toBe(100);
    expect(replayIntensity(rows[0], max)).toBe(52);
    expect(replayIntensity(rows[2], max)).toBe(0);
    expect(maxAbsNotional([rows[2]])).toBe(0);
  });

  test('tape identity ignores array wrapping so a poll refresh is not a new story', () => {
    const rows = [
      fill({ id: 'early', at: '2026-08-28T13:46:18.317Z', symbol: 'IREN' }),
      fill({ id: 'later', at: '2026-09-03T17:21:54.583Z', symbol: 'AOUT' }),
    ];
    expect(tapeIdentity(replayFills(rows))).toBe(tapeIdentity(replayFills([...rows])));
    expect(tapeIdentity(replayFills(rows))).not.toBe(
      tapeIdentity(replayFills(rows.filter((row) => row.venue === 'equity' && row.symbol === 'IREN'))),
    );
  });
});
