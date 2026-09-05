import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  attachPredictionThesisLots,
  deskBookNames,
  deskEvents,
  emptyPredictionMarkets,
  filterBookNames,
  mergeFillLog,
  predictionBookNames,
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
    expect(filterBookNames(all, 'equity').map((row) => row.symbol)).toEqual(['NVDA']);
    expect(filterBookNames(all, 'prediction')).toHaveLength(1);
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
