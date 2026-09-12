import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  assembleBookHoldings,
  holdingChangePct,
  holdingLifeLabel,
  holdingTicket,
  holdingUpl,
} from './book-holdings';
import { assembleBookOpen } from './book-open-strip';
import { fallbackTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';
import { BANDIT_PRIMARY_ACCOUNT } from './meme-book';

function desk(partial: Record<string, unknown> = {}): DeskPayload {
  return {
    generated_at: '2026-09-12T21:00:00.000Z',
    snapshots: [],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: '2026-09-11T20:05:00.000Z',
      last4: '7638',
      buying_power: null,
      starting_nav: 5000,
      current_nav: 5157,
      cash: null,
      deployed: null,
      vs_start: 157,
      vs_start_note: MARK_NOT_IN_LEDGER,
      day_pnl: null,
      day_pnl_note: MARK_NOT_IN_LEDGER,
      vs_cost: null,
      vs_cost_note: MARK_NOT_IN_LEDGER,
      names: [
        {
          symbol: 'NBIS',
          quantity: 4.65,
          average_cost: 214.91,
          cost: 1000,
          mark: 224.02,
          pnl: 42.4,
          note: '',
          venue: 'equity',
        },
      ],
    },
    positions: [],
    exposures: [],
    fills: [],
    intents: [],
    prediction_markets: {
      desk: 'ODDSBORNE',
      venue: 'prediction',
      markets: [{
        id: 'm-hike',
        slug: 'rdc-usfed-fomc-2026-09-16-hike25',
        question: 'Fed hike 25',
        status: 'open',
        close_time: null,
        last_yes: 0.78,
        last_no: 0.22,
        last_marked_at: '2026-09-12T13:00:00.000Z',
      }],
      positions: [{
        id: 'p-open',
        market_id: 'm-hike',
        account_key: 'polymarket-us-primary',
        thesis_id: null,
        outcome: 'yes',
        status: 'open',
        quantity: 42,
        average_cost: 0.462,
        mark: 0.785,
        mark_at: '2026-09-12T13:00:00.000Z',
        thesis_text: null,
      }],
      orders: [],
      fills: [],
      pnl: [],
      notes: [],
    },
    meme_coins: {
      desk: 'BANDIT',
      venue: 'meme',
      tokens: [{
        id: 'tok-baton',
        venue: 'meme',
        mint: 'batonmint000000000000000000000000000001',
        symbol: 'BATON',
        name: 'Baton',
        status: 'active',
        bonding_curve_status: null,
        graduated_at: null,
        last_price_sol: 0.00011,
        last_mcap_sol: null,
        last_marked_at: '2026-09-12T20:40:00.000Z',
      }],
      positions: [{
        id: 'pos-baton',
        token_id: 'tok-baton',
        account_key: BANDIT_PRIMARY_ACCOUNT,
        thesis_id: null,
        status: 'open',
        quantity: 3446,
        average_cost_sol: 0.00013,
        mark_sol: 0.00011,
        mark_at: '2026-09-12T20:40:00.000Z',
        thesis_text: null,
      }],
      orders: [],
      fills: [],
      pnl: [],
      notes: [],
    },
    team: fallbackTeam(),
    ...partial,
  } as unknown as DeskPayload;
}

describe('holding math', () => {
  test('change % is sign-only and never 0 from a missing book', () => {
    expect(holdingChangePct(214.91, 224.02)).toBeCloseTo(((224.02 - 214.91) / 214.91) * 100);
    expect(holdingChangePct(0.462, 0.785)).toBeGreaterThan(0);
    expect(holdingChangePct(0.00013, 0.00011)).toBeLessThan(0);
    expect(holdingChangePct(null, 10)).toBeNull();
    expect(holdingChangePct(10, null)).toBeNull();
    expect(holdingChangePct(0, 10)).toBeNull();
    expect(holdingUpl(10, 12, 3)).toBe(6);
    expect(holdingUpl(null, 12, 3)).toBeNull();
  });
});

