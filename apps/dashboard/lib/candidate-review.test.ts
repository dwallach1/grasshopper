import { describe, expect, test } from 'bun:test';

import {
  leanPendingCandidates,
  parseReviewRequest,
  REVIEW_QUEUE_CAP,
  reviewHttpError,
  suggestedThesisId,
} from './candidate-review';
import type { OntologyCandidateRow, OntologyThemeRow, ThesisRow } from './ledger-types';

const AT = '2026-09-13T12:00:00.000Z';

function candidate(id: number, extra: Partial<OntologyCandidateRow> = {}): OntologyCandidateRow {
  return {
    id,
    candidate_type: extra.candidate_type ?? 'membership',
    candidate_key: extra.candidate_key ?? `k${id}`,
    proposed_theme_id: extra.proposed_theme_id === undefined ? 'photonics' : extra.proposed_theme_id,
    proposed_label: extra.proposed_label ?? 'DOCN',
    proposed_description: extra.proposed_description ?? 'ledger row',
    score: extra.score ?? 80,
    evidence_count: extra.evidence_count ?? 2,
    source_count: extra.source_count ?? 2,
    status: extra.status ?? 'pending',
    last_seen_at: extra.last_seen_at ?? AT,
    review_note: extra.review_note ?? null,
  };
}

function theme(id: string, extra: Partial<OntologyThemeRow> = {}): OntologyThemeRow {
  return {
    id,
    thesis_id: extra.thesis_id === undefined ? null : extra.thesis_id,
    kind: extra.kind ?? 'concept',
    name: extra.name ?? id,
    description: extra.description ?? '',
    status: extra.status ?? 'active',
    match_threshold: extra.match_threshold ?? 35,
    auto_promote_sources: extra.auto_promote_sources ?? 3,
  };
}

function thesis(id: string, extra: Partial<ThesisRow> = {}): ThesisRow {
  return {
    id,
    name: extra.name ?? id,
    summary: extra.summary ?? id,
    status: extra.status ?? 'hardening',
    confidence: extra.confidence ?? 70,
    time_horizon: extra.time_horizon ?? 'days_to_weeks',
    stance: extra.stance ?? 'bullish',
    variant_perception: extra.variant_perception ?? null,
    falsifier: extra.falsifier ?? null,
    created_at: extra.created_at ?? AT,
    updated_at: extra.updated_at ?? AT,
    symbols: extra.symbols ?? [],
    lots: extra.lots ?? [],
  };
}

describe('ontology candidate review queue', () => {
  test('keeps pending high-score rows and does not invent scores', () => {
    const rows = [
      candidate(1, { score: 40, source_count: 9, status: 'pending' }),
      candidate(2, { score: 100, source_count: 2, status: 'pending' }),
      candidate(3, { score: 99, source_count: 8, status: 'promoted' }),
      candidate(4, { score: 100, source_count: 5, status: 'pending' }),
    ];
    const queue = leanPendingCandidates(rows, 2);
    expect(queue.map((row) => row.id)).toEqual([4, 2]);
    expect(queue[0]?.score).toBe(100);
    expect(queue[1]?.score).toBe(100);
    expect(REVIEW_QUEUE_CAP).toBe(40);
  });

  test('suggests an existing thesis on the proposed theme, never a new id', () => {
    const theses = [thesis('semis_photonics', { name: 'Semiconductors and photonics' })];
    expect(suggestedThesisId(
      candidate(1, { proposed_theme_id: 'photonics', proposed_label: 'DOCN' }),
      [theme('photonics'), theme('semis_photonics', { thesis_id: 'semis_photonics', kind: 'theme' })],
      theses,
    )).toBeNull();
    expect(suggestedThesisId(
      candidate(2, { proposed_theme_id: 'semis_photonics', proposed_label: 'DOCN' }),
      [theme('semis_photonics', { thesis_id: 'semis_photonics', kind: 'theme' })],
      theses,
    )).toBe('semis_photonics');
    expect(suggestedThesisId(
      candidate(3, { proposed_theme_id: null, proposed_label: 'Semiconductors and photonics' }),
      [],
      theses,
    )).toBe('semis_photonics');
  });

  test('parses operator review bodies and rejects invented actions', () => {
    expect(parseReviewRequest({
      candidate_id: 4667,
      action: 'Promote',
      thesis_id: 'semis_photonics',
    })).toEqual({
      candidate_id: 4667,
      action: 'promote',
      thesis_id: 'semis_photonics',
      note: null,
    });
    expect(parseReviewRequest({ candidate_id: 1, action: 'blacklist' })).toBeNull();
    expect(parseReviewRequest({ candidate_id: 1.5, action: 'reject' })).toBeNull();
    expect(reviewHttpError('thesis_required')).toMatchObject({ status: 400 });
    expect(reviewHttpError('not_operator').status).toBe(403);
  });
});
