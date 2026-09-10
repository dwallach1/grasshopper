import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import { assembleDeskBookHealth } from './desk-book-health';
import type { DeskPayload } from './ledger-types';

const NOW = Date.parse('2026-09-10T01:10:00.000Z');

function desk(partial: Record<string, unknown> = {}): DeskPayload {
  return {
    generated_at: '2026-09-10T01:10:00.000Z',
    snapshots: [],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: '2026-09-09T20:52:00.000Z',
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
    ...partial,
  } as unknown as DeskPayload;
}

describe('assembleDeskBookHealth', () => {
  test('flags an open Predictions ticket left at a stale peak mid', () => {
    const health = assembleDeskBookHealth(desk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [{
          id: 'midway',
          venue: 'polymarket',
          slug: 'tc-temp-mdwhigh-2026-09-09-lt80f',
          question: 'Highest temperature in Chicago on September 9? — 79 or below',
          status: 'open',
          close_time: null,
          last_yes: 0.775,
          last_no: 0.225,
          last_marked_at: '2026-09-09T17:51:44.000Z',
          thesis_id: null,
          rules_summary: null,
        }],
        positions: [{
          id: 'midway-pos',
          market_id: 'midway',
          account_key: 'oddsborne',
          thesis_id: null,
          outcome: 'yes',
          status: 'open',
          quantity: 190,
          average_cost: 0.258,
          mark: 0.775,
          mark_at: '2026-09-09T17:51:44.000Z',
          thesis_text: null,
        }],
        orders: [],
        fills: [],
        pnl: [{
          id: 'pnl',
          account_key: 'oddsborne',
          as_of: '2026-09-09T17:51:44.000Z',
          realized: 0,
          unrealized: 98.758,
          fees: 0,
          cash: 290.48,
          equity: 524.76,
          notes: null,
        }],
        notes: [],
      },
    }), NOW);
    expect(health.stale_opens).toBe(1);
    expect(health.marks_lagging).toBe(true);
    expect(health.alerts[0]?.kind).toBe('stale_open');
    expect(health.alerts[0]?.steward).toBe('oddsborne');
    expect(health.alerts[0]?.label).toContain('tc-temp-mdwhigh');
  });

  test('flags a past-close market still status=open and a later close vs stale last_yes', () => {
    const health = assembleDeskBookHealth(desk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [
          {
            id: 'expired',
            venue: 'polymarket',
            slug: 'aec-nfl-ne-sea-2026-09-09',
            question: 'NE vs SEA',
            status: 'open',
            close_time: '2026-09-10T00:00:00.000Z',
            last_yes: 0.4,
            last_no: 0.6,
            last_marked_at: '2026-09-09T12:00:00.000Z',
            thesis_id: null,
            rules_summary: null,
          },
          {
            id: 'midway',
            venue: 'polymarket',
            slug: 'tc-temp-mdwhigh-2026-09-09-lt80f',
            question: 'Midway',
            status: 'open',
            close_time: null,
            last_yes: 0.775,
            last_no: 0.225,
            last_marked_at: '2026-09-09T17:51:44.000Z',
            thesis_id: null,
            rules_summary: null,
          },
        ],
        positions: [{
          id: 'midway-pos',
          market_id: 'midway',
          account_key: 'oddsborne',
          thesis_id: null,
          outcome: 'yes',
          status: 'closed',
          quantity: 190,
          average_cost: 0.258,
          mark: 0.01,
          mark_at: '2026-09-10T01:02:32.000Z',
          closed_at: '2026-09-10T01:02:32.000Z',
          thesis_text: null,
        }],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
    }), NOW);
    expect(health.resolved_still_open).toBe(1);
    expect(health.stale_catalog).toBe(1);
    expect(health.stale_opens).toBe(0);
    expect(health.alerts.map((row) => row.kind).sort()).toEqual(['resolved_still_open', 'stale_catalog']);
  });

  test('fresh open marks are quiet', () => {
    const health = assembleDeskBookHealth(desk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [{
          id: 'hike',
          venue: 'polymarket',
          slug: 'rdc-usfed-fomc-2026-09-16-hike25',
          question: 'Fed hike',
          status: 'open',
          close_time: '2026-09-16T23:59:00.000Z',
          last_yes: 0.535,
          last_no: 0.465,
          last_marked_at: '2026-09-10T01:02:32.000Z',
          thesis_id: null,
          rules_summary: null,
        }],
        positions: [{
          id: 'hike-pos',
          market_id: 'hike',
          account_key: 'oddsborne',
          thesis_id: null,
          outcome: 'yes',
          status: 'open',
          quantity: 166,
          average_cost: 0.51,
          mark: 0.53,
          mark_at: '2026-09-10T01:02:32.000Z',
          thesis_text: null,
        }],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
    }), NOW);
    expect(health.alerts).toEqual([]);
    expect(health.marks_lagging).toBe(false);
  });
});
