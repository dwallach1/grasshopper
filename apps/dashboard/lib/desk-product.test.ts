import { describe, expect, test } from 'bun:test';

import { PUBLIC_DESK_REDIRECTS } from '@quantanamo/contracts/desk-snapshot';

import { assembleBookPerformance, isAgenticAccount, MARK_NOT_IN_LEDGER, NOT_IN_LEDGER } from './book-performance';
import { allocationSlices, bookSlabs, slabTone } from './book-slabs';
import { navPathSeries } from './book-nav-path';
import {
  canonicalDeskPath,
  DESK_PATH_REDIRECTS,
  DESK_SURFACES,
  DESK_TABS,
  surfaceFromGoLetter,
  surfaceFromPath,
} from './desk-nav';
import { nextHeldCatalyst } from './held-catalyst';
import type { AccountRow, AutomationRow, CatalystRow, CloudRunRow, ExposureRow, RunRow } from './ledger-types';
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

function exposure(
  symbol: string,
  quantity: number,
  average_buy_price: number,
  observed_at = '2026-08-27T13:22:00.000Z',
  last_price: number | null = null,
): ExposureRow {
  return {
    symbol,
    quantity,
    average_buy_price,
    last_price,
    observed_at,
    account_last4: AGENTIC_LAST4,
  };
}

