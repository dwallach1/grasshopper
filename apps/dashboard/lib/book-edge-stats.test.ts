import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  asciiFillBar,
  asciiRangeBar,
  assembleBookEdge,
  classifyPnl,
  distStat,
  formatHold,
  sampleStd,
  winRate,
} from './book-edge-stats';
import { fallbackTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';
import { BANDIT_PRIMARY_ACCOUNT } from './meme-book';

function desk(partial: Record<string, unknown> = {}): DeskPayload {
  return {
    generated_at: '2026-09-07T23:10:00.000Z',
    snapshots: [],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: '2026-09-04T20:06:00.000Z',
      last4: '7638',
      buying_power: null,
      starting_nav: 5000,
      current_nav: 6020,
      cash: null,
      deployed: null,
      vs_start: 1020,
      vs_start_note: MARK_NOT_IN_LEDGER,
      day_pnl: null,
      day_pnl_note: MARK_NOT_IN_LEDGER,
      vs_cost: null,
      vs_cost_note: MARK_NOT_IN_LEDGER,
      names: [],
    },
    positions: [],
    fills: [],
    intents: [],
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
    team: fallbackTeam(),
    ...partial,
  } as unknown as DeskPayload;
}

describe('edge math', () => {
  test('sample std needs two values and does not invent a spread', () => {
    expect(sampleStd([1000])).toBeNull();
    expect(sampleStd([])).toBeNull();
    expect(sampleStd([1000, 1796.472, 1094.3491])).toBeCloseTo(435.17, 1);
    expect(distStat([1000])?.std).toBeNull();
    expect(distStat([1000, 2000])?.avg).toBe(1500);
    expect(winRate(1, 2)).toBeCloseTo(100 / 3);
    expect(winRate(0, 0)).toBeNull();
    expect(classifyPnl(745.146)).toBe('win');
    expect(classifyPnl(-50.377)).toBe('loss');
    expect(classifyPnl(0)).toBe('flat');
    expect(classifyPnl(null)).toBe('unknown');
  });

  test('hold and ASCII bars stay honest on missing values', () => {
    expect(formatHold(null)).toBe('not in ledger');
    expect(formatHold(1_800_000)).toBe('30m');
    expect(formatHold(1.75 * 86_400_000)).toBe('1d 18h');
    expect(asciiFillBar(null)).toBe('░░░░░░░░░░░░░░░░');
    expect(asciiFillBar(50, 8)).toBe('████░░░░');
    expect(asciiRangeBar(1000, 1000, 1000, 8)).toBe('·──────·');
    expect(asciiRangeBar(1000, 1500, 2000, 6)).toBe('·──*─·');
  });
});

