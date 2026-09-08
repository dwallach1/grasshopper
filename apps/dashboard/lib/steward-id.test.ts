import { describe, expect, test } from 'bun:test';

import { assembleTeam, emptyTeam, fallbackTeam } from './desk-team';
import { stewardDomainFace, stewardIdCards, stewardSlugFace } from './steward-id';

function ledgerRoster() {
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
        charter: 'Polymarket US.',
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
        charter: 'Owns meme-coin research.',
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
      { id: 's-l', domain_id: 'dom-l', agent_id: 'agent-g', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      { id: 's-e', domain_id: 'dom-e', agent_id: 'agent-q', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      { id: 's-p', domain_id: 'dom-p', agent_id: 'agent-o', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      { id: 's-m', domain_id: 'dom-m', agent_id: 'agent-b', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
    ],
    accounts: [],
  });
}

describe('steward ID card face', () => {
  test('maps venue names to the four card domains and skips Ledger', () => {
    expect(stewardDomainFace('equity', 'Stocks')).toBe('Stocks');
    expect(stewardDomainFace('prediction', 'Predictions')).toBe('Predictions');
    expect(stewardDomainFace('meme', 'Meme coins')).toBe('Coins');
    expect(stewardDomainFace('crypto', 'Crypto')).toBe('Crypto');
    expect(stewardDomainFace('ledger', 'Ledger')).toBeNull();
    expect(stewardSlugFace('quantanamo')).toBe('Stocks');
    expect(stewardSlugFace('oddsborne')).toBe('Predictions');
    expect(stewardSlugFace('bandit')).toBe('Coins');
    expect(stewardSlugFace('cointanamo')).toBe('Crypto');
    expect(stewardSlugFace('grasshopper')).toBeNull();
  });

  test('paints ledger stewards only — empty roster is honest empty', () => {
    const cards = stewardIdCards({ team: ledgerRoster() });
    expect(cards.map((row) => row.slug)).toEqual(['quantanamo', 'oddsborne', 'bandit']);
    expect(cards.map((row) => row.domain)).toEqual(['Stocks', 'Predictions', 'Coins']);
    expect(cards.some((row) => row.slug === 'grasshopper')).toBe(false);
    expect(stewardIdCards({})).toEqual([]);
    expect(stewardIdCards({ team: emptyTeam() })).toEqual([]);
    expect(stewardIdCards({ team: { agents: [], domains: [], stewards: [], accounts: [] } })).toEqual([]);
    expect(stewardIdCards({ team: fallbackTeam() })).toEqual([]);
    expect(stewardIdCards({ team: assembleTeam(emptyTeam()) })).toEqual([]);
  });

  test('includes COINTANAMO only when that slug is on the roster', () => {
    const without = stewardIdCards({ team: ledgerRoster() });
    expect(without.some((row) => row.slug === 'cointanamo')).toBe(false);
    const withCoin = assembleTeam({
      ...ledgerRoster(),
      agents: [
        ...ledgerRoster().agents,
        {
          id: 'agent-c',
          slug: 'cointanamo',
          display_name: 'COINTANAMO',
          role_title: 'Crypto trader',
          charter: 'Crypto book.',
          accent: '#94a3b8',
          avatar_key: 'spark',
          status: 'active',
          heartbeat_at: null,
          sort_order: 5,
          meta: {},
        },
      ],
      domains: [
        ...ledgerRoster().domains,
        { id: 'dom-c', slug: 'crypto', name: 'Crypto', kind: 'trading', description: '', accent: '#94a3b8', status: 'active', sort_order: 40, meta: {} },
      ],
      stewards: [
        ...ledgerRoster().stewards,
        { id: 's-c', domain_id: 'dom-c', agent_id: 'agent-c', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      ],
    });
    const cards = stewardIdCards({ team: withCoin });
    expect(cards.map((row) => row.slug)).toEqual(['quantanamo', 'oddsborne', 'bandit', 'cointanamo']);
    expect(cards.find((row) => row.slug === 'cointanamo')?.domain).toBe('Crypto');
  });

  test('card face has no book or board facts', () => {
    const card = stewardIdCards({ team: ledgerRoster() })[0];
    expect(card).toEqual({
      slug: 'quantanamo',
      display_name: 'QUANTANAMO',
      domain: 'Stocks',
      accent: expect.any(String),
    });
    expect(card).not.toHaveProperty('win_rate');
    expect(card).not.toHaveProperty('hold');
    expect(card).not.toHaveProperty('size');
    expect(card).not.toHaveProperty('nav');
    expect(card).not.toHaveProperty('pnl');
    expect(card).not.toHaveProperty('heartbeat_at');
    expect(card).not.toHaveProperty('charter');
    expect(card).not.toHaveProperty('role_title');
  });
});
