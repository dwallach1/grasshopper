import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  assembleLiveline,
  clocksFromIso,
  DEGEN_ABS_PCT,
  formatLivelineValue,
  isoToLivelineTime,
  LIVELINE_EMPTY,
  livelineDegen,
  livelineWindows,
  percentClocks,
  seriesSpanSecs,
  stampFillsOnCurve,
} from './desk-liveline';
import { fallbackTeam } from './desk-team';
import type { BookNameLine, DeskPayload } from './ledger-types';
import { BANDIT_BANKROLL_SOL_START, BANDIT_PRIMARY_ACCOUNT } from './meme-book';

function equityLine(symbol: string): BookNameLine {
  return {
    symbol,
    quantity: 1,
    average_cost: null,
    cost: null,
    mark: null,
    pnl: null,
    note: MARK_NOT_IN_LEDGER,
    venue: 'equity',
  };
}

function liveDesk(): DeskPayload {
  return {
    generated_at: '2026-09-06T15:58:03.496Z',
    snapshots: [
      {
        observed_at: '2026-08-23T20:26:25.000Z',
        account_label: 'Agentic',
        total_value: 5000,
        equity_value: 0,
        cash: 5000,
        buying_power: 5000,
        source: 'robinhood_mcp',
      },
      {
        observed_at: '2026-08-27T19:04:35.271Z',
        account_label: 'Robinhood Agentic 7638',
        total_value: 4727.5896,
        equity_value: 4579,
        cash: 148.5,
        buying_power: 148.5,
        source: 'robinhood_mcp',
      },
      {
        observed_at: '2026-09-04T20:06:00.000Z',
        account_label: 'robinhood_agentic_7638',
        total_value: 6020.0632,
        equity_value: 2166.0332,
        cash: 3854.03,
        buying_power: 3854.03,
        source: 'robinhood_mcp',
      },
    ],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: '2026-09-04T20:06:00.000Z',
      last4: '7638',
      buying_power: 3854.03,
      starting_nav: 5000,
      current_nav: 6020.0632,
      cash: 3854.03,
      deployed: 2166.0332,
      vs_start: 1020.0632,
      vs_start_note: 'vs first Agentic snapshot 2026-08-23T20:26:25.000Z',
      day_pnl: 518.95,
      day_pnl_note: 'vs prior NY session',
      vs_cost: null,
      vs_cost_note: MARK_NOT_IN_LEDGER,
      names: [equityLine('CIFR')],
    },
    prediction_markets: {
      desk: 'ODDSBORNE',
      venue: 'prediction',
      markets: [],
      positions: [],
      orders: [],
      fills: [{
        id: 'pf1',
        order_id: 'o1',
        position_id: null,
        outcome: 'yes',
        side: 'buy',
        quantity: 10,
        price: 0.51,
        executed_at: '2026-09-06T13:20:00.000Z',
      }],
      pnl: [
        {
          id: 'seed',
          account_key: 'polymarket-us-primary',
          as_of: '2026-09-06T13:10:47.142Z',
          realized: 0,
          unrealized: 0,
          fees: 0,
          cash: 426,
          equity: 426,
          notes: 'seed',
        },
        {
          id: 'latest-pm',
          account_key: 'polymarket-us-primary',
          as_of: '2026-09-06T13:43:43.294Z',
          realized: 0,
          unrealized: -1.9299,
          fees: 1.93,
          cash: 358.5809,
          equity: 424.07,
          notes: 'mark',
        },
      ],
      notes: [],
    },
    meme_coins: {
      desk: 'BANDIT',
      venue: 'meme',
      tokens: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [
        {
          id: 'seed-sol',
          account_key: BANDIT_PRIMARY_ACCOUNT,
          as_of: '2026-09-06T14:23:40.405Z',
          realized: 0,
          unrealized: 0,
          fees: 0,
          cash_sol: 2,
          equity_sol: BANDIT_BANKROLL_SOL_START,
          notes: 'seed',
        },
        {
          id: 'latest-sol',
          account_key: BANDIT_PRIMARY_ACCOUNT,
          as_of: '2026-09-06T15:48:20.740Z',
          realized: 0,
          unrealized: 0.02298,
          fees: 0,
          cash_sol: 1.97261544,
          equity_sol: 2.0355978427111925,
          notes: 'mark',
        },
      ],
      notes: [],
    },
    fill_log: [
      {
        id: 'eq-fill',
        at: '2026-08-28T15:00:00.000Z',
        symbol: 'CIFR',
        side: 'buy',
        quantity: 1,
        price: 16,
        notional: 16,
        status: 'filled',
        source: 'broker_fill',
        note: '',
        venue: 'equity',
      },
    ],
    team: fallbackTeam(),
  } as unknown as DeskPayload;
}

