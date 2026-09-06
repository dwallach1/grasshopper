import { describe, expect, test } from 'bun:test';

import {
  assembleTeam,
  clipCharter,
  deskTeam,
  emptyTeam,
  fallbackTeam,
  HEARTBEAT_FRESH_MS,
  isHeartbeatFresh,
  teamCards,
} from './desk-team';

const now = Date.parse('2026-09-06T13:30:00.000Z');

function ledgerTeam() {
  return assembleTeam({
    agents: [
      {
        id: 'agent-g',
        slug: 'grasshopper',
        display_name: 'GRASSHOPPER',
        role_title: 'Ledger steward',
        charter: 'Owns the shared ledger schema.',
        accent: '#7dd3a7',
        avatar_key: 'grasshopper',
        status: 'active',
        heartbeat_at: '2026-09-06T13:23:04.000Z',
        sort_order: 1,
        meta: {},
      },
      {
        id: 'agent-q',
        slug: 'quantanamo',
        display_name: 'QUANTANAMO',
        role_title: 'Equities trader',
        charter: 'Research and live trades on the equity book.',
        accent: '#5b8def',
        avatar_key: 'quant',
        status: 'active',
        heartbeat_at: '2026-09-06T12:00:00.000Z',
        sort_order: 2,
        meta: {},
      },
      {
        id: 'agent-o',
        slug: 'oddsborne',
        display_name: 'ODDSBORNE',
        role_title: 'Prediction markets trader',
        charter: 'Polymarket US and future prediction venues.',
        accent: '#c084fc',
        avatar_key: 'odds',
        status: 'watching',
        heartbeat_at: null,
        sort_order: 3,
        meta: {},
      },
    ],
    domains: [
      { id: 'dom-l', slug: 'ledger', name: 'Ledger', kind: 'ops', description: '', accent: '#7dd3a7', status: 'active', sort_order: 5, meta: {} },
      { id: 'dom-e', slug: 'equity', name: 'Stocks', kind: 'trading', description: '', accent: '#5b8def', status: 'active', sort_order: 10, meta: {} },
      { id: 'dom-p', slug: 'prediction', name: 'Predictions', kind: 'trading', description: '', accent: '#c084fc', status: 'active', sort_order: 20, meta: {} },
    ],
    stewards: [
      { id: 's-live', domain_id: 'dom-l', agent_id: 'agent-g', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: 'current' },
      { id: 's-ended', domain_id: 'dom-p', agent_id: 'agent-g', is_primary: true, assigned_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-09-01T00:00:00.000Z', note: 'rotated' },
      { id: 's-eq', domain_id: 'dom-e', agent_id: 'agent-q', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      { id: 's-pm', domain_id: 'dom-p', agent_id: 'agent-o', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
    ],
    accounts: [
      { id: 'acct-1', domain_id: 'dom-e', account_key: 'robinhood_agentic_7638', label: 'Robinhood Agentic ···7638', currency: 'USD', status: 'active' },
    ],
  });
}

describe('desk team mapping', () => {
  test('keeps current stewards only and never invents marks', () => {
    const team = ledgerTeam();
    expect(team.stewards.map((row) => row.id)).toEqual(['s-live', 's-eq', 's-pm']);
    expect(team.stewards.every((row) => row.ended_at === null)).toBe(true);
    const cards = teamCards(team);
    expect(cards.map((row) => row.slug)).toEqual(['grasshopper', 'quantanamo', 'oddsborne']);
    expect(cards.find((row) => row.slug === 'grasshopper')?.domains.map((row) => row.name)).toEqual(['Ledger']);
    expect(cards.find((row) => row.slug === 'quantanamo')?.domains[0]?.name).toBe('Stocks');
    expect(cards.find((row) => row.slug === 'quantanamo')?.domains[0]?.accounts[0]?.label).toBe('Robinhood Agentic ···7638');
    expect(cards.find((row) => row.slug === 'oddsborne')?.domains.map((row) => row.name)).toEqual(['Predictions']);
    for (const card of cards) {
      expect(card).not.toHaveProperty('mark');
      expect(card).not.toHaveProperty('pnl');
      expect(card).not.toHaveProperty('nav');
    }
  });

  test('falls back to identity roster when team tables are empty', () => {
    const empty = assembleTeam(emptyTeam());
    expect(empty.agents.map((row) => row.slug)).toEqual(['grasshopper', 'quantanamo', 'oddsborne']);
    expect(empty.agents.every((row) => row.heartbeat_at === null)).toBe(true);
    expect(empty.accounts).toEqual([]);
    expect(empty.agents.every((row) => row.meta.source === 'fallback')).toBe(true);
    expect(deskTeam({}).agents).toHaveLength(3);
    expect(fallbackTeam().domains.map((row) => row.name)).toEqual(['Ledger', 'Stocks', 'Predictions']);
  });

  test('heartbeat glow is only for a recent ledger timestamp', () => {
    expect(isHeartbeatFresh('2026-09-06T13:23:04.000Z', now)).toBe(true);
    expect(isHeartbeatFresh('2026-09-06T12:00:00.000Z', now)).toBe(false);
    expect(isHeartbeatFresh(null, now)).toBe(false);
    expect(HEARTBEAT_FRESH_MS).toBe(15 * 60 * 1000);
    expect(clipCharter('short')).toBe('short');
    expect(clipCharter('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});
