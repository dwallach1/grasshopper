import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  attachPredictionThesisLots,
  deskBookNames,
  deskEvents,
  emptyPredictionMarkets,
  filterBookNames,
  filterFillLog,
  mergeFillLog,
  predictionBookNames,
  predictionStartEquity,
  type PredictionMarketsPayload,
} from './prediction-book';
import type { BookNameLine, DeskPayload, ThesisRow } from './ledger-types';

const sampleMarket = {
  id: '11111111-1111-1111-1111-111111111111',
  venue: 'polymarket',
  slug: 'sample-labeled-fixture',
  question: 'SAMPLE — labeled fixture, not a live market',
  status: 'open',
  close_time: '2026-12-31T00:00:00.000Z',
  last_yes: null,
  last_no: null,
  last_marked_at: null,
  thesis_id: 'neocloud_compute',
  rules_summary: null,
};

function payload(partial: Partial<PredictionMarketsPayload> = {}): PredictionMarketsPayload {
  return {
    ...emptyPredictionMarkets(),
    markets: [sampleMarket],
    ...partial,
  };
}

describe('prediction book mapping', () => {
  test('open lots without a mark stay null P/L', () => {
    const names = predictionBookNames(payload({
      positions: [{
        id: 'pos-1',
        market_id: sampleMarket.id,
        account_key: 'oddsborne',
        thesis_id: 'neocloud_compute',
        outcome: 'yes',
        status: 'open',
        quantity: 10,
        average_cost: 0.4,
        mark: null,
        mark_at: null,
        thesis_text: null,
      }],
    }));
    expect(names).toHaveLength(1);
    expect(names[0]?.symbol).toBe('YES · sample-labeled-fixture');
    expect(names[0]?.venue).toBe('prediction');
    expect(names[0]?.mark).toBeNull();
    expect(names[0]?.pnl).toBeNull();
    expect(names[0]?.note).toBe(MARK_NOT_IN_LEDGER);
    expect(names[0]?.cost).toBeCloseTo(4);
  });

  test('P/L is ledger-derived only when both mark and cost exist', () => {
    const names = predictionBookNames(payload({
      positions: [{
        id: 'pos-2',
        market_id: sampleMarket.id,
        account_key: 'oddsborne',
        thesis_id: null,
        outcome: 'no',
        status: 'open',
        quantity: 8,
        average_cost: 0.25,
        mark: 0.4,
        mark_at: '2026-09-05T12:00:00.000Z',
        thesis_text: null,
      }],
    }));
    expect(names[0]?.pnl).toBeCloseTo(1.2);
    expect(names[0]?.note).toBe('');
  });

  test('closed lots do not appear on the book', () => {
    expect(predictionBookNames(payload({
      positions: [{
        id: 'pos-3',
        market_id: sampleMarket.id,
        account_key: 'oddsborne',
        thesis_id: null,
        outcome: 'yes',
        status: 'closed',
        quantity: 1,
        average_cost: 0.5,
        mark: 1,
        mark_at: null,
        thesis_text: null,
      }],
    }))).toEqual([]);
  });

  test('unified book names keep equity and prediction as one table', () => {
    const equity: BookNameLine = {
      symbol: 'NVDA',
      quantity: 2,
      average_cost: null,
      cost: null,
      mark: null,
      pnl: null,
      note: MARK_NOT_IN_LEDGER,
      venue: 'equity',
    };
    const desk = {
      book: { names: [equity] },
      prediction_markets: payload({
        positions: [{
          id: 'pos-4',
          market_id: sampleMarket.id,
          account_key: 'oddsborne',
          thesis_id: 'neocloud_compute',
          outcome: 'yes',
          status: 'open',
          quantity: 1,
          average_cost: null,
          mark: null,
          mark_at: null,
          thesis_text: null,
        }],
      }),
    } as unknown as DeskPayload;
    const all = deskBookNames(desk);
    expect(all.map((row) => row.symbol)).toEqual(['NVDA', 'YES · sample-labeled-fixture']);
    expect(filterBookNames(all, 'all').map((row) => row.symbol)).toEqual(['NVDA', 'YES · sample-labeled-fixture']);
    expect(filterBookNames(all, 'equity').map((row) => row.symbol)).toEqual(['NVDA']);
    expect(filterBookNames(all, 'prediction')).toHaveLength(1);
  });

  test('ALL is the union of stocks, predictions, and coins — never equity-only', () => {
    const equity: BookNameLine = {
      symbol: 'NVDA',
      quantity: 2,
      average_cost: null,
      cost: null,
      mark: null,
      pnl: null,
      note: MARK_NOT_IN_LEDGER,
      venue: 'equity',
    };
    const desk = {
      book: { names: [equity] },
      catalysts: [],
      lessons: [],
      prediction_markets: payload({
        positions: [{
          id: 'pos-all-pm',
          market_id: sampleMarket.id,
          account_key: 'oddsborne',
          thesis_id: 'neocloud_compute',
          outcome: 'yes',
          status: 'open',
          quantity: 1,
          average_cost: null,
          mark: null,
          mark_at: null,
          thesis_text: null,
        }],
      }),
      meme_coins: {
        desk: 'BANDIT',
        venue: 'meme',
        tokens: [{
          id: 'tok-1',
          venue: 'pumpfun',
          mint: 'MintFixture000000000000000000000000001',
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
          id: 'pos-all-meme',
          token_id: 'tok-1',
          account_key: 'solana-bandit-primary',
          thesis_id: null,
          status: 'open',
          quantity: 10,
          average_cost_sol: null,
          mark_sol: null,
          mark_at: null,
          thesis_text: null,
        }],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
    } as unknown as DeskPayload;
    const names = deskBookNames(desk);
    expect(names.map((row) => row.venue)).toEqual(['equity', 'prediction', 'meme']);
    expect(filterBookNames(names, 'all').map((row) => row.symbol)).toEqual([
      'NVDA',
      'YES · sample-labeled-fixture',
      'ZDOG',
    ]);
    expect(filterBookNames(names, 'equity').map((row) => row.symbol)).toEqual(['NVDA']);
    expect(filterBookNames(names, 'prediction').map((row) => row.symbol)).toEqual(['YES · sample-labeled-fixture']);
    expect(filterBookNames(names, 'meme').map((row) => row.symbol)).toEqual(['ZDOG']);
    expect(deskEvents(desk).map((row) => row.venue)).toEqual(['prediction', 'meme']);
    const tape = [
      {
        id: 'eq-fill',
        at: '2026-09-05T10:00:00.000Z',
        symbol: 'NVDA',
        side: 'buy',
        quantity: 1,
        price: 100,
        notional: 100,
        status: 'filled',
        source: 'broker_fill' as const,
        note: '',
        venue: 'equity' as const,
      },
      {
        id: 'pm-fill',
        at: '2026-09-05T11:00:00.000Z',
        symbol: 'YES · sample-labeled-fixture',
        side: 'buy',
        quantity: 1,
        price: 0.4,
        notional: 0.4,
        status: 'filled',
        source: 'prediction_fill' as const,
        note: '',
        venue: 'prediction' as const,
      },
      {
        id: 'meme-fill',
        at: '2026-09-05T12:00:00.000Z',
        symbol: 'ZDOG',
        side: 'buy',
        quantity: 10,
        price: 0.01,
        notional: 0.1,
        status: 'filled',
        source: 'meme_fill' as const,
        note: '',
        venue: 'meme' as const,
      },
    ];
    expect(filterFillLog(tape, 'all').map((row) => row.venue)).toEqual(['equity', 'prediction', 'meme']);
    expect(filterFillLog(tape, 'equity').map((row) => row.symbol)).toEqual(['NVDA']);
    expect(filterFillLog(tape, 'meme').map((row) => row.symbol)).toEqual(['ZDOG']);
  });

  test('fills and thesis lots use the same language', () => {
    const pm = payload({
      orders: [{
        id: 'ord-1',
        market_id: sampleMarket.id,
        thesis_id: 'neocloud_compute',
        outcome: 'yes',
        side: 'buy',
        order_type: 'limit',
        size: 5,
        price: 0.4,
        status: 'filled',
        mode: 'live',
        venue_order_id: 'pm-1',
        submitted_at: '2026-09-05T11:00:00.000Z',
        created_at: '2026-09-05T11:00:00.000Z',
      }],
      fills: [{
        id: 'fill-1',
        order_id: 'ord-1',
        position_id: null,
        outcome: 'yes',
        side: 'buy',
        quantity: 5,
        price: 0.4,
        executed_at: '2026-09-05T11:01:00.000Z',
      }],
      positions: [{
        id: 'pos-5',
        market_id: sampleMarket.id,
        account_key: 'oddsborne',
        thesis_id: 'neocloud_compute',
        outcome: 'yes',
        status: 'open',
        quantity: 5,
        average_cost: 0.4,
        mark: null,
        mark_at: null,
        thesis_text: null,
      }],
    });
    const tape = mergeFillLog([], pm);
    expect(tape[0]?.source).toBe('prediction_fill');
    expect(tape[0]?.symbol).toBe('YES · sample-labeled-fixture');
    expect(tape[0]?.notional).toBeCloseTo(2);
    const theses = attachPredictionThesisLots([
      {
        id: 'neocloud_compute',
        name: 'Neocloud',
        summary: 'SAMPLE thesis',
        status: 'hardening',
        confidence: 3,
        time_horizon: 'months',
        stance: 'long',
        variant_perception: null,
        falsifier: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        symbols: ['NVDA'],
        lots: [],
        venues: ['equity'],
      } satisfies ThesisRow,
    ], pm);
    expect(theses[0]?.venues).toEqual(['equity', 'prediction']);
    expect(theses[0]?.lots[0]?.venue).toBe('prediction');
    expect(theses[0]?.lots[0]?.pnl).toBeNull();
  });

  test('start equity is oldest pnl mark — missing start is null, not 0', () => {
    expect(predictionStartEquity(payload())).toBeNull();
    expect(predictionStartEquity(payload({
      pnl: [{
        id: 'later',
        account_key: 'oddsborne',
        as_of: '2026-09-06T13:43:43.294Z',
        realized: 0,
        unrealized: -1.9,
        fees: 1.93,
        cash: 358.58,
        equity: 424.07,
        notes: 'later',
      }, {
        id: 'seed',
        account_key: 'oddsborne',
        as_of: '2026-09-06T13:10:47.142Z',
        realized: 0,
        unrealized: 0,
        fees: 0,
        cash: 426,
        equity: 426,
        notes: 'Seeded by GRASSHOPPER',
      }],
    }))).toEqual({
      equity: 426,
      as_of: '2026-09-06T13:10:47.142Z',
      source: 'pnl_equity',
    });
    expect(predictionStartEquity(payload({
      pnl: [{
        id: 'cash-only',
        account_key: 'oddsborne',
        as_of: '2026-09-06T13:10:47.142Z',
        realized: 0,
        unrealized: 0,
        fees: 0,
        cash: 400,
        equity: null,
        notes: 'seed cash',
      }],
    }))?.source).toBe('pnl_cash');
  });

  test('events include market close without inventing a date', () => {
    const desk = {
      catalysts: [{
        id: 1,
        thesis_id: 'neocloud_compute',
        symbol: 'NVDA',
        catalyst_type: 'earnings',
        event_date: '2026-11-01',
        summary: 'SAMPLE equity catalyst',
        source: 'test',
        status: 'upcoming',
        created_at: '2026-09-01T00:00:00.000Z',
      }],
      prediction_markets: payload({
        markets: [{ ...sampleMarket, close_time: null }],
      }),
    } as unknown as DeskPayload;
    const events = deskEvents(desk);
    expect(events.map((row) => row.venue)).toEqual(['equity', 'prediction']);
    expect(events[1]?.when).toBeNull();
    expect(events[1]?.summary).toContain('SAMPLE');
  });
});
