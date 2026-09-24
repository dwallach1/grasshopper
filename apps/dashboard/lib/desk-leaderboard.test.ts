import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  assembleLeaderboard,
  daysLive,
  freshLead,
  hasDeskLevelBook,
  LEADERBOARD_RULES,
  LEADERBOARD_SUBTITLE,
  maxDrawdownPct,
  NOT_RANKED,
  percentReturn,
} from './desk-leaderboard';
import { fallbackTeam } from './desk-team';
import type { BookNameLine, DeskPayload } from './ledger-types';
import { BANDIT_BANKROLL_SOL_START, BANDIT_PRIMARY_ACCOUNT, memeEquitySeries } from './meme-book';
import { attachPnlStart } from './pnl-inception';
import { predictionEquitySeries, predictionStartEquity } from './prediction-book';

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
    expect(stocks?.days_live).toBe(11);
    expect(stocks?.start_as_of).toBe('2026-08-23T20:26:25.000Z');
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

  test('truncated recent pnl still scores vs the ledger start, and the tail stays the chart', () => {
    const memeStart = {
      id: '21e58b26-aee3-47ed-a0f0-ad1b4654f556',
      account_key: BANDIT_PRIMARY_ACCOUNT,
      as_of: '2026-09-06T14:23:40.405Z',
      realized: 0,
      unrealized: 0,
      fees: 0,
      cash_sol: 2,
      equity_sol: 2,
      notes: 'initial venue balance snapshot',
    };
    const memeNow = 1.908307649;
    const memeTail = Array.from({ length: 28 }, (_, index) => ({
      id: `meme-tail-${index}`,
      account_key: BANDIT_PRIMARY_ACCOUNT,
      as_of: `2026-09-24T15:${String(index).padStart(2, '0')}:00.000Z`,
      realized: 0,
      unrealized: 0,
      fees: 0,
      cash_sol: 1.48,
      equity_sol: index === 0 ? 1.636609733 : index === 27 ? memeNow : 1.7,
      notes: null,
    }));
    const memeWindow = attachPnlStart(memeTail, memeStart, 28);
    expect(memeWindow.pnl_start?.id).toBe(memeStart.id);
    expect(memeWindow.pnl).toHaveLength(28);

    const pmStart = {
      id: '0d0cfe10-17b2-46b4-94f7-0e8ed1493e76',
      account_key: 'polymarket-us-primary',
      as_of: '2026-09-06T13:10:47.142Z',
      realized: 0,
      unrealized: 0,
      fees: 0,
      cash: 426,
      equity: 426,
      notes: 'Seeded by GRASSHOPPER from Polymarket US balance verify',
    };
    const pmNow = 276.87;
    const pmWindowEdge = 491.53;
    const pmTail = Array.from({ length: 28 }, (_, index) => ({
      id: `pm-tail-${index}`,
      account_key: 'polymarket-us-primary',
      as_of: index === 0
        ? '2026-09-18T21:07:57.079Z'
        : `2026-09-24T16:${String(index).padStart(2, '0')}:21.045Z`,
      realized: 0,
      unrealized: 0,
      fees: 0,
      cash: index === 27 ? pmNow : pmWindowEdge,
      equity: index === 0 ? pmWindowEdge : index === 27 ? pmNow : 400,
      notes: null,
    }));
    const pmWindow = attachPnlStart(pmTail, pmStart, 28);

    const trapped = assembleLeaderboard(liveDesk({
      meme_coins: {
        ...liveDesk().meme_coins,
        pnl: memeWindow.pnl,
        pnl_start: null,
      },
      prediction_markets: {
        ...liveDesk().prediction_markets,
        pnl: pmWindow.pnl,
        pnl_start: null,
      },
    }));
    const trappedCoins = trapped.rows.find((row) => row.id === 'bandit');
    const trappedPredictions = trapped.rows.find((row) => row.id === 'oddsborne');
    expect(trappedCoins?.start).toBe(1.636609733);
    expect(trappedCoins?.days_live).toBe(0);
    expect(trappedCoins?.return_pct).toBeCloseTo(((memeNow - 1.636609733) / 1.636609733) * 100);
    expect(trappedPredictions?.start).toBe(pmWindowEdge);
    expect(trappedPredictions?.days_live).toBe(5);
    expect(trappedPredictions?.return_pct).toBeCloseTo(((pmNow - pmWindowEdge) / pmWindowEdge) * 100);

    const desk = liveDesk({
      meme_coins: {
        ...liveDesk().meme_coins,
        pnl: memeWindow.pnl,
        pnl_start: memeWindow.pnl_start,
      },
      prediction_markets: {
        ...liveDesk().prediction_markets,
        pnl: pmWindow.pnl,
        pnl_start: pmWindow.pnl_start,
      },
    });
    const board = assembleLeaderboard(desk);
    const coins = board.rows.find((row) => row.id === 'bandit');
    const predictions = board.rows.find((row) => row.id === 'oddsborne');
    expect(coins?.ranked).toBe(true);
    expect(coins?.start).toBe(2);
    expect(coins?.now).toBeCloseTo(memeNow);
    expect(coins?.return_pct).toBeCloseTo(((memeNow - 2) / 2) * 100);
    expect(coins?.days_live).toBe(18);
    expect(coins?.start_as_of).toBe('2026-09-06T14:23:40.405Z');
    expect(predictions?.ranked).toBe(true);
    expect(predictions?.start).toBe(426);
    expect(predictions?.now).toBeCloseTo(pmNow);
    expect(predictions?.return_pct).toBeCloseTo(((pmNow - 426) / 426) * 100);
    expect(predictions?.days_live).toBe(18);
    expect(predictions?.start_as_of).toBe('2026-09-06T13:10:47.142Z');
    expect(memeEquitySeries(desk.meme_coins!).some((point) => point.as_of.startsWith('2026-09-06'))).toBe(false);
    expect(memeEquitySeries(desk.meme_coins!)).toHaveLength(28);
    expect(predictionEquitySeries(desk.prediction_markets!).some((point) => point.as_of.startsWith('2026-09-06'))).toBe(false);
    expect(predictionEquitySeries(desk.prediction_markets!)).toHaveLength(28);
    expect(board.rows.find((row) => row.id === 'quantanamo')?.return_pct).toBeCloseTo(20.401264);
  });

  test('freshLead skips a stale first-place book', () => {
    const board = assembleLeaderboard(liveDesk());
    const now = Date.parse('2026-09-06T15:58:03.496Z');
    expect(freshLead(board.rows, now)?.id).toBe('bandit');
    expect(freshLead(board.rows, Date.parse('2026-09-07T12:00:00.000Z'))).toBeNull();
  });
});
