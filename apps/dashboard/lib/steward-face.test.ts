import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import { assembleTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';
import { stewardDeskFace, stewardDeskFaces } from './steward-face';

const NOW = Date.parse('2026-09-06T13:24:00.000Z');

function ledgerTeam() {
  return assembleTeam({
    agents: [
      {
        id: 'agent-q',
        slug: 'quantanamo',
        display_name: 'QUANTANAMO',
        role_title: 'Equities trader',
        charter: 'Stocks.',
        accent: '#5b8def',
        avatar_key: 'quant',
        status: 'active',
        heartbeat_at: '2026-09-06T13:23:04.000Z',
        sort_order: 2,
        meta: {},
      },
      {
        id: 'agent-o',
        slug: 'oddsborne',
        display_name: 'ODDSBORNE',
        role_title: 'Prediction markets trader',
        charter: 'PM.',
        accent: '#c084fc',
        avatar_key: 'odds',
        status: 'watching',
        heartbeat_at: null,
        sort_order: 3,
        meta: {},
      },
      {
        id: 'agent-b',
        slug: 'bandit',
        display_name: 'BANDIT',
        role_title: 'Meme-coin trader',
        charter: 'Coins.',
        accent: '#f59e0b',
        avatar_key: 'bandit',
        status: 'idle',
        heartbeat_at: null,
        sort_order: 4,
        meta: {},
      },
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

function desk(partial: Record<string, unknown> = {}): DeskPayload {
  return {
    generated_at: '2026-09-06T13:24:00.000Z',
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
      markets: [{
        id: 'm1',
        venue: 'polymarket',
        slug: 'fed-cut',
        question: 'Cut?',
        status: 'open',
        close_time: null,
        last_yes: 0.58,
        last_no: 0.42,
        last_marked_at: '2026-09-06T13:00:00.000Z',
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
        mark_at: '2026-09-06T13:10:00.000Z',
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
      tokens: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [],
      notes: [],
    },
    team: ledgerTeam(),
    ...partial,
  } as unknown as DeskPayload;
}

describe('steward desk face', () => {
  test('Board %, pulse, watching, and open ticket map onto the shared face', () => {
    const faces = stewardDeskFaces(desk(), NOW);
    expect(faces.get('quantanamo')).toEqual({
      mood: 'up',
      alive: true,
      thinking: false,
      attending: false,
    });
    expect(faces.get('oddsborne')).toEqual({
      mood: 'idle',
      alive: false,
      thinking: true,
      attending: true,
    });
    expect(faces.get('bandit')).toEqual({
      mood: 'idle',
      alive: false,
      thinking: false,
      attending: false,
    });
    expect(stewardDeskFace(desk(), 'spark', NOW)).toEqual({
      mood: 'idle',
      alive: false,
      thinking: false,
      attending: false,
    });
  });

  test('stale pulse and a down book stay honest', () => {
    const down = desk({
      book: {
        account_label: 'robinhood_agentic_7638',
        observed_at: '2026-09-04T20:06:00.000Z',
        last4: '7638',
        buying_power: null,
        starting_nav: 5000,
        current_nav: 4200,
        cash: null,
        deployed: null,
        vs_start: -800,
        vs_start_note: MARK_NOT_IN_LEDGER,
        day_pnl: null,
        day_pnl_note: MARK_NOT_IN_LEDGER,
        vs_cost: null,
        vs_cost_note: MARK_NOT_IN_LEDGER,
        names: [],
      },
      team: assembleTeam({
        ...ledgerTeam(),
        agents: ledgerTeam().agents.map((agent) => (
          agent.slug === 'quantanamo'
            ? { ...agent, heartbeat_at: '2026-09-06T12:00:00.000Z' }
            : agent
        )),
      }),
    });
    expect(stewardDeskFace(down, 'quantanamo', NOW)).toEqual({
      mood: 'down',
      alive: false,
      thinking: false,
      attending: false,
    });
  });
});