describe('desk nav labels', () => {
  test('six operator tabs: Board landing, Book, Theses, Events, Tests, Team', () => {
    const labels = DESK_TABS.map((tab) => tab.label);
    expect(labels).toEqual(['Book', 'Theses', 'Events', 'Tests', 'Team', 'Board']);
    expect(DESK_TABS.map((tab) => tab.id)).toEqual(['book', 'theses', 'events', 'backtests', 'team', 'leaderboard']);
    expect(DESK_TABS.map((tab) => tab.key)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(DESK_TABS.map((tab) => tab.href)).toEqual(['/book', '/theses', '/events', '/backtests', '/team', '/']);
    expect(DESK_TABS.map((tab) => tab.go)).toEqual(['b', 't', 'c', 'e', 'm', 'p']);
    expect(DESK_SURFACES).toEqual(['book', 'theses', 'events', 'backtests', 'team', 'leaderboard']);
    expect(labels).not.toContain('Home');
    expect(labels).not.toContain('Risk');
    expect(labels).not.toContain('Ontology');
    expect(labels).not.toContain('Runs');
    expect(labels).not.toContain('Lessons');
    expect(DESK_TABS.some((tab) => tab.go === 'r')).toBe(false);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(3);
      expect(/^[A-Z]{3,4}$/.test(label)).toBe(false);
    }
  });

  test('/ is the Board surface; /leaderboard aliases it and Book stays at /book', () => {
    expect(surfaceFromPath('/')).toBe('leaderboard');
    expect(surfaceFromPath('/leaderboard')).toBe('leaderboard');
    expect(surfaceFromPath('/board')).toBe('leaderboard');
    expect(surfaceFromPath('/book')).toBe('book');
    expect(surfaceFromPath('/risk')).toBe('book');
    expect(surfaceFromPath('/runs')).toBe('book');
    expect(surfaceFromPath('/home')).toBe('book');
    expect(surfaceFromPath('/events')).toBe('events');
    expect(surfaceFromPath('/catalysts')).toBe('events');
    expect(surfaceFromPath('/theses')).toBe('theses');
    expect(surfaceFromPath('/ontology')).toBe('theses');
    expect(surfaceFromPath('/learnings')).toBe('theses');
    expect(surfaceFromPath('/backtests')).toBe('backtests');
    expect(surfaceFromPath('/team')).toBe('team');
    expect(surfaceFromPath('/mates')).toBe('team');
    expect(canonicalDeskPath('/leaderboard')).toBe('/');
    expect(canonicalDeskPath('/book')).toBe('/book');
    expect(canonicalDeskPath('/catalysts')).toBe('/events');
    expect(canonicalDeskPath('/ontology')).toBe('/theses');
    expect(canonicalDeskPath('/risk')).toBe('/book');
    expect(canonicalDeskPath('/runs')).toBe('/book');
    expect(canonicalDeskPath('/learnings')).toBe('/theses');
    expect(canonicalDeskPath('/mates')).toBe('/team');
    expect(DESK_PATH_REDIRECTS.map((row) => row.source)).toEqual([
      '/leaderboard', '/catalysts', '/ontology', '/risk', '/runs', '/learnings', '/mates',
    ]);
    expect(PUBLIC_DESK_REDIRECTS).toEqual(DESK_PATH_REDIRECTS);
  });

  test('path and go-letter map to the same surfaces without colliding with r refresh', () => {
    expect(surfaceFromGoLetter('b')).toBe('book');
    expect(surfaceFromGoLetter('t')).toBe('theses');
    expect(surfaceFromGoLetter('c')).toBe('events');
    expect(surfaceFromGoLetter('e')).toBe('backtests');
    expect(surfaceFromGoLetter('m')).toBe('team');
    expect(surfaceFromGoLetter('p')).toBe('leaderboard');
    expect(surfaceFromGoLetter('d')).toBe('leaderboard');
    expect(surfaceFromGoLetter('a')).toBe('team');
    expect(surfaceFromGoLetter('h')).toBe('book');
    expect(surfaceFromGoLetter('k')).toBe('backtests');
    expect(surfaceFromGoLetter('l')).toBe('theses');
    expect(surfaceFromGoLetter('o')).toBe('theses');
    expect(surfaceFromGoLetter('i')).toBe('book');
    expect(surfaceFromGoLetter('r')).toBeNull();
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

  test('joins Agentic NAV when lots trail the snapshot by nine seconds', () => {
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
    const morning = snapshot({
      observed_at: '2026-08-27T13:22:00.000Z',
      total_value: 5134.57473627,
      cash: 148.5,
      equity_value: 4986.07473627,
      buying_power: 148.5,
    });
    const mid = snapshot({
      observed_at: '2026-08-27T15:29:00.000Z',
      total_value: 5100,
      cash: 148.5,
      equity_value: 4951.5,
      buying_power: 148.5,
    });
    const latest = snapshot({
      observed_at: '2026-08-27T16:22:10.669472Z',
      total_value: 5056.271,
      cash: 148.5,
      equity_value: 4907.771,
      buying_power: 148.5,
    });
    const lotAt = '2026-08-27T16:22:19.730934Z';
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [latest, mid, morning, prior, starting],
      starting,
      exposures: [
        exposure('CIFR', 63.211524, 15.82, lotAt),
        exposure('DG', 14, 132.25, lotAt),
        exposure('IREN', 25.208855, 39.67, lotAt),
        exposure('NBIS', 4.653004, 214.91, lotAt),
      ],
    });
    expect(book.current_nav).toBeCloseTo(5056.271);
    expect(book.cash).toBeCloseTo(148.5);
    expect(book.buying_power).toBeCloseTo(148.5);
    expect(book.deployed).toBeCloseTo(4907.771);
    expect(book.vs_start).toBeCloseTo(56.271);
    expect(book.starting_nav).toBe(5000);
    expect(book.day_pnl).toBeCloseTo(5056.271 - 5002.99);
    expect(book.observed_at).toBe(lotAt);
    expect(book.last4).toBe(AGENTIC_LAST4);
  });

  test('still fills same-day Agentic NAV when lots are minutes off the snapshot', () => {
    const latest = snapshot({
      observed_at: '2026-08-27T16:10:00.000Z',
      total_value: 5056.271,
      cash: 148.5,
      equity_value: 4907.771,
      buying_power: 148.5,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [latest],
      starting: snapshot({ observed_at: '2026-08-23T20:26:25.000Z', total_value: 5000 }),
      exposures: [exposure('DG', 14, 132.25, '2026-08-27T16:22:19.730934Z')],
    });
    expect(book.current_nav).toBeCloseTo(5056.271);
    expect(book.cash).toBeCloseTo(148.5);
    expect(book.buying_power).toBeCloseTo(148.5);
    expect(book.deployed).toBeCloseTo(4907.771);
    expect(book.vs_start).toBeCloseTo(56.271);
  });

  test('prefers the nearer same-day snapshot over a later one on that NY day', () => {
    const morning = snapshot({
      observed_at: '2026-08-27T13:22:00.000Z',
      total_value: 5134.57473627,
      cash: 148.5,
      equity_value: 4986.07473627,
      buying_power: 148.5,
    });
    const afternoon = snapshot({
      observed_at: '2026-08-27T16:22:10.669472Z',
      total_value: 5056.271,
      cash: 148.5,
      equity_value: 4907.771,
      buying_power: 148.5,
    });
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [afternoon, morning],
      starting: snapshot({ observed_at: '2026-08-23T20:26:25.000Z', total_value: 5000 }),
      exposures: [exposure('DG', 14, 132.25, '2026-08-27T13:22:09.000Z')],
    });
    expect(book.current_nav).toBeCloseTo(5134.57473627);
    expect(book.deployed).toBeCloseTo(4986.07473627);
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
        last_price: null,
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

  test('uses last_price on the lot when the optional marks map is absent', () => {
    const latest = snapshot({
      observed_at: '2026-08-27T16:37:52.267794Z',
      total_value: 5046.93965125,
      cash: 148.5,
      equity_value: 4898.43965125,
      buying_power: 148.5,
    });
    const at = '2026-08-27T16:37:52.267794Z';
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [latest],
      starting: snapshot({ observed_at: '2026-08-23T20:26:25.000Z', total_value: 5000 }),
      exposures: [
        exposure('CIFR', 63.211524, 15.82, at, 16.615),
        exposure('DG', 14, 132.25, at, null),
      ],
    });
    const cifr = book.names.find((row) => row.symbol === 'CIFR');
    const dg = book.names.find((row) => row.symbol === 'DG');
    expect(cifr?.mark).toBeCloseTo(16.615);
    expect(cifr?.pnl).toBeCloseTo((16.615 - 15.82) * 63.211524);
    expect(cifr?.note).toBe('');
    expect(dg?.mark).toBeNull();
    expect(dg?.pnl).toBeNull();
    expect(dg?.note).toBe(MARK_NOT_IN_LEDGER);
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

describe('book lot tiles', () => {
  test('sizes lots from ledger mass and keeps cash as leftover, never invented P/L tone', () => {
    const latest = snapshot({
      observed_at: '2026-08-27T13:22:00.000Z',
      total_value: 5134.57473627,
      cash: 148.5,
      equity_value: 4986.07473627,
      buying_power: 148.5,
    });
    const unmarked = assembleBookPerformance({
      snapshotsNewestFirst: [latest],
      starting: latest,
      exposures: [
        exposure('IREN', 25.208855, 39.67),
        exposure('NBIS', 4.653004, 214.91),
        exposure('CIFR', 63.211524, 15.82),
        exposure('DG', 14, 132.25),
      ],
    });
    const slabs = bookSlabs(unmarked);
    const lots = slabs.filter((row) => row.kind === 'lot');
    const cash = slabs.find((row) => row.kind === 'cash');
    expect(lots.map((row) => row.symbol)).toEqual(['CIFR', 'DG', 'IREN', 'NBIS']);
    expect(lots.every((row) => row.muted && row.pnl === null && row.notional === null)).toBe(true);
    expect(lots.every((row) => slabTone(row) === 'neutral')).toBe(true);
    expect(lots.every((row) => row.note === MARK_NOT_IN_LEDGER)).toBe(true);
    expect(lots.every((row) => row.mass > 0)).toBe(true);
    expect(cash?.symbol).toBe('CASH');
    expect(cash?.kind).toBe('cash');
    expect(cash?.notional).toBeCloseTo(148.5);
    expect(slabTone(cash!)).toBe('cash');

    const marked = assembleBookPerformance({
      snapshotsNewestFirst: [latest],
      starting: latest,
      exposures: [exposure('DG', 14, 132.25)],
      marks: new Map([['DG', 140]]),
    });
    const dg = bookSlabs(marked).find((row) => row.id === 'DG');
    expect(dg?.muted).toBe(false);
    expect(dg?.notional).toBeCloseTo(14 * 140);
    expect(dg?.pnl).toBeCloseTo((140 - 132.25) * 14);
    expect(slabTone(dg!)).toBe('up');

    const fromLedgerMark = assembleBookPerformance({
      snapshotsNewestFirst: [latest],
      starting: latest,
      exposures: [exposure('CIFR', 63.211524, 15.82, latest.observed_at, 16.615)],
    });
    const cifr = bookSlabs(fromLedgerMark).find((row) => row.id === 'CIFR');
    expect(cifr?.muted).toBe(false);
    expect(cifr?.mark).toBeCloseTo(16.615);
    expect(cifr?.notional).toBeCloseTo(63.211524 * 16.615);
    expect(cifr?.pnl).toBeCloseTo((16.615 - 15.82) * 63.211524);
    expect(slabTone(cifr!)).toBe('up');
  });

  test('cash missing from the ledger is leftover mass labeled not in ledger', () => {
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [],
      starting: null,
      exposures: [exposure('DG', 14, 132.25)],
    });
    const cash = bookSlabs(book).find((row) => row.kind === 'cash');
    expect(cash?.notional).toBeNull();
    expect(cash?.muted).toBe(true);
    expect(cash?.note).toBe(NOT_IN_LEDGER);
    expect(slabTone(cash!)).toBe('cash');
  });
});

