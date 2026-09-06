import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import { assembleDeskBookRollup, addLedger, USD_ROLLUP_NOTE } from './desk-book-rollup';
import type { BookNameLine, DeskPayload } from './ledger-types';

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

describe('desk book ALL rollup', () => {
  test('adds USD books and keeps SOL native — no FX', () => {
    const desk = {
      book: {
        current_nav: 6020.0632,
        cash: 3854.03,
        observed_at: '2026-09-04T20:06:00.000Z',
        names: [equityLine('CIFR'), equityLine('NBIS')],
      },
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [{
          id: 'm1',
          venue: 'polymarket',
          slug: 'hike25',
          question: 'SAMPLE hike',
          status: 'open',
          close_time: null,
          last_yes: 0.51,
          last_no: null,
          last_marked_at: null,
          thesis_id: null,
          rules_summary: null,
        }],
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
        pnl: [{
          id: 'pm-pnl',
          account_key: 'polymarket-us-primary',
          as_of: '2026-09-06T13:43:43.294Z',
          realized: 0,
          unrealized: -1.9299,
          fees: 1.93,
          cash: 358.5809,
          equity: 424.07,
          notes: 'Post partial fill hike25',
        }],
        notes: [],
      },
      meme_coins: {
        desk: 'BANDIT',
        venue: 'meme',
        tokens: [{
          id: 'tok-zdog',
          venue: 'pumpfun',
          mint: 'EbT2jpoe',
          symbol: 'ZDOG',
          name: 'Anonymous Dog',
          status: 'watch',
          bonding_curve_status: null,
          graduated_at: null,
          last_price_sol: null,
          last_mcap_sol: null,
          last_marked_at: null,
          thesis_id: null,
          kill_criteria: null,
        }],
        positions: [{
          id: 'pos-zdog',
          token_id: 'tok-zdog',
          account_key: 'solana-bandit-primary',
          thesis_id: null,
          status: 'open',
          quantity: 3825.92654059,
          average_cost_sol: 0.000010454983799515604,
          mark_sol: 0.000016462,
          mark_at: null,
          thesis_text: null,
        }],
        orders: [],
        fills: [],
        pnl: [{
          id: 'meme-pnl',
          account_key: 'solana-bandit-primary',
          as_of: '2026-09-06T15:48:20.740Z',
          realized: 0,
          unrealized: 0.02298240271118735,
          fees: 0,
          cash_sol: 1.97261544,
          equity_sol: 2.0355978427111925,
          notes: 'ZDOG mark watch',
        }],
        notes: [],
      },
    } as unknown as DeskPayload;

    const rollup = assembleDeskBookRollup(desk);
    expect(rollup.usd_nav).toBeCloseTo(6020.0632 + 424.07);
    expect(rollup.usd_cash).toBeCloseTo(3854.03 + 358.5809);
    expect(rollup.usd_legs_used).toEqual(['equity', 'prediction']);
    expect(rollup.sol_equity).toBeCloseTo(2.0355978427111925);
    expect(rollup.sol_cash).toBeCloseTo(1.97261544);
    expect(rollup.sol_equity).not.toBeCloseTo(rollup.usd_nav ?? 0);
    expect(rollup.open_lots).toBe(4);
    expect(rollup.lots_by_venue).toEqual({ equity: 2, prediction: 1, meme: 1 });
    expect(rollup.legs.map((leg) => `${leg.label}:${leg.unit}`)).toEqual([
      'STOCKS:USD',
      'PREDICTIONS:USD',
      'COINS:SOL',
    ]);
    expect(rollup.note).toBe(USD_ROLLUP_NOTE);
    expect(rollup.note).toMatch(/not converted/);
  });

  test('does not invent a missing USD or SOL leg as zero', () => {
    const desk = {
      book: {
        current_nav: 6020,
        cash: 3854,
        observed_at: null,
        names: [equityLine('CIFR')],
      },
      prediction_markets: { markets: [], positions: [], orders: [], fills: [], pnl: [], notes: [] },
      meme_coins: { tokens: [], positions: [], orders: [], fills: [], pnl: [], notes: [] },
    } as unknown as DeskPayload;
    const rollup = assembleDeskBookRollup(desk);
    expect(rollup.usd_nav).toBe(6020);
    expect(rollup.usd_cash).toBe(3854);
    expect(rollup.usd_legs_used).toEqual(['equity']);
    expect(rollup.sol_equity).toBeNull();
    expect(rollup.sol_cash).toBeNull();
    expect(rollup.legs.find((leg) => leg.venue === 'prediction')?.equity).toBeNull();
    expect(addLedger(null, null)).toBeNull();
    expect(addLedger(10, null, 5)).toBe(15);
  });
});
