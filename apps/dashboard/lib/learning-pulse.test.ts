import { describe, expect, test } from 'bun:test';

import { PLAYBOOK_RULE_KIND } from './beliefs';
import { MARK_NOT_IN_LEDGER } from './book-performance';
import { fallbackTeam } from './desk-team';
import type { BeliefUpdateRow } from './beliefs';
import type { DeskPayload, LessonRow, OntologyCandidateRow } from './ledger-types';
import {
  assembleLearningPulse,
  formatLearningPulse,
  learningPulseSummary,
} from './learning-pulse';
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

function candidate(id: number, extra: Partial<OntologyCandidateRow> = {}): OntologyCandidateRow {
  return {
    id,
    candidate_type: extra.candidate_type ?? 'membership',
    candidate_key: extra.candidate_key ?? `mem:${id}`,
    proposed_theme_id: extra.proposed_theme_id ?? 'photonics',
    proposed_label: extra.proposed_label ?? `SYM${id}`,
    proposed_description: extra.proposed_description ?? '',
    score: extra.score ?? 80,
    evidence_count: extra.evidence_count ?? 1,
    source_count: extra.source_count ?? 1,
    status: extra.status ?? 'pending',
    last_seen_at: extra.last_seen_at ?? AT,
    review_note: extra.review_note ?? null,
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
    }],
    exposures: [],
    fills: [],
    intents: [],
    beliefs: [
      belief(),
      belief({
        id: 'b-weather',
        thesis_id: 'weather_same_day_high',
        domain_id: 'fallback-prediction',
        observed_at: '2026-09-15T20:00:00.000Z',
      }),
      belief({
        id: 'b-older-gap',
        thesis_id: 'earnings_gap_structure',
        observed_at: '2026-09-01T00:00:00.000Z',
        rules: ['stale_rule'],
      }),
      belief({
        id: 'b-trail',
        thesis_id: 'earnings_gap_structure',
        kind: 'confidence',
        rules: [],
        observed_at: '2026-09-16T21:00:00.000Z',
      }),
    ],
    lessons: [
      lesson(37),
      lesson(36, { created_at: '2026-09-10T20:28:50.000Z' }),
      lesson(12, { incorporated: true, created_at: '2026-09-01T00:00:00.000Z' }),
    ],
    ontology_candidates: [
      candidate(4667, { proposed_label: 'DOCN', score: 100 }),
      candidate(351, { proposed_label: 'https', candidate_type: 'term', score: 95 }),
      candidate(9, { status: 'promoted', proposed_label: 'old' }),
    ],
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
        last_marked_at: AT,
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
    team: fallbackTeam(),
    ...partial,
  } as unknown as DeskPayload;
}

describe('assembleLearningPulse', () => {
  test('counts To-review, lessons, beliefs in force, and tagged open books from desk fields', () => {
    const pulse = assembleLearningPulse(desk());
    expect(pulse).toEqual({
      to_review: 1,
      lessons_open: 2,
      lessons_incorporated: 1,
      beliefs_in_force: 2,
      open_books: 4,
      open_books_tagged: 1,
    });
    expect(formatLearningPulse(pulse)).toBe(
      '1 to review · 2 open / 1 in playbook · 2 beliefs in force · 1 of 4 open books tagged',
    );
    expect(learningPulseSummary(pulse)).toEqual(pulse);
  });

  test('To-review matches the ranked queue cap and drops junk, not the grind backlog', () => {
    const rows = Array.from({ length: 45 }, (_, index) => candidate(index + 1, {
      proposed_label: `MEM${index + 1}`,
      score: 100 - index,
    }));
    rows.push(candidate(900, { proposed_label: 'stocks', candidate_type: 'term' }));
    const pulse = assembleLearningPulse(desk({ ontology_candidates: rows }));
    expect(pulse.to_review).toBe(40);
  });

  test('missing pulse arrays stay zero — does not invent coverage', () => {
    const pulse = assembleLearningPulse(desk({
      beliefs: [],
      lessons: [],
      ontology_candidates: [],
      positions: [],
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
    }));
    expect(pulse).toEqual({
      to_review: 0,
      lessons_open: 0,
      lessons_incorporated: 0,
      beliefs_in_force: 0,
      open_books: 0,
      open_books_tagged: 0,
    });
    expect(formatLearningPulse(pulse)).toBe(
      '0 to review · 0 open / 0 in playbook · 0 beliefs in force · no open books',
    );
  });

  test('singular belief copy; closed lots do not count as open-book coverage', () => {
    const pulse = assembleLearningPulse(desk({
      beliefs: [belief()],
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
    }));
    expect(pulse.beliefs_in_force).toBe(1);
    expect(pulse.open_books).toBe(0);
    expect(pulse.open_books_tagged).toBe(0);
    expect(formatLearningPulse(pulse)).toContain('1 belief in force');
    expect(formatLearningPulse(pulse)).toContain('no open books');
  });
});