describe('Agentic NAV path series', () => {
  test('keeps sparse Agentic snapshots, windows, and never uses a personal book', () => {
    const starting = snapshot({
      observed_at: '2026-08-23T20:26:25.000Z',
      total_value: 5000,
    });
    const prior = snapshot({
      observed_at: '2026-08-26T20:03:24.218Z',
      total_value: 5002.99,
    });
    const latest = snapshot({
      observed_at: '2026-08-27T13:22:00.000Z',
      total_value: 5134.57473627,
    });
    const personal = snapshot({
      account_label: 'robinhood_7254',
      observed_at: '2026-08-27T14:00:00.000Z',
      total_value: 480261.61,
    });
    const newestFirst = [personal, latest, prior, starting];
    const all = navPathSeries({
      snapshotsNewestFirst: newestFirst,
      window: 'all',
      latestObservedAt: latest.observed_at,
    });
    expect(all.map((row) => row.value)).toEqual([5000, 5002.99, 5134.57473627]);
    expect(all[0]?.time).toBe(Date.parse(starting.observed_at));
    const session = navPathSeries({
      snapshotsNewestFirst: newestFirst,
      window: 'session',
      latestObservedAt: latest.observed_at,
    });
    expect(session.map((row) => row.value)).toEqual([5134.57473627]);
    const day = navPathSeries({
      snapshotsNewestFirst: newestFirst,
      window: '1d',
      latestObservedAt: latest.observed_at,
    });
    expect(day.map((row) => row.value)).toEqual([5002.99, 5134.57473627]);
  });

  test('allocation pct is null when NAV is missing — never invented', () => {
    const book = assembleBookPerformance({
      snapshotsNewestFirst: [],
      starting: null,
      exposures: [exposure('DG', 14, 132.25)],
    });
    const slices = allocationSlices(bookSlabs(book), book.current_nav);
    expect(book.current_nav).toBeNull();
    expect(slices.every((row) => row.pct === null)).toBe(true);
  });
});

