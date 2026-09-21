import { describe, expect, test } from 'bun:test';

import { PLAYBOOK_RULE_KIND, type BeliefUpdateRow } from './beliefs';
import { MARK_NOT_IN_LEDGER } from './book-performance';
import { fallbackTeam } from './desk-team';
import type { DeskPayload, LessonRow } from './ledger-types';
import { assembleBeliefsInForce, assembleTaggedLots, singleTaggedThesisId } from './learning-inspect';
import { BANDIT_PRIMARY_ACCOUNT } from './meme-book';

const AT = '2026-09-16T20:00:00.000Z';

function lesson(id: number, extra: Partial<LessonRow> = {}): LessonRow {
  return {
    id,
    cycle_id: 1,
    test_id: null,
    thesis_id: extra.thesis_id ?? 'earnings_gap_structure',
    lesson_type: extra.lesson_type ?? 'structure',
    summary: extra.summary ?? `lesson ${id}`,
    market_regime: null,
    incorporated: extra.incorporated ?? false,
    created_at: extra.created_at ?? AT,
  };
}

function belief(extra: Partial<BeliefUpdateRow> = {}): BeliefUpdateRow {
  return {
    id: extra.id ?? 'b-gap',
    thesis_id: extra.thesis_id ?? 'earnings_gap_structure',
    domain_id: extra.domain_id ?? 'fallback-equity',
    agent_id: extra.agent_id ?? null,
    prior_confidence: extra.prior_confidence ?? 82,
    new_confidence: extra.new_confidence ?? 84,
    rationale: extra.rationale ?? 'No chase leftovers.',
    observed_at: extra.observed_at ?? AT,
    kind: extra.kind ?? PLAYBOOK_RULE_KIND,
    rules: extra.rules ?? ['no_chase_already_printed_leftovers'],
    steward: extra.steward ?? 'quantanamo',
    research_lesson_id: extra.research_lesson_id ?? null,
  };
}

function desk(partial: Record<string, unknown> = {}): DeskPayload {
  return {
    generated_at: AT,
    snapshots: [],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: AT,
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
          symbol: 'CODA',
          quantity: 250,
          average_cost: 10.1,
          cost: 2525,
          mark: 11.2,
          pnl: 275,
          note: '',
          venue: 'equity',
        },
      ],
    },
    positions: [{
      id: 'ep-coda',
      account_key: 'agentic-7638',
      symbol: 'CODA',
      status: 'open',
      quantity: 250,
      average_cost: 10.1,
      opened_at: AT,
      closed_at: null,
      next_review_at: null,
      thesis_id: 'earnings_gap_structure',
    }],
    theses: [{
      id: 'earnings_gap_structure',
      name: 'Earnings gap structure',
      summary: '',
      status: 'hardening',
      confidence: 70,
      time_horizon: 'days_to_weeks',
      stance: 'bullish',
      variant_perception: null,
      falsifier: null,
      created_at: AT,
      updated_at: AT,
      symbols: ['CODA'],
      lots: [],
    }, {
      id: 'weather_same_day_high',
      name: 'Same-day city-high weather',
      summary: '',
      status: 'hardening',
      confidence: 70,
      time_horizon: 'hours',
      stance: 'bullish',
      variant_perception: null,
      falsifier: null,
      created_at: AT,
      updated_at: AT,
      symbols: [],
      lots: [],
    }],
    exposures: [],
    fills: [],
    intents: [],
    beliefs: [
      belief({ research_lesson_id: '12', rationale: 'old in playbook' }),
      belief({
        id: 'b-weather',
        thesis_id: 'weather_same_day_high',
        domain_id: 'fallback-prediction',
        observed_at: '2026-09-15T20:00:00.000Z',
        rationale: 'Kill into a no-bid close.',
        research_lesson_id: null,
      }),
    ],
    lessons: [
      lesson(37),
      lesson(12, {
        incorporated: true,
        summary: 'old in playbook',
        created_at: '2026-09-01T00:00:00.000Z',
      }),
    ],
    team: fallbackTeam(),
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
    ...partial,
  } as unknown as DeskPayload;
}

