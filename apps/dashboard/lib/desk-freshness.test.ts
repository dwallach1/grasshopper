import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  assembleDeskFreshness,
  assembleStewardFreshness,
  freshnessTone,
  isMarkFresh,
  isMarkStale,
  latestLedgerEventAt,
  oldestStewardMarkAt,
} from './desk-freshness';
import type { DeskPayload } from './ledger-types';

const NOW = new Date('2026-09-07T22:00:00.000Z');

function desk(partial: Record<string, unknown> = {}): DeskPayload {
  return {
    generated_at: '2026-09-07T12:00:00.000Z',
    source: 'postgres',
    snapshots: [],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: null,
      last4: '7638',
      buying_power: null,
      starting_nav: null,
      current_nav: null,
      cash: null,
      deployed: null,
      vs_start: null,
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
    fill_log: [],
    intents: [],
    tests: [],
    routines: [
      {
        id: 'market_scan',
        name: 'QUANTANAMO market scan',
        cadence: '4h',
        status: 'live',
        last_run_at: '2026-09-07T21:50:00.000Z',
        last_run_type: 'market_scan',
        last_outcome: 'passed',
        last_summary: 'scan ok',
      },
    ],
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

describe('latestLedgerEventAt', () => {
  test('takes the newest stamp across equities, predictions, and meme', () => {
    const at = latestLedgerEventAt(
      desk({
        fills: [{ id: 'f1', trade_intent_id: 'i1', quantity: 1, price: 1, executed_at: '2026-09-01T00:00:00.000Z' }],
        fill_log: [{ id: 'l1', at: '2026-09-02T00:00:00.000Z', symbol: 'IREN', side: 'sell', source: 'broker_fill' }],
        book: {
          account_label: 'robinhood_agentic_7638',
          observed_at: '2026-09-03T00:00:00.000Z',
          last4: '7638',
          buying_power: null,
          starting_nav: null,
          current_nav: null,
          cash: null,
          deployed: null,
          vs_start: null,
          vs_start_note: MARK_NOT_IN_LEDGER,
          day_pnl: null,
          day_pnl_note: MARK_NOT_IN_LEDGER,
          vs_cost: null,
          vs_cost_note: MARK_NOT_IN_LEDGER,
          names: [],
        },
        prediction_markets: {
          desk: 'ODDSBORNE',
          venue: 'prediction',
          markets: [],
          positions: [
            {
              id: 'p1',
              market_id: 'm',
              account_key: 'pm',
              thesis_id: null,
              outcome: 'YES',
              status: 'open',
              quantity: 1,
              average_cost: 0.4,
              mark: 0.5,
              mark_at: '2026-09-04T00:00:00.000Z',
            },
          ],
          orders: [],
          fills: [
            {
              id: 'pf1',
              order_id: 'o1',
              position_id: 'p1',
              outcome: 'YES',
              side: 'buy',
              quantity: 1,
              price: 0.4,
              executed_at: '2026-09-05T00:00:00.000Z',
            },
          ],
          pnl: [
            {
              id: 'pp1',
              account_key: 'pm',
              as_of: '2026-09-06T00:00:00.000Z',
              realized: 0,
              unrealized: 0,
              fees: 0,
              cash: 0,
              equity: 0,
              notes: null,
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
          fills: [
            {
              id: 'mf1',
              order_id: 'mo1',
              position_id: 'mp1',
              account_key: 'meme',
              side: 'sell',
              quantity: 1,
              price_sol: 0.01,
              fee_sol: 0,
              executed_at: '2026-09-07T18:00:00.000Z',
            },
          ],
          pnl: [
            {
              id: 'mpnl',
              account_key: 'meme',
              as_of: '2026-09-06T12:00:00.000Z',
              realized: 0,
              unrealized: 0,
              fees: 0,
              cash_sol: 0,
              equity_sol: 0,
              notes: null,
            },
          ],
          notes: [],
        },
      }),
    );
    expect(at).toBe('2026-09-07T18:00:00.000Z');
  });

  test('ignores QUANTANAMO market_scan last_run_at and test started_at', () => {
    const at = latestLedgerEventAt(
      desk({
        fills: [{ id: 'f1', trade_intent_id: 'i1', quantity: 1, price: 1, executed_at: '2026-09-01T00:00:00.000Z' }],
        tests: [
          {
            id: 1,
            name: 'market_scan',
            kind: 'scan',
            status: 'passed',
            started_at: '2026-09-07T21:59:00.000Z',
            finished_at: '2026-09-07T21:59:30.000Z',
            duration_ms: 30_000,
            notes: {},
          },
        ],
      }),
    );
    expect(at).toBe('2026-09-01T00:00:00.000Z');
  });

  test('returns null when the book is empty of trading events', () => {
    expect(latestLedgerEventAt(desk({}))).toBeNull();
  });
});

describe('assembleDeskFreshness', () => {
  test('read chip is generated_at; steward chips keep Oddsborne lag visible', () => {
    const fresh = assembleDeskFreshness(
      desk({
        generated_at: '2026-09-07T20:00:00.000Z',
        source: 'snapshot',
        book: {
          account_label: 'robinhood_agentic_7638',
          observed_at: '2026-09-07T19:00:00.000Z',
          last4: '7638',
          buying_power: null,
          starting_nav: null,
          current_nav: null,
          cash: null,
          deployed: null,
          vs_start: null,
          vs_start_note: MARK_NOT_IN_LEDGER,
          day_pnl: null,
          day_pnl_note: MARK_NOT_IN_LEDGER,
          vs_cost: null,
          vs_cost_note: MARK_NOT_IN_LEDGER,
          names: [],
        },
        fills: [{ id: 'f1', trade_intent_id: 'i1', quantity: 1, price: 1, executed_at: '2026-09-07T19:30:00.000Z' }],
        prediction_markets: {
          desk: 'ODDSBORNE',
          venue: 'prediction',
          markets: [],
          positions: [{
            id: 'p1',
            market_id: 'm',
            account_key: 'pm',
            thesis_id: null,
            outcome: 'YES',
            status: 'open',
            quantity: 1,
            average_cost: 0.4,
            mark: 0.5,
            mark_at: '2026-09-07T12:00:00.000Z',
          }],
          orders: [],
          fills: [],
          pnl: [{
            id: 'pp1',
            account_key: 'pm',
            as_of: '2026-09-07T12:00:00.000Z',
            realized: 0,
            unrealized: 0,
            fees: 0,
            cash: 0,
            equity: 0,
            notes: null,
          }],
          notes: [{
            id: 'n1',
            market_id: null,
            thesis_id: null,
            note_type: 'lesson',
            title: 'later note',
            body: 'does not refresh marks',
            created_at: '2026-09-07T19:50:00.000Z',
          }],
        },
      }),
    );
    expect(fresh.read_at).toBe('2026-09-07T20:00:00.000Z');
    expect(fresh.latest_any_at).toBe('2026-09-07T19:30:00.000Z');
    expect(fresh.ledger_at).toBe('2026-09-07T12:00:00.000Z');
    expect(fresh.chips.map((c) => c.id)).toEqual(['read', 'quantanamo', 'oddsborne']);
    expect(fresh.chips.map((c) => c.label)).toEqual(['read', 'QNT', 'ODD']);
    expect(fresh.chips.find((c) => c.id === 'oddsborne')?.at).toBe('2026-09-07T12:00:00.000Z');
    expect(fresh.chips.find((c) => c.id === 'quantanamo')?.title).toContain('ODD');
    expect(freshnessTone(fresh.ledger_at, NOW)).toBe('warn');
    expect(freshnessTone(fresh.latest_any_at, NOW)).toBe('live');
    expect(isMarkFresh(fresh.chips.find((c) => c.id === 'oddsborne')?.at, NOW)).toBe(false);
    expect(isMarkStale(fresh.chips.find((c) => c.id === 'oddsborne')?.at, NOW)).toBe(true);
  });

  test('QNT chip can be a later snapshot than the Board book mark', () => {
    const payload = desk({
      generated_at: '2026-09-12T14:21:00.000Z',
      book: {
        account_label: 'robinhood_agentic_7638',
        observed_at: '2026-09-11T20:05:00.000Z',
        last4: '7638',
        buying_power: null,
        starting_nav: 5000,
        current_nav: 5157.1302,
        cash: null,
        deployed: null,
        vs_start: 157.1302,
        vs_start_note: MARK_NOT_IN_LEDGER,
        day_pnl: null,
        day_pnl_note: MARK_NOT_IN_LEDGER,
        vs_cost: null,
        vs_cost_note: MARK_NOT_IN_LEDGER,
        names: [],
      },
      snapshots: [{
        observed_at: '2026-09-12T13:17:42.000Z',
        account_label: 'robinhood_agentic_7638',
        total_value: 5201.769,
        equity_value: null,
        cash: null,
        buying_power: null,
        source: 'heartbeat',
      }],
    });
    const fresh = assembleDeskFreshness(payload);
    expect(fresh.chips.find((c) => c.id === 'read')?.at).toBe('2026-09-12T14:21:00.000Z');
    expect(fresh.chips.find((c) => c.id === 'quantanamo')?.at).toBe('2026-09-12T13:17:42.000Z');
    expect(payload.book.observed_at).toBe('2026-09-11T20:05:00.000Z');
  });
});

describe('steward freshness', () => {
  test('Oddsborne notes and heartbeat do not move the Book mark clock', () => {
    const payload = desk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [],
        positions: [{
          id: 'p1',
          market_id: 'm',
          account_key: 'pm',
          thesis_id: null,
          outcome: 'YES',
          status: 'open',
          quantity: 1,
          average_cost: 0.4,
          mark: 0.5,
          mark_at: '2026-09-07T12:00:00.000Z',
        }],
        orders: [],
        fills: [],
        pnl: [{
          id: 'pp1',
          account_key: 'pm',
          as_of: '2026-09-07T12:00:00.000Z',
          realized: 0,
          unrealized: 0,
          fees: 0,
          cash: 290,
          equity: 500,
          notes: null,
        }],
        notes: [{
          id: 'n1',
          market_id: null,
          thesis_id: null,
          note_type: 'lesson',
          title: 'afternoon lesson',
          body: 'hold',
          created_at: '2026-09-07T21:00:00.000Z',
        }],
      },
      team: {
        agents: [{ slug: 'oddsborne', heartbeat_at: '2026-09-07T10:00:00.000Z' }],
        domains: [],
        stewards: [],
        accounts: [],
      },
    });
    const odds = assembleStewardFreshness(payload).find((row) => row.id === 'oddsborne');
    expect(odds?.mark_at).toBe('2026-09-07T12:00:00.000Z');
    expect(odds?.activity_at).toBe('2026-09-07T21:00:00.000Z');
    expect(oldestStewardMarkAt(payload)).toBe('2026-09-07T12:00:00.000Z');
  });
});

describe('freshnessTone', () => {
  test('live under 6h, warn under 48h, stale after', () => {
    expect(freshnessTone('2026-09-07T20:00:00.000Z', NOW)).toBe('live');
    expect(freshnessTone('2026-09-07T10:00:00.000Z', NOW)).toBe('warn');
    expect(freshnessTone('2026-09-04T22:00:00.000Z', NOW)).toBe('stale');
    expect(freshnessTone(null, NOW)).toBe('stale');
  });
});
