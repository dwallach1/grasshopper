import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import { assembleTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';
import { stewardDeskFace } from './steward-face';
import {
  PRESENCE_DONE_MS,
  presenceSettle,
  presenceTempo,
  stewardPresence,
  stewardPresences,
} from './steward-presence';

const NOW = Date.parse('2026-09-06T13:24:00.000Z');
const FRESH = '2026-09-06T13:10:00.000Z';
const STALE = '2026-09-06T04:00:00.000Z';
const RECENT = '2026-09-06T13:22:00.000Z';
const OLD = '2026-09-04T13:24:00.000Z';

function team(statuses: Partial<Record<'quantanamo' | 'oddsborne' | 'bandit' | 'grasshopper', string>> = {}) {
  const status = (slug: 'quantanamo' | 'oddsborne' | 'bandit' | 'grasshopper', fallback: string) => (
    statuses[slug] ?? fallback
  );
  return assembleTeam({
    agents: [
      agent('agent-g', 'grasshopper', 'GRASSHOPPER', status('grasshopper', 'active'), 1),
      agent('agent-q', 'quantanamo', 'QUANTANAMO', status('quantanamo', 'active'), 2),
      agent('agent-o', 'oddsborne', 'ODDSBORNE', status('oddsborne', 'active'), 3),
      agent('agent-b', 'bandit', 'BANDIT', status('bandit', 'idle'), 4),
    ],
    domains: [
      { id: 'dom-e', slug: 'equity', name: 'Stocks', kind: 'trading', description: '', accent: '#5b8def', status: 'active', sort_order: 10, meta: {} },
      { id: 'dom-p', slug: 'prediction', name: 'Predictions', kind: 'trading', description: '', accent: '#c084fc', status: 'active', sort_order: 20, meta: {} },
      { id: 'dom-m', slug: 'meme', name: 'Meme coins', kind: 'trading', description: '', accent: '#f59e0b', status: 'active', sort_order: 30, meta: {} },
    ],
    stewards: [
      { id: 's-e', domain_id: 'dom-e', agent_id: 'agent-q', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      { id: 's-p', domain_id: 'dom-p', agent_id: 'agent-o', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      { id: 's-m', domain_id: 'dom-m', agent_id: 'agent-b', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
    ],
    accounts: [],
  });
}

function agent(id: string, slug: string, name: string, status: string, sort: number) {
  return {
    id,
    slug,
    display_name: name,
    role_title: name,
    charter: '',
    accent: '#5b8def',
    avatar_key: slug,
    status,
    heartbeat_at: FRESH,
    sort_order: sort,
    meta: {},
  };
}

function desk(partial: Partial<DeskPayload> = {}): DeskPayload {
  const fixture = {
    generated_at: '2026-09-06T13:24:00.000Z',
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: FRESH,
      last4: '7638',
      buying_power: null,
      starting_nav: 5000,
      current_nav: 5000,
      cash: null,
      deployed: null,
      vs_start: 0,
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
    fill_log: [],
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
    team: team(),
    ...partial,
  };
  // SAFETY: fixture only fills the ledger fields presence reads. Omitted arrays stay empty.
  return fixture as DeskPayload;
}

function equityOpen(extra: { thesis_id?: string | null; untagged?: string | null } = {}) {
  return {
    id: 'pos-cifr',
    account_key: 'robinhood',
    symbol: 'CIFR',
    status: 'open',
    quantity: 10,
    average_cost: 4,
    opened_at: OLD,
    closed_at: null,
    next_review_at: null,
    thesis_id: extra.thesis_id === undefined ? 'earnings_gap_structure' : extra.thesis_id,
    untagged: extra.untagged ?? null,
  };
}

describe('steward presence', () => {
  test('a flat steward blinks idle, including a fresh heartbeat', () => {
    const state = stewardPresence(desk(), 'quantanamo', NOW);
    expect(state).toEqual({ presence: 'idle', settle: 0 });
    expect(stewardPresence(desk(), 'grasshopper', NOW).presence).toBe('idle');
    expect(stewardDeskFace(desk(), 'quantanamo', NOW).presence).toBe('idle');
  });

  test('open risk with a fresh mark waits', () => {
    const waiting = desk({ positions: [equityOpen()] });
    expect(stewardPresence(waiting, 'quantanamo', NOW)).toEqual({ presence: 'waiting', settle: 0 });
    expect(stewardDeskFace(waiting, 'quantanamo', NOW).attending).toBe(true);
  });

  test('historical untagged is not a missing gate', () => {
    const legacy = desk({
      positions: [equityOpen({ thesis_id: null, untagged: 'historical' })],
    });
    expect(stewardPresence(legacy, 'quantanamo', NOW).presence).toBe('waiting');
  });

  test('a live lot with neither thesis nor untagged reason is blocked', () => {
    const gate = desk({
      positions: [equityOpen({ thesis_id: null, untagged: null })],
    });
    expect(stewardPresence(gate, 'quantanamo', NOW).presence).toBe('blocked');
  });

  test('stale open marks block even when an intent is in flight', () => {
    const stale = desk({
      book: {
        ...desk().book,
        observed_at: STALE,
      },
      positions: [equityOpen()],
      intents: [{
        id: 'i1',
        account_key: 'robinhood',
        symbol: 'CIFR',
        side: 'buy',
        status: 'submitted',
        mode: 'live',
        notional: 100,
        quantity: 1,
        order_type: 'market',
        broker_order_id: null,
        created_at: RECENT,
        updated_at: RECENT,
      }],
    });
    expect(stewardPresence(stale, 'quantanamo', NOW).presence).toBe('blocked');
  });

  test('a recent intent or a scan is working', () => {
    const intent = desk({
      intents: [{
        id: 'i1',
        account_key: 'robinhood',
        symbol: 'CIFR',
        side: 'buy',
        status: 'submitted',
        mode: 'live',
        notional: 100,
        quantity: 1,
        order_type: 'market',
        broker_order_id: null,
        created_at: RECENT,
        updated_at: RECENT,
      }],
    });
    expect(stewardPresence(intent, 'quantanamo', NOW).presence).toBe('working');

    const scanning = desk({ team: team({ bandit: 'watching' }) });
    expect(stewardPresence(scanning, 'bandit', NOW).presence).toBe('working');
    expect(presenceTempo('working')).toBeGreaterThan(presenceTempo('idle'));
  });

  test('a recent fill on an open book works; the same fill after the last close settles', () => {
    const filling = desk({
      positions: [equityOpen()],
      fills: [{ id: 'f1', trade_intent_id: 'i1', quantity: 1, price: 4, executed_at: RECENT }],
    });
    expect(stewardPresence(filling, 'quantanamo', NOW).presence).toBe('working');

    const closedAt = new Date(NOW - 30_000).toISOString();
    const settled = desk({
      positions: [{
        ...equityOpen(),
        status: 'closed',
        quantity: 0,
        closed_at: closedAt,
      }],
      fills: [{ id: 'f1', trade_intent_id: 'i1', quantity: 1, price: 4, executed_at: closedAt }],
    });
    const done = stewardPresence(settled, 'quantanamo', NOW);
    expect(done.presence).toBe('done');
    expect(done.settle).toBeGreaterThan(0.5);
    expect(done.settle).toBeLessThan(1);
  });

  test('an old paper or partial order does not keep a flat steward working', () => {
    const zombie = desk({
      prediction_markets: {
        ...desk().prediction_markets,
        orders: [
          {
            id: 'o-paper',
            market_id: 'm1',
            thesis_id: null,
            outcome: 'yes',
            side: 'buy',
            order_type: 'limit',
            size: 10,
            price: 0.4,
            status: 'paper',
            mode: 'paper',
            venue_order_id: null,
            submitted_at: null,
            created_at: RECENT,
          },
          {
            id: 'o-partial',
            market_id: 'm1',
            thesis_id: null,
            outcome: 'yes',
            side: 'sell',
            order_type: 'limit',
            size: 10,
            price: 0.4,
            status: 'partial',
            mode: 'live',
            venue_order_id: null,
            submitted_at: OLD,
            created_at: OLD,
          },
        ],
      },
    });
    expect(stewardPresence(zombie, 'oddsborne', NOW).presence).toBe('idle');
  });

  test('a close older than the settle window eases to idle', () => {
    expect(presenceSettle(0)).toBe(1);
    expect(presenceSettle(PRESENCE_DONE_MS / 2)).toBeGreaterThan(presenceSettle(PRESENCE_DONE_MS * 0.9));
    expect(presenceSettle(PRESENCE_DONE_MS)).toBe(0);

    const aged = desk({
      positions: [{
        ...equityOpen(),
        status: 'closed',
        quantity: 0,
        closed_at: new Date(NOW - PRESENCE_DONE_MS - 1000).toISOString(),
      }],
    });
    expect(stewardPresence(aged, 'quantanamo', NOW)).toEqual({ presence: 'idle', settle: 0 });
  });

  test('Board and Team read the same map', () => {
    const open = desk({ positions: [equityOpen()] });
    const map = stewardPresences(open, NOW);
    expect(map.get('quantanamo')?.presence).toBe('waiting');
    expect(stewardDeskFace(open, 'quantanamo', NOW).presence).toBe(map.get('quantanamo')?.presence);
    expect(stewardPresence(open, 'oddsborne', NOW).presence).toBe('idle');
  });
});