describe('liveline clock coercion', () => {
  test('iso times become unix seconds and drop non-finite values', () => {
    const iso = '2026-08-23T20:26:25.000Z';
    expect(isoToLivelineTime(iso)).toBe(Date.parse(iso) / 1000);
    expect(isoToLivelineTime('not-a-time')).toBeNull();
    const clocks = clocksFromIso([
      { as_of: iso, value: 5000 },
      { as_of: iso, value: 5010 },
      { as_of: '2026-08-27T19:04:35.271Z', value: null },
      { as_of: 'bad', value: 1 },
    ]);
    expect(clocks).toEqual([{ time: Date.parse(iso) / 1000, value: 5010 }]);
  });

  test('percent series needs a positive start — never 0% from a missing book', () => {
    const points = [
      { time: 1, value: 100 },
      { time: 2, value: 110 },
    ];
    expect(percentClocks(points, 100)).toEqual([
      { time: 1, value: 0 },
      { time: 2, value: 10 },
    ]);
    expect(percentClocks(points, null)).toEqual([]);
    expect(percentClocks(points, 0)).toEqual([]);
  });

  test('fill stamps carry last ledger equity — never fill price', () => {
    const equity = [
      { time: 100, value: 5000 },
      { time: 300, value: 4800 },
    ];
    const stamped = stampFillsOnCurve(equity, [
      new Date(200_000).toISOString(),
      new Date(50_000).toISOString(),
    ]);
    expect(stamped).toEqual([
      { time: 100, value: 5000 },
      { time: 200, value: 5000 },
      { time: 300, value: 4800 },
    ]);
    expect(stamped.some((row) => row.value === 16)).toBe(false);
  });
});

describe('assembleLiveline', () => {
  test('feeds native equity and % from ledger series — no FX, no invented marks', () => {
    const line = assembleLiveline(liveDesk());
    const stocks = line.books.find((row) => row.id === 'quantanamo');
    const preds = line.books.find((row) => row.id === 'oddsborne');
    const coins = line.books.find((row) => row.id === 'bandit');
    expect(stocks?.unit).toBe('USD');
    expect(preds?.unit).toBe('USD');
    expect(coins?.unit).toBe('SOL');
    expect(stocks?.equity.map((row) => row.value)).toEqual([5000, 4727.5896, 4727.5896, 6020.0632]);
    expect(stocks?.cash.map((row) => row.value)).toEqual([5000, 148.5, 148.5, 3854.03]);
    expect(stocks?.return_pct).toBeCloseTo(20.401264);
    expect(coins?.now).toBeCloseTo(2.0355978427111925);
    expect(coins?.start).toBe(BANDIT_BANKROLL_SOL_START);
    expect(preds?.equity.map((row) => row.value)).toEqual([426, 426, 424.07]);
    expect(line.all_pct.map((row) => row.id)).toEqual(['quantanamo', 'oddsborne', 'bandit']);
    expect(line.all_pct.every((row) => row.data.every((point) => Number.isFinite(point.value)))).toBe(true);
    const personal = assembleLiveline({
      ...liveDesk(),
      snapshots: [
        {
          observed_at: '2026-09-04T20:06:00.000Z',
          account_label: 'robinhood_7254',
          total_value: 480261.61,
          equity_value: 1,
          cash: 1,
          buying_power: 1,
          source: 'robinhood_mcp',
        },
      ],
      book: { ...liveDesk().book, starting_nav: null, vs_start_note: MARK_NOT_IN_LEDGER },
    });
    expect(personal.books[0]?.equity).toEqual([]);
    expect(personal.books[0]?.empty_text).toContain(LIVELINE_EMPTY);
  });

  test('windows cover history-to-now; degen only on big native % swings', () => {
    const first = isoToLivelineTime('2026-08-23T20:26:25.000Z');
    const now = isoToLivelineTime('2026-09-06T15:58:03.496Z');
    expect(first).not.toBeNull();
    expect(now).not.toBeNull();
    const points = [{ time: first!, value: 5000 }, { time: now!, value: 6020 }];
    const span = seriesSpanSecs(points, now!);
    const windows = livelineWindows(points, now!);
    expect(windows[windows.length - 1]?.label).toBe('all');
    expect(windows[windows.length - 1]?.secs).toBe(span);
    expect(windows.some((row) => row.label === '1d')).toBe(true);
    expect(livelineDegen(20.4)).toBe(true);
    expect(livelineDegen(1.7)).toBe(false);
    expect(livelineDegen(null)).toBe(false);
    expect(DEGEN_ABS_PCT).toBe(8);
    expect(formatLivelineValue(20.401, 'PCT')).toBe('+20.40%');
    expect(formatLivelineValue(2.0356, 'SOL')).toContain('SOL');
    expect(formatLivelineValue(6020.06, 'USD')).toContain('$');
  });
});