describe('assembleBookHoldings', () => {
  test('lists every open lot across Stocks, Predictions, and Coins — even without a sparkline series', () => {
    const holdings = assembleBookHoldings(desk());
    const names = holdings.rows.map((row) => row.name);
    expect(names).toContain('NBIS');
    expect(names.some((name) => name.startsWith('YES · '))).toBe(true);
    expect(names).toContain('BATON');
    expect(holdings.rows).toHaveLength(3);
    const nbis = holdings.rows.find((row) => row.id === 'eq:NBIS');
    expect(nbis?.book_short).toBe('QNT');
    expect(nbis?.steward).toBe('QUANTANAMO');
    expect(nbis?.steward_slug).toBe('quantanamo');
    expect(nbis?.life).toBe('live');
    expect(holdingLifeLabel(nbis!.life)).toBe('LIVE');
    expect(nbis?.change_pct).toBeGreaterThan(0);
    expect(nbis?.upl).toBe(42.4);
    const open = assembleBookOpen(desk());
    expect(open.rows.some((row) => row.id === 'quantanamo')).toBe(false);
    expect(holdingTicket(nbis!, open.rows.flatMap((row) => row.tickets))).toBeUndefined();
  });

  test('zero-size open lots stay off; closed Stocks / Predictions / Coins join as historic', () => {
    const holdings = assembleBookHoldings(desk({
      book: {
        ...desk().book,
        names: [
          ...desk().book.names,
          {
            symbol: 'ZERO',
            quantity: 0,
            average_cost: 1,
            cost: 0,
            mark: 1,
            pnl: 0,
            note: '',
            venue: 'equity',
          },
        ],
      },
      positions: [{
        id: 'ep-cifr',
        account_key: 'robinhood_agentic_7638',
        symbol: 'CIFR',
        status: 'closed',
        quantity: 63,
        average_cost: 15.82,
        opened_at: '2026-08-01T00:00:00.000Z',
        closed_at: '2026-09-01T00:00:00.000Z',
        next_review_at: null,
      }],
      prediction_markets: {
        ...desk().prediction_markets,
        positions: [
          ...(desk().prediction_markets?.positions ?? []),
          {
            id: 'p-closed',
            market_id: 'm-hike',
            account_key: 'polymarket-us-primary',
            thesis_id: null,
            outcome: 'yes',
            status: 'closed',
            quantity: 65,
            average_cost: 0.188,
            mark: 1,
            mark_at: '2026-09-11T00:00:00.000Z',
            thesis_text: null,
          },
        ],
      },
      meme_coins: {
        ...desk().meme_coins,
        positions: [
          ...(desk().meme_coins?.positions ?? []),
          {
            id: 'pos-done',
            token_id: 'tok-baton',
            account_key: BANDIT_PRIMARY_ACCOUNT,
            thesis_id: null,
            status: 'closed',
            quantity: 100,
            average_cost_sol: 0.0002,
            mark_sol: 0.00011,
            mark_at: '2026-09-10T00:00:00.000Z',
            thesis_text: null,
          },
        ],
      },
    }));
    const names = holdings.rows.map((row) => row.name);
    expect(names).not.toContain('ZERO');
    const cifr = holdings.rows.find((row) => row.id === 'eq-closed:ep-cifr');
    expect(cifr).toMatchObject({
      name: 'CIFR',
      life: 'closed',
      steward: 'QUANTANAMO',
      steward_slug: 'quantanamo',
      mark: null,
      change_pct: null,
      upl: null,
    });
    expect(holdingLifeLabel(cifr!.life)).toBe('CLOSED');
    const pmClosed = holdings.rows.find((row) => row.id === 'pm:p-closed');
    expect(pmClosed?.life).toBe('closed');
    expect(pmClosed?.steward).toBe('ODDSBORNE');
    expect(pmClosed?.change_pct).not.toBeNull();
    const memeClosed = holdings.rows.find((row) => row.id === 'meme:pos-done');
    expect(memeClosed?.life).toBe('closed');
    expect(memeClosed?.steward).toBe('BANDIT');
    expect(holdings.rows.filter((row) => row.life === 'live')).toHaveLength(3);
    expect(holdings.rows.filter((row) => row.life === 'closed')).toHaveLength(3);
  });
});
