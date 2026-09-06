import { describe, expect, test } from 'bun:test';

import {
  assembleTeam,
  AVATAR_COLORS,
  clipCharter,
  deskTeam,
  emptyTeam,
  fallbackTeam,
  HEARTBEAT_FRESH_MS,
  isHeartbeatFresh,
  resolveAvatarChip,
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
      {
        id: 'agent-b',
        slug: 'bandit',
        display_name: 'BANDIT',
        role_title: 'Meme-coin trader',
        charter: 'Owns meme-coin research and execution under Grasshopper.',
        accent: '#f59e0b',
        avatar_key: 'bandit',
        status: 'idle',
        heartbeat_at: null,
        sort_order: 4,
        meta: {},
      },
    ],
    domains: [
      { id: 'dom-l', slug: 'ledger', name: 'Ledger', kind: 'ops', description: '', accent: '#7dd3a7', status: 'active', sort_order: 5, meta: {} },
      { id: 'dom-e', slug: 'equity', name: 'Stocks', kind: 'trading', description: '', accent: '#5b8def', status: 'active', sort_order: 10, meta: {} },
      { id: 'dom-p', slug: 'prediction', name: 'Predictions', kind: 'trading', description: '', accent: '#c084fc', status: 'active', sort_order: 20, meta: {} },
      { id: 'dom-m', slug: 'meme', name: 'Meme coins', kind: 'trading', description: '', accent: '#f59e0b', status: 'active', sort_order: 30, meta: {} },
    ],
    stewards: [
      { id: 's-live', domain_id: 'dom-l', agent_id: 'agent-g', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: 'current' },
      { id: 's-ended', domain_id: 'dom-p', agent_id: 'agent-g', is_primary: true, assigned_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-09-01T00:00:00.000Z', note: 'rotated' },
      { id: 's-eq', domain_id: 'dom-e', agent_id: 'agent-q', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      { id: 's-pm', domain_id: 'dom-p', agent_id: 'agent-o', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      { id: 's-meme', domain_id: 'dom-m', agent_id: 'agent-b', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
    ],
    accounts: [
      { id: 'acct-1', domain_id: 'dom-e', account_key: 'robinhood_agentic_7638', label: 'Robinhood Agentic ···7638', currency: 'USD', status: 'active' },
    ],
  });
}

describe('desk team mapping', () => {
  test('keeps current stewards only and never invents marks', () => {
    const team = ledgerTeam();
    expect(team.stewards.map((row) => row.id)).toEqual(['s-live', 's-eq', 's-pm', 's-meme']);
    expect(team.stewards.every((row) => row.ended_at === null)).toBe(true);
    const cards = teamCards(team);
    expect(cards.map((row) => row.slug)).toEqual(['grasshopper', 'quantanamo', 'oddsborne', 'bandit']);
    expect(cards.find((row) => row.slug === 'grasshopper')?.domains.map((row) => row.name)).toEqual(['Ledger']);
    expect(cards.find((row) => row.slug === 'quantanamo')?.domains[0]?.name).toBe('Stocks');
    expect(cards.find((row) => row.slug === 'quantanamo')?.domains[0]?.accounts[0]?.label).toBe('Robinhood Agentic ···7638');
    expect(cards.find((row) => row.slug === 'oddsborne')?.domains.map((row) => row.name)).toEqual(['Predictions']);
    expect(cards.find((row) => row.slug === 'bandit')?.domains.map((row) => row.name)).toEqual(['Meme coins']);
    expect(cards.find((row) => row.slug === 'bandit')?.avatar_key).toBe('bandit');
    expect(cards.find((row) => row.slug === 'bandit')?.avatar_shape).toBe('pebble');
    expect(cards.find((row) => row.slug === 'bandit')?.accent).toBe(AVATAR_COLORS.red);
    expect(cards.find((row) => row.slug === 'grasshopper')?.avatar_shape).toBe('tablet');
    expect(cards.find((row) => row.slug === 'quantanamo')?.avatar_shape).toBe('blob');
    expect(cards.find((row) => row.slug === 'oddsborne')?.avatar_shape).toBe('wedge');
    for (const card of cards) {
      expect(card).not.toHaveProperty('mark');
      expect(card).not.toHaveProperty('pnl');
      expect(card).not.toHaveProperty('nav');
    }
  });

  test('falls back to identity roster when team tables are empty', () => {
    const empty = assembleTeam(emptyTeam());
    expect(empty.agents.map((row) => row.slug)).toEqual(['grasshopper', 'quantanamo', 'oddsborne', 'bandit']);
    expect(empty.agents.every((row) => row.heartbeat_at === null)).toBe(true);
    expect(empty.accounts).toEqual([]);
    expect(empty.agents.every((row) => row.meta.source === 'fallback')).toBe(true);
    expect(deskTeam({}).agents).toHaveLength(4);
    expect(fallbackTeam().domains.map((row) => row.name)).toEqual(['Ledger', 'Stocks', 'Predictions', 'Meme coins']);
    expect(fallbackTeam().agents.map((row) => row.accent)).toEqual([
      AVATAR_COLORS.brown,
      AVATAR_COLORS.green,
      AVATAR_COLORS.blue,
      AVATAR_COLORS.red,
    ]);
  });

  test('maps avatar_key and ledger meta to Grok Bot chip shapes', () => {
    expect(resolveAvatarChip({ avatar_key: 'grasshopper' })).toEqual({ shape: 'tablet', color: AVATAR_COLORS.brown });
    expect(resolveAvatarChip({ avatar_key: 'quant' })).toEqual({ shape: 'blob', color: AVATAR_COLORS.green });
    expect(resolveAvatarChip({ avatar_key: 'odds' })).toEqual({ shape: 'wedge', color: AVATAR_COLORS.blue });
    expect(resolveAvatarChip({ avatar_key: 'bandit' })).toEqual({ shape: 'pebble', color: AVATAR_COLORS.red });
    expect(resolveAvatarChip({
      avatar_key: 'spark',
      accent: '#94a3b8',
      meta: { avatar_shape: 'wedge', avatar_color: 'blue' },
    })).toEqual({ shape: 'wedge', color: AVATAR_COLORS.blue });
  });

  test('paints every desk_agents row — no three-agent cap', () => {
    const extra = assembleTeam({
      agents: [
        { id: 'a1', slug: 'grasshopper', display_name: 'GRASSHOPPER', role_title: 'Ledger steward', charter: '', accent: '#7dd3a7', avatar_key: 'grasshopper', status: 'active', heartbeat_at: null, sort_order: 1, meta: {} },
        { id: 'a2', slug: 'quantanamo', display_name: 'QUANTANAMO', role_title: 'Equities trader', charter: '', accent: '#5b8def', avatar_key: 'quant', status: 'active', heartbeat_at: null, sort_order: 2, meta: {} },
        { id: 'a3', slug: 'oddsborne', display_name: 'ODDSBORNE', role_title: 'Prediction markets trader', charter: '', accent: '#c084fc', avatar_key: 'odds', status: 'active', heartbeat_at: null, sort_order: 3, meta: {} },
        { id: 'a4', slug: 'bandit', display_name: 'BANDIT', role_title: 'Meme-coin trader', charter: '', accent: '#f59e0b', avatar_key: 'bandit', status: 'idle', heartbeat_at: null, sort_order: 4, meta: {} },
        { id: 'a5', slug: 'newcomer', display_name: 'NEWCOMER', role_title: 'Guest', charter: '', accent: '#94a3b8', avatar_key: 'spark', status: 'away', heartbeat_at: null, sort_order: 50, meta: {} },
      ],
      domains: [
        { id: 'd1', slug: 'meme', name: 'Meme coins', kind: 'trading', description: '', accent: '#f59e0b', status: 'active', sort_order: 30, meta: {} },
      ],
      stewards: [
        { id: 'st', domain_id: 'd1', agent_id: 'a4', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      ],
      accounts: [],
    });
    const cards = teamCards(extra);
    expect(cards).toHaveLength(5);
    expect(cards.map((row) => row.slug)).toEqual(['grasshopper', 'quantanamo', 'oddsborne', 'bandit', 'newcomer']);
    expect(cards.map((row) => row.avatar_shape)).toEqual(['tablet', 'blob', 'wedge', 'pebble', 'spark']);
    expect(cards[3]?.domains[0]?.name).toBe('Meme coins');
    expect(cards[4]?.domains).toEqual([]);
    expect(cards[4]?.accent).toBe('#94a3b8');
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
