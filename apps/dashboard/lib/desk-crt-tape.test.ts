import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  assembleCrtTape,
  compactCrtPrice,
  compactCrtQty,
  compactCrtSymbol,
  crtFillGlyph,
  crtFillStatus,
  crtStewardCode,
  crtTapeScrollText,
  formatCrtFillLabel,
} from './desk-crt-tape';
import { fallbackTeam } from './desk-team';
import type { BookNameLine, DeskPayload, FillLogRow } from './ledger-types';
import { BANDIT_BANKROLL_SOL_START, BANDIT_PRIMARY_ACCOUNT } from './meme-book';

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

function fill(partial: Partial<FillLogRow> & Pick<FillLogRow, 'id' | 'at' | 'symbol'>): FillLogRow {
  return {
    side: 'buy',
    quantity: 1,
    price: 10,
    notional: 10,
    status: 'filled',
    source: 'broker_fill',
    note: '',
    venue: 'equity',
    ...partial,
  };
}

function liveDesk(partial: Partial<DeskPayload> = {}): DeskPayload {
  const desk = {
    generated_at: '2026-09-07T13:16:55.309Z',
    source: 'snapshot',
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
      vs_start_note: 'vs first Agentic snapshot',
      day_pnl: 518.95,
      day_pnl_note: 'vs prior NY session',
      vs_cost: null,
      vs_cost_note: MARK_NOT_IN_LEDGER,
      names: [equityLine('AOUT')],
    },
    prediction_markets: {
      desk: 'ODDSBORNE',
      venue: 'prediction',
      markets: [],
      positions: [],
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
          notes: 'seed',
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
          notes: 'mark',
        },
      ],
      notes: [],
    },
    meme_coins: {
      desk: 'BANDIT',
      venue: 'meme',
      tokens: [{
        id: 'tok-zdog',
        venue: 'pumpfun',
        mint: 'zdogmint',
        symbol: 'ZDOG',
        name: 'ZDOG',
        status: 'active',
        bonding_curve_status: null,
        graduated_at: null,
        last_price_sol: 0.000016,
        last_mcap_sol: null,
        last_marked_at: '2026-09-07T10:55:48.265Z',
        thesis_id: null,
        kill_criteria: null,
      }],
      positions: [],
      orders: [{
        id: 'ord-zdog',
        token_id: 'tok-zdog',
        account_key: BANDIT_PRIMARY_ACCOUNT,
        side: 'buy',
        status: 'filled',
        mode: 'live',
        size_tokens: 5220.446688,
        size_sol: null,
        price_sol: 0.00004214,
        order_type: 'market',
        venue_order_id: 'v1',
        created_at: '2026-09-07T10:55:40.000Z',
        submitted_at: '2026-09-07T10:55:40.000Z',
      }],
      fills: [{
        id: 'meme-1',
        order_id: 'ord-zdog',
        position_id: null,
        account_key: BANDIT_PRIMARY_ACCOUNT,
        side: 'buy',
        quantity: 5220.446688,
        price_sol: 0.00004214,
        fee_sol: 0,
        executed_at: '2026-09-07T10:55:48.265Z',
      }],
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
          notes: 'seed',
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
          notes: 'mark',
        },
      ],
      notes: [],
    },
    fill_log: [
      fill({
        id: 'pm-1',
        at: '2026-09-06T13:43:43.294Z',
        symbol: 'YES · rdc-usfed-fomc-2026-09-16-hike25',
        side: 'buy',
        quantity: 128.41,
        price: 0.51,
        notional: 65.4891,
        status: 'partial',
        source: 'prediction_fill',
        venue: 'prediction',
      }),
      fill({
        id: 'eq-1',
        at: '2026-09-03T17:21:54.583Z',
        symbol: 'AOUT',
        quantity: 180,
        price: 9.9804,
        notional: 1796.472,
      }),
    ],
    routines: [
      {
        id: 'market_scan',
        name: 'QUANTANAMO market scan',
        cadence: 'Weekday hourly',
        status: 'live',
        last_run_at: '2026-09-04T20:06:00.000Z',
        last_run_type: 'market_scan',
        last_outcome: 'passed',
        last_summary: 'ok',
      },
    ],
    team: fallbackTeam(),
    ...partial,
  };
  // SAFETY: fixture only populates CRT tape / board fields this test reads.
  return desk as DeskPayload;
}

describe('CRT tape coercion', () => {
  test('symbols stay compact and never invent a missing price', () => {
    expect(compactCrtSymbol('YES · rdc-usfed-fomc-2026-09-16-hike25')).toBe('YES·hike25');
    expect(compactCrtSymbol('AOUT')).toBe('AOUT');
    expect(compactCrtSymbol('')).toBe('—');
    expect(compactCrtQty(5220.446688)).toBe('5.2k');
    expect(compactCrtQty(180)).toBe('180');
    expect(compactCrtQty(null)).toBe('');
    expect(compactCrtPrice(null, 'USD')).toBe('');
    expect(compactCrtPrice(9.9804, 'USD')).toContain('9.98');
    expect(compactCrtPrice(0.00004214, 'SOL')).toContain('SOL');
    expect(compactCrtPrice(0.00004214, 'SOL')).not.toContain('$');
    expect(crtFillStatus('partial')).toBe('PART');
    expect(crtFillStatus('filled')).toBe('FILL');
    expect(crtFillGlyph('sell')).toBe('<');
    expect(crtFillGlyph('buy')).toBe('>');
    expect(crtStewardCode('meme')).toBe('BND');
    expect(formatCrtFillLabel(fill({
      id: 'x',
      at: '2026-09-03T17:21:54.583Z',
      symbol: 'AOUT',
      quantity: 180,
      price: null,
    }))).toBe('AOUT BUY 180');
  });
});

describe('assembleCrtTape', () => {
  test('mixes snapshot fills, meme fills, steward marks, and freshness', () => {
    const tape = assembleCrtTape(liveDesk());
    const kinds = tape.map((row) => row.kind);
    expect(kinds).toContain('fill');
    expect(kinds).toContain('snap');
    expect(kinds).toContain('mark');
    expect(kinds).toContain('scan');
    const meme = tape.find((row) => row.id === 'fill:meme-1');
    expect(meme?.steward).toBe('BND');
    expect(meme?.label).toContain('ZDOG');
    expect(meme?.label).toContain('SOL');
    expect(tape.some((row) => row.id === 'fill:pm-1' && row.status === 'PART')).toBe(true);
    expect(tape.some((row) => row.id.startsWith('snap:') && row.status === 'ONLINE')).toBe(true);
    expect(tape.some((row) => row.label === 'QUANTANAMO MARK')).toBe(true);
    expect(tape.some((row) => row.label === 'SCAN' && row.status === 'OK')).toBe(true);
    expect(crtTapeScrollText(tape)).toContain('ZDOG');
    expect(crtTapeScrollText(tape)).toContain('SNAP LEDGER');
  });

  test('empty books still emit a snapshot line and do not invent fills', () => {
    const tape = assembleCrtTape(liveDesk({
      fill_log: [],
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
      routines: [],
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
      snapshots: [],
    }));
    expect(tape.some((row) => row.kind === 'fill')).toBe(false);
    expect(tape.some((row) => row.kind === 'snap' && row.status === 'ONLINE')).toBe(true);
    expect(crtTapeScrollText([])).toContain('not in ledger');
  });
});
