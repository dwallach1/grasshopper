import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  attachMemeThesisLots,
  BANDIT_BANKROLL_SOL_START,
  BANDIT_PRIMARY_ACCOUNT,
  emptyMemeCoins,
  mapMemeCoins,
  memeBookNames,
  memeFillLog,
  memeStartEquity,
  type MemeCoinsPayload,
} from './meme-book';
import type { ThesisRow } from './ledger-types';

const sampleToken = {
  id: '22222222-2222-2222-2222-222222222222',
  venue: 'pumpfun',
  mint: 'DTrR7ZN9mintfixture000000000000000000001',
  symbol: 'ZDOG',
  name: 'Anonymous Dog',
  status: 'watch',
  bonding_curve_status: null,
  graduated_at: null,
  last_price_sol: null,
  last_mcap_sol: null,
  last_marked_at: null,
  thesis_id: 'meme_watch',
  kill_criteria: null,
};

function payload(partial: Partial<MemeCoinsPayload> = {}): MemeCoinsPayload {
  return {
    ...emptyMemeCoins(),
    tokens: [sampleToken],
    ...partial,
  };
}

describe('meme book mapping', () => {
  test('open lots without a mark stay null P/L', () => {
    const names = memeBookNames(payload({
      positions: [{
        id: 'pos-1',
        token_id: sampleToken.id,
        account_key: 'solana-bandit-primary',
        thesis_id: 'meme_watch',
        status: 'open',
        quantity: 1000,
        average_cost_sol: 0.001,
        mark_sol: null,
        mark_at: null,
        thesis_text: null,
      }],
    }));
    expect(names).toHaveLength(1);
    expect(names[0]?.symbol).toBe('ZDOG');
    expect(names[0]?.venue).toBe('meme');
    expect(names[0]?.mark).toBeNull();
    expect(names[0]?.pnl).toBeNull();
    expect(names[0]?.note).toBe(MARK_NOT_IN_LEDGER);
    expect(names[0]?.cost).toBeCloseTo(1);
  });

  test('P/L is ledger-derived only when both mark and cost exist', () => {
    const names = memeBookNames(payload({
      positions: [{
        id: 'pos-2',
        token_id: sampleToken.id,
        account_key: 'solana-bandit-primary',
        thesis_id: null,
        status: 'open',
        quantity: 10,
        average_cost_sol: 0.2,
        mark_sol: 0.25,
        mark_at: '2026-09-05T12:00:00.000Z',
        thesis_text: null,
      }],
    }));
    expect(names[0]?.pnl).toBeCloseTo(0.5);
    expect(names[0]?.note).toBe('');
  });

  test('closed lots and watch tokens without a position do not appear on the book', () => {
    expect(memeBookNames(payload({
      positions: [{
        id: 'pos-3',
        token_id: sampleToken.id,
        account_key: 'solana-bandit-primary',
        thesis_id: null,
        status: 'closed',
        quantity: 1,
        average_cost_sol: 0.5,
        mark_sol: 1,
        mark_at: null,
        thesis_text: null,
      }],
    }))).toEqual([]);
    expect(memeBookNames(payload())).toEqual([]);
  });

  test('fills use price_sol and never invent a notional', () => {
    const tape = memeFillLog(payload({
      orders: [{
        id: 'ord-1',
        token_id: sampleToken.id,
        account_key: 'solana-bandit-primary',
        thesis_id: 'meme_watch',
        side: 'buy',
        order_type: 'market',
        size_sol: 0.4,
        size_tokens: 400,
        price_sol: 0.001,
        status: 'filled',
        mode: 'live',
        venue_order_id: 'sig-1',
        submitted_at: '2026-09-05T11:00:00.000Z',
        created_at: '2026-09-05T11:00:00.000Z',
      }],
      fills: [{
        id: 'fill-1',
        order_id: 'ord-1',
        position_id: null,
        account_key: 'solana-bandit-primary',
        side: 'buy',
        quantity: 400,
        price_sol: 0.001,
        fee_sol: 0,
        executed_at: '2026-09-05T11:01:00.000Z',
      }],
    }));
    expect(tape[0]?.source).toBe('meme_fill');
    expect(tape[0]?.symbol).toBe('ZDOG');
    expect(tape[0]?.venue).toBe('meme');
    expect(tape[0]?.notional).toBeCloseTo(0.4);
  });

  test('thesis lots stay meme-tagged and do not invent P/L', () => {
    const theses = attachMemeThesisLots([
      {
        id: 'meme_watch',
        name: 'Meme watch',
        summary: 'SAMPLE thesis',
        status: 'hardening',
        confidence: 2,
        time_horizon: 'days',
        stance: 'long',
        variant_perception: null,
        falsifier: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        symbols: [],
        lots: [],
        venues: [],
      } satisfies ThesisRow,
    ], payload({
      positions: [{
        id: 'pos-5',
        token_id: sampleToken.id,
        account_key: 'solana-bandit-primary',
        thesis_id: 'meme_watch',
        status: 'open',
        quantity: 5,
        average_cost_sol: 0.4,
        mark_sol: null,
        mark_at: null,
        thesis_text: null,
      }],
    }));
    expect(theses[0]?.venues).toEqual(['meme']);
    expect(theses[0]?.lots[0]?.venue).toBe('meme');
    expect(theses[0]?.lots[0]?.pnl).toBeNull();
  });

  test('start equity prefers earliest pnl; bankroll 2 SOL only when current exists', () => {
    expect(memeStartEquity(payload())).toBeNull();
    expect(memeStartEquity(payload({
      pnl: [{
        id: 'seed',
        account_key: BANDIT_PRIMARY_ACCOUNT,
        as_of: '2026-09-06T14:23:40.405Z',
        realized: 0,
        unrealized: 0,
        fees: 0,
        cash_sol: 2,
        equity_sol: BANDIT_BANKROLL_SOL_START,
        notes: 'initial venue balance snapshot',
      }, {
        id: 'now',
        account_key: BANDIT_PRIMARY_ACCOUNT,
        as_of: '2026-09-06T15:48:20.740Z',
        realized: 0,
        unrealized: 0.02,
        fees: 0,
        cash_sol: 1.97,
        equity_sol: 2.03,
        notes: 'mark',
      }],
    }))).toEqual({
      equity_sol: 2,
      as_of: '2026-09-06T14:23:40.405Z',
      source: 'pnl_equity',
      account_key: BANDIT_PRIMARY_ACCOUNT,
    });
    expect(memeStartEquity(payload({
      pnl: [{
        id: 'now-only',
        account_key: BANDIT_PRIMARY_ACCOUNT,
        as_of: '2026-09-06T15:48:20.740Z',
        realized: 0,
        unrealized: null,
        fees: 0,
        cash_sol: 2,
        equity_sol: null,
        notes: 'current cash only',
      }],
    }))).toBeNull();
    expect(memeStartEquity(payload({
      pnl: [{
        id: 'now-unmarked-start',
        account_key: BANDIT_PRIMARY_ACCOUNT,
        as_of: '2026-09-06T14:23:40.405Z',
        realized: 0,
        unrealized: 0,
        fees: 0,
        cash_sol: 2,
        equity_sol: null,
        notes: 'seed cash',
      }, {
        id: 'now',
        account_key: BANDIT_PRIMARY_ACCOUNT,
        as_of: '2026-09-06T15:48:20.740Z',
        realized: 0,
        unrealized: 0.03,
        fees: 0,
        cash_sol: 1.97,
        equity_sol: 2.03,
        notes: 'mark',
      }],
    }))).toEqual({
      equity_sol: BANDIT_BANKROLL_SOL_START,
      as_of: '2026-09-06T14:23:40.405Z',
      source: 'bankroll',
      account_key: BANDIT_PRIMARY_ACCOUNT,
    });
  });

  test('mapper reads meme_* SOL columns without inventing marks', () => {
    const mapped = mapMemeCoins({
      tokens: [{
        id: sampleToken.id,
        venue: 'pumpfun',
        mint: sampleToken.mint,
        symbol: 'ZDOG',
        name: 'Anonymous Dog',
        status: 'watch',
        last_price_sol: null,
      }],
      positions: [{
        id: 'pos-map',
        token_id: sampleToken.id,
        account_key: 'solana-bandit-primary',
        status: 'open',
        quantity: '12.5',
        average_cost_sol: null,
        mark_sol: null,
      }],
    });
    expect(mapped.tokens[0]?.symbol).toBe('ZDOG');
    expect(mapped.positions[0]?.quantity).toBeCloseTo(12.5);
    expect(mapped.positions[0]?.mark_sol).toBeNull();
    expect(mapped.desk).toBe('BANDIT');
  });
});
