import { describe, expect, test } from 'bun:test';

import { assembleBookPerformance, isAgenticAccount } from './book-performance';
import { DESK_TABS, surfaceFromGoLetter, surfaceFromPath } from './desk-nav';
import type { AccountRow, AutomationRow, CloudRunRow, PositionRow, RunRow } from './ledger-types';
import { nyDateKey } from './ny-date';
import { assembleRoutines } from './routines';

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

function position(symbol: string, quantity: number, average_cost: number | null): PositionRow {
  return {
    id: symbol,
    account_key: 'agentic',
    symbol,
    status: 'open',
    quantity,
    average_cost,
    opened_at: '2026-08-26T19:01:00.000Z',
    next_review_at: null,
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
  test('uses prior NY session snapshot for day P/L and does not invent marks', () => {
    const starting = snapshot({
      observed_at: '2026-08-23T20:26:25.000Z',
      total_value: 5000,
      cash: 5000,
      equity_value: 0,
    });
    const prior = snapshot({
      observed_at: '2026-08-25T22:42:14.567Z',
      total_value: 5000,
      cash: 5000,
      equity_value: 0,
    });
    const latest = snapshot({
      observed_at: '2026-08-26T20:03:24.218Z',
      total_value: 5002.99,
      cash: 2000,
      equity_value: 3002.99,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [latest, prior, starting],
      starting,
      positions: [
        position('IREN', 25.208855, 39.6686),
        position('NBIS', 4.653004, 214.9149),
        position('CIFR', 63.211524, 15.8199),
      ],
    });
    expect(isAgenticAccount('Agentic ••••7638')).toBe(true);
    expect(isAgenticAccount('robinhood_7254')).toBe(false);
    expect(book.current_nav).toBeCloseTo(5002.99);
    expect(book.starting_nav).toBe(5000);
    expect(book.cash).toBe(2000);
    expect(book.deployed).toBeCloseTo(3002.99);
    expect(book.vs_start).toBeCloseTo(2.99);
    expect(book.day_pnl).toBeCloseTo(2.99);
    expect(book.day_pnl_note).toContain('prior NY session');
    expect(book.vs_cost).toBeCloseTo(2.99, 1);
    expect(book.names).toHaveLength(3);
    expect(book.names.every((row) => row.mark === null && row.pnl === null)).toBe(true);
    expect(book.names.every((row) => row.note === 'mark not in ledger')).toBe(true);
    expect(nyDateKey(latest.observed_at)).toBe('2026-08-26');
  });

  test('says so when day P/L or cost is missing', () => {
    const onlyToday = snapshot({
      observed_at: '2026-08-26T20:03:24.218Z',
      total_value: 5002.99,
      cash: 2000,
      equity_value: 3002.99,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [onlyToday],
      starting: onlyToday,
      positions: [position('IREN', 25, null)],
    });
    expect(book.day_pnl).toBeNull();
    expect(book.day_pnl_note).toBe('no prior-session snapshot in ledger');
    expect(book.vs_cost).toBeNull();
    expect(book.vs_cost_note).toBe('average cost missing on an open episode');
    expect(book.names[0]?.mark).toBeNull();
  });

  test('ignores non-Agentic snapshots so personal accounts cannot invent proof P/L', () => {
    const personal = snapshot({
      account_label: 'robinhood_7254',
      observed_at: '2026-08-26T21:00:00.000Z',
      total_value: 480261.61,
    });
    const agentic = snapshot({
      observed_at: '2026-08-26T20:03:24.218Z',
      total_value: 5002.99,
      cash: 2000,
      equity_value: 3002.99,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [personal, agentic],
      starting: agentic,
      positions: [],
    });
    expect(book.current_nav).toBeCloseTo(5002.99);
    expect(book.vs_start).toBe(0);
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
