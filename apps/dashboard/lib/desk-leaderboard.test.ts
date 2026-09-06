import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  assembleLeaderboard,
  daysLive,
  hasDeskLevelBook,
  LEADERBOARD_RULES,
  LEADERBOARD_SUBTITLE,
  maxDrawdownPct,
  NOT_RANKED,
  percentReturn,
} from './desk-leaderboard';
import { fallbackTeam } from './desk-team';
import type { BookNameLine, DeskPayload } from './ledger-types';
import { BANDIT_BANKROLL_SOL_START, BANDIT_PRIMARY_ACCOUNT } from './meme-book';
import { predictionStartEquity } from './prediction-book';

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

function liveDesk(partial: Record<string, unknown> = {}): DeskPayload {
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
      names: [equityLine('CIFR'), equityLine('NBIS')],
    },
    prediction_markets: {
      desk: 'ODDSBORNE',
      venue: 'prediction',
      markets: [],
      positions: [{
        id: 'p1',
        market_id: 'm1',
        account_key: 'polymarket-us-primary',
        thesis_id: null,
        outcome: 'yes',
        status: 'open',
        quantity: 128.41,
        average_cost: 0.51,
        mark: 0.51,
        mark_at: null,
        thesis_text: null,
      }],
      orders: [],
      fills: [],
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
          notes: 'Seeded by GRASSHOPPER from Polymarket US balance verify',
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
          notes: 'Post partial fill hike25',
        },
      ],
      notes: [],
    },
    meme_coins: {
      desk: 'BANDIT',
      venue: 'meme',
      tokens: [],
      positions: [{
        id: 'pos-zdog',
        token_id: 'tok-zdog',
        account_key: BANDIT_PRIMARY_ACCOUNT,
        thesis_id: null,
        status: 'open',
        quantity: 3825,
        average_cost_sol: 0.00001,
        mark_sol: 0.000016,
        mark_at: null,
        thesis_text: null,
      }],
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
          notes: 'initial venue balance snapshot',
        },
        {
          id: 'dip',
          account_key: BANDIT_PRIMARY_ACCOUNT,
          as_of: '2026-09-06T15:00:22.473Z',
          realized: 0,
          unrealized: -0.001,
          fees: 0,
          cash_sol: 1.918,
          equity_sol: 1.99665814,
          notes: 'mark ZDOG hold',
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
          notes: 'ZDOG mark watch',
        },
      ],
      notes: [],
    },
    team: fallbackTeam(),
    ...partial,
  } as unknown as DeskPayload;
}

describe('percent return and drawdown', () => {
  test('return is vs own start; missing or zero start is not 0%', () => {
    expect(percentReturn(5000, 6020.0632)).toBeCloseTo(20.401264);
    expect(percentReturn(426, 424.07)).toBeCloseTo(((424.07 - 426) / 426) * 100);
    expect(percentReturn(2, 2.0355978427111925)).toBeCloseTo(1.779892135559625);
    expect(percentReturn(null, 100)).toBeNull();
    expect(percentReturn(0, 100)).toBeNull();
    expect(percentReturn(100, null)).toBeNull();
  });

  test('max drawdown needs two marks and never invents a series', () => {
    expect(maxDrawdownPct([5000, 4727.5896, 6020.0632])).toBeCloseTo(((5000 - 4727.5896) / 5000) * 100);
    expect(maxDrawdownPct([2, 1.99665814, 2.0355978427111925])).toBeCloseTo(((2 - 1.99665814) / 2) * 100);
    expect(maxDrawdownPct([426])).toBeNull();
    expect(maxDrawdownPct([])).toBeNull();
    expect(maxDrawdownPct([100, 110, 120])).toBe(0);
    expect(daysLive('2026-08-23T20:26:25.000Z', '2026-09-04T20:06:00.000Z')).toBe(11);
    expect(daysLive(null, '2026-09-04T20:06:00.000Z')).toBeNull();
  });
});

describe('prediction and meme start baselines', () => {
  test('prediction start is oldest pnl equity/cash — not a hardcoded 0', () => {
    const desk = liveDesk();
    const start = predictionStartEquity(desk.prediction_markets!);
    expect(start?.equity).toBe(426);
    expect(start?.source).toBe('pnl_equity');
    expect(predictionStartEquity({
      desk: 'ODDSBORNE',
      venue: 'prediction',
      markets: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [],
      notes: [],
    })).toBeNull();
  });
});

