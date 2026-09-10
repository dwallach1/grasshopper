import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  assembleBookOpen,
  clobLastForOutcome,
  clipOpenLabel,
  formatOpenTicketLabel,
  publishedKillMid,
} from './book-open-strip';
import { isoToLivelineTime } from './desk-liveline';
import { fallbackTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';
import { BANDIT_PRIMARY_ACCOUNT } from './meme-book';

function desk(partial: Record<string, unknown> = {}): DeskPayload {
  return {
    generated_at: '2026-09-08T16:10:00.000Z',
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
    exposures: [],
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

describe('open ticket labels', () => {
  test('clip and side/size fit a 390px phone row', () => {
    const long = formatOpenTicketLabel(
      'fed-decreases-interest-rates-by-25-bps-after-september-2026-meeting',
      'yes',
      25,
    );
    expect(long.side).toBe('YES');
    expect(long.market.length).toBeLessThanOrEqual(22);
    expect(long.label.startsWith('YES · ')).toBe(true);
    expect(long.meta).toBe('25');
    expect(clipOpenLabel('short')).toBe('short');
    expect(clipOpenLabel('')).toBe('market');
  });

  test('kill mid is only a published number — never parsed prose', () => {
    expect(publishedKillMid({ kill_mid: 0.31 })).toBe(0.31);
    expect(publishedKillMid({ killMid: '0.2' })).toBe(0.2);
    expect(publishedKillMid({ kill_criteria: 'dump below 0.00001' })).toBeNull();
    expect(publishedKillMid({ kill_mid: 'nope' })).toBeNull();
    expect(publishedKillMid({})).toBeNull();
  });

  test('CLOB last follows the held outcome and needs last_marked_at', () => {
    const market = {
      last_yes: 0.62,
      last_no: 0.38,
      last_marked_at: '2026-09-08T15:00:00.000Z',
    };
    expect(clobLastForOutcome(market, 'YES')).toEqual({
      as_of: market.last_marked_at,
      value: 0.62,
    });
    expect(clobLastForOutcome(market, 'no')).toEqual({
      as_of: market.last_marked_at,
      value: 0.38,
    });
    expect(clobLastForOutcome({ ...market, last_marked_at: null }, 'yes')).toBeNull();
    expect(clobLastForOutcome(market, 'up')).toBeNull();
  });
});

describe('assembleBookOpen', () => {
  test('omits a steward with no open series — does not fake a chart', () => {
    const open = assembleBookOpen(desk());
    expect(open.rows).toEqual([]);
  });

  test('predictions plot published marks + CLOB last; cost is the reference', () => {
    const markAt = '2026-09-08T15:40:00.000Z';
    const clobAt = '2026-09-08T14:10:00.000Z';
    const open = assembleBookOpen(desk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [{
          id: 'm1',
          venue: 'polymarket',
          slug: 'fed-decreases-interest-rates-by-25-bps-after-september-2026-meeting',
          question: 'Will the Fed cut 25bps in September?',
          status: 'open',
          close_time: '2026-09-17T00:00:00.000Z',
          last_yes: 0.58,
          last_no: 0.42,
          last_marked_at: clobAt,
          thesis_id: null,
          rules_summary: null,
        }],
        positions: [{
          id: 'p1',
          market_id: 'm1',
          account_key: 'oddsborne',
          thesis_id: null,
          outcome: 'yes',
          status: 'open',
          quantity: 25,
          average_cost: 0.41,
          mark: 0.61,
          mark_at: markAt,
          thesis_text: null,
          kill_mid: 0.22,
        }],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
    }));
    expect(open.rows.map((row) => row.id)).toEqual(['oddsborne']);
    const ticket = open.rows[0]?.tickets[0];
    expect(ticket?.side).toBe('YES');
    expect(ticket?.meta).toBe('25');
    expect(ticket?.cost).toBe(0.41);
    expect(ticket?.kill_mid).toBe(0.22);
    expect(ticket?.points).toEqual([
      { time: isoToLivelineTime(clobAt)!, value: 0.58 },
      { time: isoToLivelineTime(markAt)!, value: 0.61 },
    ]);
    expect(ticket?.source).toContain('pm_markets.last_yes');
    expect(ticket?.source).toContain('pm_positions.mark');
    expect(ticket?.source).toContain('pm_positions.average_cost');
    expect(ticket?.overlays).toHaveLength(1);
    expect(ticket?.overlays[0]?.value).toBe(0.22);
    expect(ticket?.overlays[0]?.data.every((point) => point.value === 0.22)).toBe(true);
    expect(ticket?.drawable).toBe(true);
    expect(ticket?.marked_at).toBe(markAt);
    expect(open.rows[0]?.marked_at).toBe(markAt);
    expect(open.as_of).toBe(markAt);
  });

  test('published fills join the mark clocks — never invented ticks', () => {
    const open = assembleBookOpen(desk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [{
          id: 'm1',
          venue: 'polymarket',
          slug: 'fed-sep-25bps',
          question: 'Fed Sep +25bps',
          status: 'open',
          close_time: null,
          last_yes: null,
          last_no: null,
          last_marked_at: null,
          thesis_id: null,
          rules_summary: null,
        }],
        positions: [{
          id: 'p1',
          market_id: 'm1',
          account_key: 'oddsborne',
          thesis_id: null,
          outcome: 'yes',
          status: 'open',
          quantity: 25,
          average_cost: 0.41,
          mark: 0.61,
          mark_at: '2026-09-08T15:40:00.000Z',
          thesis_text: null,
        }],
        orders: [{
          id: 'o1',
          market_id: 'm1',
          thesis_id: null,
          outcome: 'yes',
          side: 'buy',
          order_type: 'market',
          size: 25,
          price: 0.41,
          status: 'filled',
          mode: 'live',
          venue_order_id: null,
          submitted_at: '2026-09-08T13:20:00.000Z',
          created_at: '2026-09-08T13:20:00.000Z',
        }],
        fills: [{
          id: 'f1',
          order_id: 'o1',
          position_id: 'p1',
          outcome: 'yes',
          side: 'buy',
          quantity: 25,
          price: 0.41,
          executed_at: '2026-09-08T13:20:00.000Z',
        }],
        pnl: [],
        notes: [],
      },
    }));
    const ticket = open.rows[0]?.tickets[0];
    expect(ticket?.points.map((row) => row.value)).toEqual([0.41, 0.61]);
    expect(ticket?.source).toContain('pm_fills.price');
    expect(ticket?.drawable).toBe(true);
  });

  test('closed or unmarked prediction lots do not invent ticks', () => {
    const open = assembleBookOpen(desk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [{
          id: 'm1',
          venue: 'polymarket',
          slug: 'sample',
          question: 'SAMPLE',
          status: 'open',
          close_time: null,
          last_yes: 0.5,
          last_no: 0.5,
          last_marked_at: null,
          thesis_id: null,
          rules_summary: null,
        }],
        positions: [
          {
            id: 'closed',
            market_id: 'm1',
            account_key: 'oddsborne',
            thesis_id: null,
            outcome: 'yes',
            status: 'closed',
            quantity: 10,
            average_cost: 0.4,
            mark: 1,
            mark_at: '2026-09-08T12:00:00.000Z',
            thesis_text: null,
          },
          {
            id: 'bare',
            market_id: 'm1',
            account_key: 'oddsborne',
            thesis_id: null,
            outcome: 'yes',
            status: 'open',
            quantity: 10,
            average_cost: 0.4,
            mark: 0.55,
            mark_at: null,
            thesis_text: null,
          },
        ],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
    }));
    expect(open.rows).toEqual([]);
  });

  test('coins plot last_price_sol / mark_sol and omit empty BANDIT', () => {
    const marked = '2026-09-08T15:48:20.740Z';
    const open = assembleBookOpen(desk({
      meme_coins: {
        desk: 'BANDIT',
        venue: 'meme',
        tokens: [{
          id: 't1',
          venue: 'pumpfun',
          mint: 'So11111111111111111111111111111111111111112',
          symbol: 'ZDOG',
          name: 'ZDOG',
          status: 'open',
          bonding_curve_status: null,
          graduated_at: null,
          last_price_sol: 0.000016,
          last_mcap_sol: null,
          last_marked_at: marked,
          thesis_id: null,
          kill_criteria: 'fade if curve dies',
        }],
        positions: [{
          id: 'mp1',
          token_id: 't1',
          account_key: BANDIT_PRIMARY_ACCOUNT,
          thesis_id: null,
          status: 'open',
          quantity: 12000,
          average_cost_sol: 0.00001045,
          mark_sol: 0.000016,
          mark_at: marked,
          thesis_text: null,
        }],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
    }));
    expect(open.rows.map((row) => row.id)).toEqual(['bandit']);
    const ticket = open.rows[0]?.tickets[0];
    expect(ticket?.label).toBe('LONG · ZDOG');
    expect(ticket?.cost).toBeCloseTo(0.00001045);
    expect(ticket?.kill_mid).toBeNull();
    expect(ticket?.points).toEqual([
      { time: isoToLivelineTime(marked)!, value: 0.000016 },
    ]);
    expect(ticket?.source).toContain('meme_tokens.last_price_sol');
    expect(ticket?.source).toContain('meme_positions.mark_sol');
    expect(ticket?.overlays).toEqual([]);
    expect(ticket?.drawable).toBe(false);
  });

  test('equities need a multi-point mark series already in the snapshot', () => {
    const single = assembleBookOpen(desk({
      book: {
        ...desk().book,
        names: [{
          symbol: 'CIFR',
          quantity: 4,
          average_cost: 16,
          cost: 64,
          mark: 18,
          pnl: 8,
          note: '',
          venue: 'equity',
        }],
      },
      exposures: [{
        symbol: 'CIFR',
        quantity: 4,
        average_buy_price: 16,
        last_price: 18,
        observed_at: '2026-09-04T20:06:00.000Z',
        account_last4: '7638',
      }],
    }));
    expect(single.rows).toEqual([]);

    const series = assembleBookOpen(desk({
      book: {
        ...desk().book,
        names: [{
          symbol: 'CIFR',
          quantity: 4,
          average_cost: 16,
          cost: 64,
          mark: 18,
          pnl: 8,
          note: '',
          venue: 'equity',
        }],
      },
      exposures: [
        {
          symbol: 'CIFR',
          quantity: 4,
          average_buy_price: 16,
          last_price: 15.2,
          observed_at: '2026-09-03T20:00:00.000Z',
          account_last4: '7638',
        },
        {
          symbol: 'CIFR',
          quantity: 4,
          average_buy_price: 16,
          last_price: 18,
          observed_at: '2026-09-04T20:06:00.000Z',
          account_last4: '7638',
        },
      ],
    }));
    expect(series.rows.map((row) => row.id)).toEqual(['quantanamo']);
    const ticket = series.rows[0]?.tickets[0];
    expect(ticket?.label).toBe('BUY · CIFR');
    expect(ticket?.cost).toBe(16);
    expect(ticket?.points).toHaveLength(2);
    expect(ticket?.source).toContain('portfolio_exposure.last_price');
  });
});