describe('assembleBeliefsInForce', () => {
  test('shows rationale, thesis id+title, and the live lot that binds the rule', () => {
    const rows = assembleBeliefsInForce(desk());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'b-gap',
      thesis_id: 'earnings_gap_structure',
      thesis_name: 'Earnings gap structure',
      from_lesson: true,
      rationale: null,
      holdings: [{ id: 'eq:CODA', name: 'CODA' }],
    });
    expect(rows[1]).toMatchObject({
      id: 'b-weather',
      thesis_id: 'weather_same_day_high',
      thesis_name: 'Same-day city-high weather',
      from_lesson: false,
      rationale: 'Kill into a no-bid close.',
      holdings: [],
    });
  });

  test('keeps rationale when the linked lesson is off the parchment queue', () => {
    const rows = assembleBeliefsInForce(desk({
      lessons: [lesson(37)],
      beliefs: [belief({
        research_lesson_id: '3',
        rationale: 'Quantum breakout signals have not survived.',
      })],
    }));
    expect(rows).toEqual([expect.objectContaining({
      from_lesson: false,
      rationale: 'Quantum breakout signals have not survived.',
    })]);
  });

  test('missing beliefs stay empty — does not invent a rule', () => {
    expect(assembleBeliefsInForce(desk({ beliefs: [] }))).toEqual([]);
  });
});

describe('assembleTaggedLots', () => {
  test('lists the open lot that carries a thesis tag', () => {
    expect(assembleTaggedLots(desk())).toEqual([{
      id: 'eq:CODA',
      name: 'CODA',
      thesis_id: 'earnings_gap_structure',
      thesis_name: 'Earnings gap structure',
    }]);
  });

  test('closed and untagged lives stay off the tagged-lot parchment', () => {
    expect(assembleTaggedLots(desk({
      book: {
        account_label: 'robinhood_agentic_7638',
        observed_at: AT,
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
      positions: [{
        id: 'ep-cifr',
        account_key: 'agentic-7638',
        symbol: 'CIFR',
        status: 'closed',
        quantity: 10,
        average_cost: 12,
        opened_at: AT,
        closed_at: AT,
        next_review_at: null,
        thesis_id: 'earnings_gap_structure',
      }],
      prediction_markets: {
        desk: 'ODDSBORNE',
        venue: 'prediction',
        markets: [],
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
          mark_at: AT,
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
          last_marked_at: AT,
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
          mark_at: AT,
          thesis_text: null,
        }],
        orders: [],
        fills: [],
        pnl: [],
        notes: [],
      },
    }))).toEqual([]);
  });
});

describe('singleTaggedThesisId', () => {
  test('one tagged lot yields that thesis for the pulse chip', () => {
    expect(singleTaggedThesisId(desk())).toBe('earnings_gap_structure');
  });

  test('two lots on the same thesis still yield that one id', () => {
    const base = desk();
    expect(singleTaggedThesisId(desk({
      book: {
        ...base.book,
        names: [
          ...base.book.names,
          {
            symbol: 'APP',
            quantity: 10,
            average_cost: 1,
            cost: 10,
            mark: 1,
            pnl: 0,
            note: '',
            venue: 'equity',
          },
        ],
      },
      positions: [
        ...(base.positions ?? []),
        {
          id: 'ep-app',
          account_key: 'agentic-7638',
          symbol: 'APP',
          status: 'open',
          quantity: 10,
          average_cost: 1,
          opened_at: AT,
          closed_at: null,
          next_review_at: null,
          thesis_id: 'earnings_gap_structure',
        },
      ],
    }))).toBe('earnings_gap_structure');
  });

  test('two tagged theses skip the pulse chip', () => {
    const base = desk();
    expect(singleTaggedThesisId(desk({
      book: {
        ...base.book,
        names: [
          ...base.book.names,
          {
            symbol: 'APP',
            quantity: 10,
            average_cost: 1,
            cost: 10,
            mark: 1,
            pnl: 0,
            note: '',
            venue: 'equity',
          },
        ],
      },
      positions: [
        ...(base.positions ?? []),
        {
          id: 'ep-app',
          account_key: 'agentic-7638',
          symbol: 'APP',
          status: 'open',
          quantity: 10,
          average_cost: 1,
          opened_at: AT,
          closed_at: null,
          next_review_at: null,
          thesis_id: 'weather_same_day_high',
        },
      ],
    }))).toBeNull();
  });

  test('no tagged lot yields none', () => {
    expect(singleTaggedThesisId(desk({ positions: [] }))).toBeNull();
  });
});
