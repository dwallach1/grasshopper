import { describe, expect, test } from 'bun:test';

import { assembleBookPerformance, isAgenticAccount } from './book-performance';
import { DESK_TABS, surfaceFromGoLetter, surfaceFromPath } from './desk-nav';
import type { AccountRow, AutomationRow, CloudRunRow, ExposureRow, RunRow } from './ledger-types';
import { nyDateKey } from './ny-date';
import { assembleRoutines } from './routines';
import { AGENTIC_LAST4 } from './thesis-book';

function snapshot(partial: Partial<AccountRow> & Pick<AccountRow, 'observed_at' | 'total_value'>): AccountRow {
  return {
    account_label: 'Agentic',
    equity_value: 0,
    cash: 0,
    buying_power: 0,
    source: 'robinhood_mcp',
    ...partial,
  };
}

function exposure(symbol: string, quantity: number, average_buy_price: number): ExposureRow {
  return {
    symbol,
    quantity,
    average_buy_price,
    observed_at: '2026-08-27T13:22:00.000Z',
    account_last4: AGENTIC_LAST4,
  };
}

describe('desk nav labels', () => {
  test('tab bar uses spelled-out words, not 3–4 letter codes', () => {
    const labels = DESK_TABS.map((tab) => tab.label);
    expect(labels).toEqual([
      'Home', 'Book', 'Theses', 'Runs', 'Tests', 'Catalysts', 'Lessons', 'Ontology', 'Risk',
    ]);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(3);
      expect(/^[A-Z]{3,4}$/.test(label)).toBe(false);
    }
    expect(DESK_TABS.map((tab) => tab.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  test('path and go-letter map to the same surfaces', () => {
    expect(surfaceFromPath('/')).toBe('home');
    expect(surfaceFromPath('/book')).toBe('book');
    expect(surfaceFromPath('/learnings')).toBe('learnings');
    expect(surfaceFromGoLetter('h')).toBe('home');
    expect(surfaceFromGoLetter('b')).toBe('book');
    expect(surfaceFromGoLetter('k')).toBe('backtests');
    expect(surfaceFromGoLetter('e')).toBe('backtests');
    expect(surfaceFromGoLetter('i')).toBe('risk');
  });
});

describe('Agentic book performance', () => {
  test('uses the matching 8/27 snapshot and latest 7638 lots including DG', () => {
    const starting = snapshot({
      observed_at: '2026-08-23T20:26:25.000Z',
      total_value: 5000,
      cash: 5000,
      equity_value: 0,
    });
    const prior = snapshot({
      observed_at: '2026-08-26T20:03:24.218Z',
      total_value: 5002.99,
      cash: 2000,
      equity_value: 3002.99,
      buying_power: 2000,
    });
    const latest = snapshot({
      observed_at: '2026-08-27T13:22:00.000Z',
      total_value: 5134.57473627,
      cash: 148.5,
      equity_value: 4986.07473627,
      buying_power: 148.5,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [latest, prior, starting],
      starting,
      exposures: [
        exposure('IREN', 25.208855, 39.67),
        exposure('NBIS', 4.653004, 214.91),
        exposure('CIFR', 63.211524, 15.82),
        exposure('DG', 14, 132.25),
      ],
    });
    expect(isAgenticAccount('Agentic ••••7638')).toBe(true);
    expect(isAgenticAccount('robinhood_7254')).toBe(false);
    expect(book.current_nav).toBeCloseTo(5134.57473627);
    expect(book.cash).toBeCloseTo(148.5);
    expect(book.buying_power).toBeCloseTo(148.5);
    expect(book.deployed).toBeCloseTo(4986.07473627);
    expect(book.observed_at).toBe('2026-08-27T13:22:00.000Z');
    expect(book.last4).toBe(AGENTIC_LAST4);
    expect(book.names.map((row) => row.symbol)).toEqual(['CIFR', 'DG', 'IREN', 'NBIS']);
    expect(book.names.find((row) => row.symbol === 'DG')?.quantity).toBe(14);
    expect(book.names.every((row) => row.mark === null && row.pnl === null)).toBe(true);
    expect(book.names.every((row) => row.note === 'mark not in ledger')).toBe(true);
    expect(book.day_pnl).toBeCloseTo(5134.57473627 - 5002.99);
    expect(nyDateKey(latest.observed_at)).toBe('2026-08-27');
  });

  test('does not keep yesterday NAV when the 7638 book has no matching snapshot', () => {
    const stale = snapshot({
      observed_at: '2026-08-26T20:03:24.218Z',
      total_value: 5002.99,
      cash: 2000,
      equity_value: 3002.99,
      buying_power: 2000,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [stale],
      starting: stale,
      exposures: [exposure('DG', 14, 132.25)],
    });
    expect(book.names.map((row) => row.symbol)).toEqual(['DG']);
    expect(book.observed_at).toBe('2026-08-27T13:22:00.000Z');
    expect(book.current_nav).toBeNull();
    expect(book.cash).toBeNull();
    expect(book.buying_power).toBeNull();
    expect(book.day_pnl).toBeNull();
  });

  test('says so when day P/L or cost is missing', () => {
    const onlyToday = snapshot({
      observed_at: '2026-08-27T13:22:00.000Z',
      total_value: 5134.57473627,
      cash: 148.5,
      equity_value: 4986.07473627,
      buying_power: 148.5,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [onlyToday],
      starting: onlyToday,
      exposures: [{
        symbol: 'IREN',
        quantity: 25,
        average_buy_price: null,
        observed_at: '2026-08-27T13:22:00.000Z',
        account_last4: AGENTIC_LAST4,
      }],
    });
    expect(book.day_pnl).toBeNull();
    expect(book.day_pnl_note).toBe('no prior-session snapshot in ledger');
    expect(book.vs_cost).toBeNull();
    expect(book.vs_cost_note).toBe('average buy missing on an open lot');
    expect(book.names[0]?.mark).toBeNull();
  });

  test('ignores non-Agentic snapshots so personal accounts cannot invent proof P/L', () => {
    const personal = snapshot({
      account_label: 'robinhood_7254',
      observed_at: '2026-08-27T14:00:00.000Z',
      total_value: 480261.61,
    });
    const agentic = snapshot({
      observed_at: '2026-08-27T13:22:00.000Z',
      total_value: 5134.57473627,
      cash: 148.5,
      equity_value: 4986.07473627,
      buying_power: 148.5,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [personal, agentic],
      starting: agentic,
      exposures: [exposure('DG', 14, 132.25)],
    });
    expect(book.current_nav).toBeCloseTo(5134.57473627);
    expect(book.vs_start).toBe(0);
    expect(book.names.map((row) => row.symbol)).toEqual(['DG']);
  });
});

describe('QUANTANAMO routines', () => {
  test('live Grok Bot cadences use last ledger run, not a next-fire clock', () => {
    const runs: RunRow[] = [
      {
        id: 1,
        run_type: 'market_scan',
        started_at: '2026-08-26T20:03:24.218Z',
        completed_at: '2026-08-26T20:03:24.218Z',
        notes: 'First scheduled market_scan',
        parsed: {
          outcome: 'passed',
          headline: 'Market Scan',
          summary: 'First scheduled market_scan',
          insights: [],
          learnings: [],
          actions: [],
          error: null,
          raw: 'First scheduled market_scan',
        },
      },
    ];
    const automations: AutomationRow[] = [
      {
        id: 'thesisforge-market-hours-thesis-refresh',
        name: 'ThesisForge market-hours thesis refresh',
        status: 'PAUSED',
        rrule: 'RRULE:FREQ=WEEKLY',
        model: null,
        next_run_at: '2026-08-20T14:15:00.000Z',
        last_run_at: '2026-08-24T14:16:03.782Z',
      },
    ];
    const cloudRuns: CloudRunRow[] = [];
    const routines = assembleRoutines({ runs, automations, cloudRuns });
    const live = routines.filter((row) => row.status === 'live');
    expect(live.map((row) => row.id)).toEqual(['market_scan', 'missed_swing_autopsy']);
    expect(live[0]?.last_run_at).toBe('2026-08-26T20:03:24.218Z');
    expect(live[1]?.last_run_at).toBeNull();
    expect(routines.some((row) => 'at' in row)).toBe(false);
    const retired = routines.filter((row) => row.status === 'retired');
    expect(retired.some((row) => row.name.includes('ThesisForge'))).toBe(true);
    expect(retired.some((row) => row.id === 'cloudflare-workers')).toBe(true);
    expect(retired.every((row) => row.status === 'retired')).toBe(true);
  });
});