describe('desk leaderboard', () => {
  test('ranks three stewards on native % return and keeps SOL unconverted', () => {
    const board = assembleLeaderboard(liveDesk());
    expect(board.subtitle).toBe(LEADERBOARD_SUBTITLE);
    expect(board.rules).toMatch(/not converted/);
    expect(board.rules).toMatch(NOT_RANKED);
    expect(hasDeskLevelBook(liveDesk())).toBe(false);
    expect(board.rows.map((row) => row.id)).toEqual(['quantanamo', 'bandit', 'oddsborne']);
    expect(board.rows.map((row) => row.place)).toEqual([1, 2, 3]);
    expect(board.rows.every((row) => row.id !== 'grasshopper')).toBe(true);

    const stocks = board.rows[0];
    expect(stocks?.steward).toBe('QUANTANAMO');
    expect(stocks?.venue_label).toBe('STOCKS');
    expect(stocks?.unit).toBe('USD');
    expect(stocks?.return_pct).toBeCloseTo(20.401264);
    expect(stocks?.start).toBe(5000);
    expect(stocks?.now).toBeCloseTo(6020.0632);
    expect(stocks?.max_drawdown_pct).toBeCloseTo(5.448208);
    expect(stocks?.risk_note).toMatch(/max DD/);
    expect(stocks?.last_marked).toBe('2026-09-04T20:06:00.000Z');

    const coins = board.rows[1];
    expect(coins?.steward).toBe('BANDIT');
    expect(coins?.venue_label).toBe('COINS');
    expect(coins?.unit).toBe('SOL');
    expect(coins?.start).toBe(BANDIT_BANKROLL_SOL_START);
    expect(coins?.now).toBeCloseTo(2.0355978427111925);
    expect(coins?.return_pct).toBeCloseTo(1.779892135559625);
    expect(coins?.return_pct).not.toBeCloseTo((2.0355978427111925 - 2) * 1);
    expect(coins?.risk_note).toMatch(/max DD|live|open/);

    const predictions = board.rows[2];
    expect(predictions?.steward).toBe('ODDSBORNE');
    expect(predictions?.venue_label).toBe('PREDICTIONS');
    expect(predictions?.return_pct).toBeCloseTo(((424.07 - 426) / 426) * 100);
    expect(predictions?.start).toBe(426);
    expect(predictions?.now).toBeCloseTo(424.07);
  });

  test('missing start is not ranked — never 0%', () => {
    const desk = liveDesk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [],
        positions: [],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
      meme_coins: {
        desk: 'BANDIT',
        venue: 'meme',
        tokens: [],
        positions: [],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
    });
    const board = assembleLeaderboard(desk);
    expect(board.rows).toHaveLength(3);
    const predictions = board.rows.find((row) => row.id === 'oddsborne');
    const coins = board.rows.find((row) => row.id === 'bandit');
    expect(predictions?.ranked).toBe(false);
    expect(predictions?.place).toBeNull();
    expect(predictions?.return_pct).toBeNull();
    expect(predictions?.rank_note).toBe(NOT_RANKED);
    expect(predictions?.start).toBeNull();
    expect(predictions?.now).toBeNull();
    expect(coins?.ranked).toBe(false);
    expect(coins?.return_pct).toBeNull();
    expect(coins?.rank_note).toBe(NOT_RANKED);
    expect(board.rows[0]?.id).toBe('quantanamo');
    expect(board.rows[0]?.place).toBe(1);
  });

  test('ties break to lower drawdown, then older book', () => {
    const desk = liveDesk({
      book: {
        starting_nav: 100,
        current_nav: 110,
        observed_at: '2026-09-04T20:06:00.000Z',
        names: [equityLine('CIFR')],
      },
      snapshots: [
        {
          observed_at: '2026-08-01T00:00:00.000Z',
          account_label: 'Agentic',
          total_value: 100,
          equity_value: 100,
          cash: 0,
          buying_power: 0,
          source: 'robinhood_mcp',
        },
        {
          observed_at: '2026-08-02T00:00:00.000Z',
          account_label: 'Agentic',
          total_value: 90,
          equity_value: 90,
          cash: 0,
          buying_power: 0,
          source: 'robinhood_mcp',
        },
        {
          observed_at: '2026-09-04T20:06:00.000Z',
          account_label: 'Agentic',
          total_value: 110,
          equity_value: 110,
          cash: 0,
          buying_power: 0,
          source: 'robinhood_mcp',
        },
      ],
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [],
        positions: [],
        orders: [],
        fills: [],
        pnl: [
          {
            id: 'a',
            account_key: 'polymarket-us-primary',
            as_of: '2026-09-01T00:00:00.000Z',
            realized: 0,
            unrealized: 0,
            fees: 0,
            cash: 100,
            equity: 100,
            notes: 'seed',
          },
          {
            id: 'b',
            account_key: 'polymarket-us-primary',
            as_of: '2026-09-02T00:00:00.000Z',
            realized: 0,
            unrealized: 0,
            fees: 0,
            cash: 95,
            equity: 95,
            notes: 'dip',
          },
          {
            id: 'c',
            account_key: 'polymarket-us-primary',
            as_of: '2026-09-06T00:00:00.000Z',
            realized: 0,
            unrealized: 0,
            fees: 0,
            cash: 110,
            equity: 110,
            notes: 'now',
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
            id: 's',
            account_key: BANDIT_PRIMARY_ACCOUNT,
            as_of: '2026-07-01T00:00:00.000Z',
            realized: 0,
            unrealized: 0,
            fees: 0,
            cash_sol: 2,
            equity_sol: 2,
            notes: 'start',
          },
          {
            id: 'n',
            account_key: BANDIT_PRIMARY_ACCOUNT,
            as_of: '2026-09-06T00:00:00.000Z',
            realized: 0,
            unrealized: 0,
            fees: 0,
            cash_sol: 2.2,
            equity_sol: 2.2,
            notes: 'now',
          },
        ],
        notes: [],
      },
    });
    const board = assembleLeaderboard(desk);
    const stocks = board.rows.find((row) => row.id === 'quantanamo');
    const predictions = board.rows.find((row) => row.id === 'oddsborne');
    const coins = board.rows.find((row) => row.id === 'bandit');
    expect(stocks?.return_pct).toBeCloseTo(10);
    expect(predictions?.return_pct).toBeCloseTo(10);
    expect(coins?.return_pct).toBeCloseTo(10);
    expect(predictions?.max_drawdown_pct).toBeCloseTo(5);
    expect(stocks?.max_drawdown_pct).toBeCloseTo(10);
    expect(board.rows.map((row) => row.id)).toEqual(['bandit', 'oddsborne', 'quantanamo']);
    expect(LEADERBOARD_RULES).toMatch(/Ties go to lower drawdown/);
  });
});
