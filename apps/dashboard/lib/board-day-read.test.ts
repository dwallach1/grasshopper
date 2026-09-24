import { describe, expect, test } from 'bun:test';

import { age } from '../app/terminal/format';
import { PLAYBOOK_RULE_KIND, type BeliefUpdateRow } from './beliefs';
import { assembleBoardDayRead, freshnessAge } from './board-day-read';
import { MARK_NOT_IN_LEDGER } from './book-performance';
import { assembleTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';

const NOW = Date.parse('2026-09-06T13:24:00.000Z');
const READ_AT = '2026-09-06T13:23:30.000Z';
const FRESH = '2026-09-06T13:10:00.000Z';
const NEWER = '2026-09-06T13:22:00.000Z';

function team() {
  return assembleTeam({
    agents: [
      agent('agent-g', 'grasshopper', 'GRASSHOPPER', 'active', 1),
      agent('agent-q', 'quantanamo', 'QUANTANAMO', 'active', 2),
      agent('agent-o', 'oddsborne', 'ODDSBORNE', 'active', 3),
      agent('agent-b', 'bandit', 'BANDIT', 'idle', 4),
    ],
    domains: [],
    stewards: [],
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
    heartbeat_at: null,
    sort_order: sort,
    meta: {},
  };
}

function belief(id: string, kind: string, thesisId: string): BeliefUpdateRow {
  return {
    id,
    thesis_id: thesisId,
    domain_id: 'dom-e',
    agent_id: null,
    prior_confidence: null,
    new_confidence: null,
    rationale: 'ledger rule',
    observed_at: FRESH,
    kind,
    rules: ['no_chase'],
    steward: 'quantanamo',
    research_lesson_id: null,
  };
}

function desk(partial: Partial<DeskPayload> = {}): DeskPayload {
  const fixture = {
    generated_at: READ_AT,
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: FRESH,
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
    positions: [],
    exposures: [],
    fills: [],
    intents: [],
    fill_log: [],
    beliefs: [],
    lessons: [],
    theses: [],
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
  // SAFETY: fixture only fills the ledger fields the day-read reads.
  return fixture as DeskPayload;
}

function openLot(symbol: string, status: string) {
  return {
    id: `pos-${symbol}`,
    account_key: 'robinhood',
    symbol,
    status,
    quantity: 10,
    average_cost: 4,
    opened_at: FRESH,
    closed_at: status === 'closed' ? FRESH : null,
    next_review_at: null,
    thesis_id: 'earnings_gap_structure',
    untagged: null,
  };
}

describe('assembleBoardDayRead', () => {
  test('assembles open books, beliefs in force, posture, newest mark, and the desk read', () => {
    const read = assembleBoardDayRead(desk({
      positions: [openLot('CIFR', 'open'), openLot('IREN', 'closed')],
      beliefs: [
        belief('b1', PLAYBOOK_RULE_KIND, 'earnings_gap_structure'),
        belief('b2', 'note', 'other_thesis'),
      ],
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [],
        positions: [],
        orders: [],
        fills: [],
        pnl: [{ as_of: NEWER, equity: 10 }],
        notes: [],
      },
    }), NOW);

    expect(read.lead).toBe('1 book open · 1 belief in force · 1 steward waiting · 2 stewards idle');
    expect(read.stamp).toBe('ODDSBORNE marked 2m ago · desk read 30s ago');
    expect(read.lead).not.toMatch(/[$%]|pnl|profit|score/i);
    expect(read.stamp).not.toMatch(/[$%]|pnl|profit|score/i);
  });

  test('names every steward who shares the newest mark', () => {
    const read = assembleBoardDayRead(desk({
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [],
        positions: [],
        orders: [],
        fills: [],
        pnl: [{ as_of: FRESH, equity: 10 }],
        notes: [],
      },
    }), NOW);
    expect(read.stamp.startsWith('QUANTANAMO and ODDSBORNE marked 14m ago')).toBe(true);
  });

  test('omits the stamp when the read and the marks are missing', () => {
    const read = assembleBoardDayRead(desk({
      generated_at: '',
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
    }), NOW);
    expect(read.lead).toBe('0 books open · 0 beliefs in force · 3 stewards idle');
    expect(read.stamp).toBe('');
  });

  test('omits clock clauses until the Board clock exists', () => {
    const read = assembleBoardDayRead(desk({
      positions: [openLot('CIFR', 'open')],
      beliefs: [belief('b1', PLAYBOOK_RULE_KIND, 'earnings_gap_structure')],
    }), null);
    expect(read.lead).toBe('1 book open · 1 belief in force');
    expect(read.stamp).toBe('');
    expect(read.lead).not.toContain('marked');
    expect(read.lead).not.toContain('steward');
  });

  test('age buckets match the header freshness chip', () => {
    const stamps = [
      '2026-09-07T21:59:30.000Z',
      '2026-09-07T21:40:00.000Z',
      '2026-09-07T18:00:00.000Z',
      '2026-09-04T22:00:00.000Z',
    ];
    const now = Date.parse('2026-09-07T22:00:00.000Z');
    for (const at of stamps) {
      expect(freshnessAge(at, now)).toBe(age(at, now));
    }
    expect(freshnessAge('not-a-time', now)).toBeNull();
  });
});
