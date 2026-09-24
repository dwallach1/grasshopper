import { describe, expect, test } from 'bun:test';

import { attachPnlStart, PNL_TAIL_LIMIT } from './pnl-inception';

function row(id: string, as_of: string) {
  return { id, as_of, equity_sol: 1 };
}

describe('attachPnlStart', () => {
  test('a short tail already holds day one, so pnl_start stays null', () => {
    const latest = [row('now', '2026-09-24T17:16:03.795Z'), row('seed', '2026-09-06T14:23:40.405Z')];
    const attached = attachPnlStart(latest, latest[1], 28);
    expect(attached.pnl).toEqual(latest);
    expect(attached.pnl_start).toBeNull();
    expect(PNL_TAIL_LIMIT).toBe(200);
  });

  test('a full tail keeps its rows and attaches the earlier ledger mark', () => {
    const latest = Array.from({ length: 28 }, (_, index) => row(
      `tail-${index}`,
      `2026-09-24T15:${String(index).padStart(2, '0')}:00.000Z`,
    ));
    const first = row('21e58b26-aee3-47ed-a0f0-ad1b4654f556', '2026-09-06T14:23:40.405Z');
    const attached = attachPnlStart(latest, first, 28);
    expect(attached.pnl).toHaveLength(28);
    expect(attached.pnl.some((item) => item.id === first.id)).toBe(false);
    expect(attached.pnl_start).toEqual(first);
  });

  test('a full tail that already includes the first row does not duplicate it', () => {
    const latest = Array.from({ length: 28 }, (_, index) => row(`tail-${index}`, `2026-09-07T00:${String(index).padStart(2, '0')}:00.000Z`));
    const attached = attachPnlStart(latest, latest[27], 28);
    expect(attached.pnl_start).toBeNull();
    expect(attached.pnl).toHaveLength(28);
  });

  test('a missing first row leaves the tail alone', () => {
    const latest = [row('only', '2026-09-24T17:16:03.795Z')];
    expect(attachPnlStart(latest, null, 1)).toEqual({ pnl: latest, pnl_start: null });
    expect(attachPnlStart([], undefined, 28)).toEqual({ pnl: [], pnl_start: null });
  });
});