describe('assembleBookEdge', () => {
  test('empty books stay thin and never invent a win rate', () => {
    const edge = assembleBookEdge(desk());
    expect(edge.rows.map((row) => row.id)).toEqual(['quantanamo', 'oddsborne', 'bandit']);
    for (const row of edge.rows) {
      expect(row.closed).toBe(0);
      expect(row.win_rate).toBeNull();
      expect(row.size).toBeNull();
      expect(row.hold).toBeNull();
      expect(row.thin).toBe(true);
      expect(row.note).toBe('no closed lots in ledger');
    }
  });

  test('QUANTANAMO uses a closed episode plus fills; open lots stay out', () => {
    const edge = assembleBookEdge(desk({
      positions: [
        {
          id: 'ep-iren',
          account_key: 'robinhood-agentic-7638',
          symbol: 'IREN',
          status: 'closed',
          quantity: 0,
          average_cost: 39.6686,
          opened_at: '2026-08-26T19:01:06.000Z',
          closed_at: '2026-08-28T13:46:18.317Z',
          next_review_at: null,
        },
        {
          id: 'ep-dg',
          account_key: 'robinhood-agentic-7638',
          symbol: 'DG',
          status: 'open',
          quantity: 14,
          average_cost: 132.25,
          opened_at: '2026-08-27T13:21:36.632Z',
          closed_at: null,
          next_review_at: null,
        },
      ],
      fills: [
        {
          id: 'fill-iren-1',
          trade_intent_id: 'intent-iren-sell',
          quantity: 25,
          price: 37.6702,
          executed_at: '2026-08-28T13:46:18.317Z',
        },
        {
          id: 'fill-iren-2',
          trade_intent_id: 'intent-iren-sell',
          quantity: 0.208855,
          price: 37.6702,
          executed_at: '2026-08-28T13:46:18.317Z',
        },
      ],
      intents: [
        {
          id: 'intent-iren-buy',
          account_key: 'robinhood-agentic-7638',
          symbol: 'IREN',
          side: 'buy',
          status: 'filled',
          mode: 'live',
          notional: 1000,
          quantity: 25.208855,
          order_type: 'market',
          broker_order_id: null,
          created_at: '2026-08-26T19:05:48.528Z',
          updated_at: '2026-08-26T19:05:48.528Z',
        },
        {
          id: 'intent-iren-sell',
          account_key: 'robinhood-agentic-7638',
          symbol: 'IREN',
          side: 'sell',
          status: 'filled',
          mode: 'live',
          notional: 949.6226,
          quantity: 25.208855,
          order_type: 'market',
          broker_order_id: null,
          created_at: '2026-08-28T13:46:18.197Z',
          updated_at: '2026-08-28T13:46:18.197Z',
        },
        {
          id: 'intent-dg-sell',
          account_key: 'robinhood-agentic-7638',
          symbol: 'DG',
          side: 'sell',
          status: 'filled',
          mode: 'live',
          notional: 1800,
          quantity: 14,
          order_type: 'market',
          broker_order_id: null,
          created_at: '2026-09-02T16:45:10.098Z',
          updated_at: '2026-09-02T16:45:10.098Z',
        },
      ],
    }));
    const stocks = edge.rows.find((row) => row.id === 'quantanamo');
    expect(stocks?.closed).toBe(1);
    expect(stocks?.wins).toBe(0);
    expect(stocks?.losses).toBe(1);
    expect(stocks?.win_rate).toBe(0);
    expect(stocks?.thin).toBe(true);
    expect(stocks?.unit).toBe('USD');
    expect(stocks?.size?.avg).toBeCloseTo(1000);
    expect(stocks?.lots[0]?.pnl).toBeCloseTo(949.6226 - 1000);
    expect(stocks?.hold?.n).toBe(1);
    expect(stocks?.lots.map((row) => row.symbol)).toEqual(['IREN']);
  });

  test('filled-intent round trips count when no open episode exists', () => {
    const edge = assembleBookEdge(desk({
      intents: [
        {
          id: 'aout-buy',
          account_key: 'robinhood-agentic-7638',
          symbol: 'AOUT',
          side: 'buy',
          status: 'filled',
          mode: 'live',
          notional: 1796.472,
          quantity: 180,
          order_type: 'market',
          broker_order_id: null,
          created_at: '2026-09-03T17:21:54.405Z',
          updated_at: '2026-09-03T17:21:54.405Z',
        },
        {
          id: 'aout-sell',
          account_key: 'robinhood-agentic-7638',
          symbol: 'AOUT',
          side: 'sell',
          status: 'filled',
          mode: 'live',
          notional: 2541.618,
          quantity: 180,
          order_type: 'market',
          broker_order_id: null,
          created_at: '2026-09-04T15:08:03.506Z',
          updated_at: '2026-09-04T15:08:03.506Z',
        },
      ],
    }));
    const stocks = edge.rows.find((row) => row.id === 'quantanamo');
    expect(stocks?.closed).toBe(1);
    expect(stocks?.wins).toBe(1);
    expect(stocks?.win_rate).toBe(100);
    expect(stocks?.lots[0]?.pnl).toBeCloseTo(2541.618 - 1796.472);
    expect(stocks?.unit).toBe('USD');
  });

  test('BANDIT closed coins stay SOL-native; ODDSBORNE with no closes is thin', () => {
    const tokenId = '26463a39-c5e5-4f0e-8dde-b968174bc63e';
    const posId = '8c41e023-ae36-4c7c-862d-053fa97df85b';
    const edge = assembleBookEdge(desk({
      meme_coins: {
        desk: 'BANDIT',
        venue: 'meme',
        tokens: [{
          id: tokenId,
          venue: 'pumpfun',
          mint: 'mint-zdog',
          symbol: 'ZDOG',
          name: 'Anonymous Dog',
          status: 'closed',
          bonding_curve_status: null,
          graduated_at: null,
          last_price_sol: null,
          last_mcap_sol: null,
          last_marked_at: null,
          thesis_id: null,
          kill_criteria: null,
        }],
        positions: [{
          id: posId,
          token_id: tokenId,
          account_key: BANDIT_PRIMARY_ACCOUNT,
          thesis_id: null,
          status: 'closed',
          quantity: 0,
          average_cost_sol: 0.0000104549837995156,
          mark_sol: 0.00001307384615708968,
          mark_at: '2026-09-06T19:22:53.055Z',
          opened_at: '2026-09-06T14:56:14.314Z',
          closed_at: '2026-09-06T19:22:52.688Z',
          thesis_text: null,
        }],
        orders: [{
          id: 'ord-zdog-buy',
          token_id: tokenId,
          account_key: BANDIT_PRIMARY_ACCOUNT,
          thesis_id: null,
          side: 'buy',
          order_type: 'market',
          size_sol: 0.08,
          size_tokens: 7651.853081179,
          price_sol: 0.0000104549837995156,
          status: 'filled',
          mode: 'live',
          venue_order_id: null,
          submitted_at: '2026-09-06T14:56:14.314Z',
          created_at: '2026-09-06T14:56:14.314Z',
        }, {
          id: 'ord-zdog-sell',
          token_id: tokenId,
          account_key: BANDIT_PRIMARY_ACCOUNT,
          thesis_id: null,
          side: 'sell',
          order_type: 'market',
          size_sol: 0.05,
          size_tokens: 7651.853081179,
          price_sol: 0.000014,
          status: 'filled',
          mode: 'live',
          venue_order_id: null,
          submitted_at: '2026-09-06T19:22:53.055Z',
          created_at: '2026-09-06T15:28:17.635Z',
        }],
        fills: [
          {
            id: 'f-zdog-buy',
            order_id: 'ord-zdog-buy',
            position_id: posId,
            account_key: BANDIT_PRIMARY_ACCOUNT,
            side: 'buy',
            quantity: 7651.853081179,
            price_sol: 0.0000104549837995156,
            fee_sol: 0,
            executed_at: '2026-09-06T14:56:14.314Z',
          },
          {
            id: 'f-zdog-sell-1',
            order_id: 'ord-zdog-sell',
            position_id: posId,
            account_key: BANDIT_PRIMARY_ACCOUNT,
            side: 'sell',
            quantity: 3825.926540589,
            price_sol: 0.00001526850512686708,
            fee_sol: 0,
            executed_at: '2026-09-06T15:28:17.635Z',
          },
          {
            id: 'f-zdog-sell-2',
            order_id: 'ord-zdog-sell',
            position_id: posId,
            account_key: BANDIT_PRIMARY_ACCOUNT,
            side: 'sell',
            quantity: 3825.92654059,
            price_sol: 0.00001307384615708968,
            fee_sol: 0,
            executed_at: '2026-09-06T19:22:53.055Z',
          },
        ],
        pnl: [],
        notes: [],
      },
    }));
    const coins = edge.rows.find((row) => row.id === 'bandit');
    const preds = edge.rows.find((row) => row.id === 'oddsborne');
    expect(coins?.unit).toBe('SOL');
    expect(coins?.closed).toBe(1);
    expect(coins?.thin).toBe(true);
    expect(coins?.size?.avg).toBeGreaterThan(0);
    expect(coins?.size?.avg).toBeLessThan(1);
    expect(coins?.lots[0]?.pnl).not.toBeNull();
    expect(preds?.closed).toBe(0);
    expect(preds?.note).toBe('no closed lots in ledger');
  });

  test('COINTANAMO is omitted unless the roster has that slug', () => {
    expect(assembleBookEdge(desk()).rows.some((row) => row.id === 'cointanamo')).toBe(false);
    const team = fallbackTeam();
    const extra = assembleBookEdge(desk({
      team: {
        ...team,
        agents: [
          ...team.agents,
          {
            id: 'agent-cointanamo',
            slug: 'cointanamo',
            display_name: 'COINTANAMO',
            role_title: 'Coin steward',
            charter: '',
            accent: '#94a3b8',
            avatar_key: 'spark',
            status: 'watching',
            heartbeat_at: null,
            sort_order: 5,
            meta: {},
          },
        ],
      },
    }));
    const coin = extra.rows.find((row) => row.id === 'cointanamo');
    expect(coin?.thin).toBe(true);
    expect(coin?.closed).toBe(0);
    expect(coin?.unit).toBe('SOL');
  });
});