describe('next dated catalyst on held names', () => {
  test('picks the soonest dated event on an open lot and ignores AI-only filtering', () => {
    const names = [{ symbol: 'IREN' }, { symbol: 'DG' }] as const;
    const rows: CatalystRow[] = [
      {
        id: 1,
        thesis_id: 'software_ai_apps',
        symbol: 'NVDA',
        catalyst_type: 'earnings',
        event_date: '2026-08-28',
        summary: 'NVDA print',
        source: 'test',
        status: 'upcoming',
        created_at: '2026-08-20T00:00:00.000Z',
      },
      {
        id: 2,
        thesis_id: 'neocloud_compute',
        symbol: 'IREN',
        catalyst_type: 'earnings',
        event_date: '2026-09-02',
        summary: 'IREN print',
        source: 'test',
        status: 'upcoming',
        created_at: '2026-08-20T00:00:00.000Z',
      },
      {
        id: 3,
        thesis_id: 'retail',
        symbol: 'DG',
        catalyst_type: 'earnings',
        event_date: '2026-08-29',
        summary: 'DG print',
        source: 'test',
        status: 'upcoming',
        created_at: '2026-08-20T00:00:00.000Z',
      },
      {
        id: 4,
        thesis_id: 'neocloud_compute',
        symbol: 'IREN',
        catalyst_type: 'earnings',
        event_date: '2026-08-20',
        summary: 'already printed',
        source: 'test',
        status: 'upcoming',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ];
    const next = nextHeldCatalyst(rows, [...names].map((row) => ({
      symbol: row.symbol,
      quantity: 1,
      average_cost: 1,
      cost: 1,
      mark: null,
      pnl: null,
      note: MARK_NOT_IN_LEDGER,
    })), '2026-08-27T13:22:00.000Z');
    expect(next?.symbol).toBe('DG');
    expect(next?.event_date).toBe('2026-08-29');
  });
});

