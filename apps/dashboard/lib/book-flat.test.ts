import { describe, expect, it } from 'bun:test';
import { assembleBookPerformance } from './book-performance';
import type { AccountRow, ExposureRow } from './ledger-types';

const snap = (observed_at: string, total: number, equity = 0): AccountRow =>
  ({ observed_at, account_label: 'Agentic 7638', total_value: total, equity_value: equity, cash: total - equity,
     buying_power: total - equity, source: 'robinhood_mcp' }) as unknown as AccountRow;
const tomb = (symbol: string, observed_at: string): ExposureRow =>
  ({ symbol, quantity: 0, average_buy_price: null, last_price: null, observed_at, account_last4: '7638' }) as unknown as ExposureRow;

describe('flat book after exits', () => {
  it('uses the newest snapshot when the latest exposure batch is all zero-quantity', () => {
    const snaps = [
      snap('2026-10-09T23:18:00.000Z', 5045.37),
      snap('2026-10-08T16:49:08.301Z', 5045.37),
      snap('2026-10-07T23:21:40.000Z', 5264.03, 4369.29),
    ];
    const book = assembleBookPerformance({
      snapshotsNewestFirst: snaps,
      starting: snap('2026-08-23T16:00:00.000Z', 5000),
      exposures: [tomb('NBIS', '2026-10-08T16:49:08.301Z'), tomb('CODA', '2026-10-08T16:49:08.301Z')],
    });
    expect(book.observed_at).toBe('2026-10-09T23:18:00.000Z');
    expect(book.current_nav).toBe(5045.37);
    expect(book.day_pnl).toBe(0);
  });
});
