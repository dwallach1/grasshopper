import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isJunkOntologyLabel,
  leanPendingCandidates,
  ONTOLOGY_JUNK_LABELS,
  parseReviewRequest,
  REVIEW_QUEUE_CAP,
  reviewHttpError,
  reviewThesisHint,
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
  test('prefers memberships over terms and drops deny-list junk', () => {
    const rows = [
      candidate(351, { candidate_type: 'term', proposed_label: 'https', score: 95, source_count: 3 }),
      candidate(448, { candidate_type: 'term', proposed_label: 'price', score: 95, source_count: 2 }),
      candidate(1771, { candidate_type: 'term', proposed_label: 'power', score: 84, source_count: 5 }),
      candidate(4667, { candidate_type: 'membership', proposed_label: 'DOCN', score: 100, source_count: 2 }),
      candidate(458, { candidate_type: 'membership', proposed_label: 'AEHR', score: 100, source_count: 2 }),
      candidate(3, { score: 99, source_count: 8, status: 'promoted' }),
    ];
    const queue = leanPendingCandidates(rows, 3);
    expect(queue.map((row) => row.proposed_label)).toEqual(['DOCN', 'AEHR', 'power']);
    expect(queue[0]?.score).toBe(100);
    expect(queue.every((row) => row.status === 'pending')).toBe(true);
    expect(isJunkOntologyLabel('https t.co')).toBe(true);
    expect(isJunkOntologyLabel('POPULAR', 'membership')).toBe(true);
    expect(REVIEW_QUEUE_CAP).toBe(40);
  });

  test('suggests an existing thesis on the proposed theme, never a new id', () => {
    const theses = [thesis('semis_photonics', { name: 'Semiconductors and photonics' })];
    expect(suggestedThesisId(
      candidate(1, { proposed_theme_id: 'photonics', proposed_label: 'DOCN' }),
      [theme('photonics'), theme('semis_photonics', { thesis_id: 'semis_photonics', kind: 'theme' })],
      theses,
    )).toBe('semis_photonics');
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
    expect(reviewThesisHint(
      candidate(1, { proposed_theme_id: 'photonics', proposed_label: 'DOCN' }),
      [theme('photonics'), theme('semis_photonics', { thesis_id: 'semis_photonics', kind: 'theme' })],
      theses,
    )).toBe('Unlinked concept · fits Semiconductors and photonics');
    expect(reviewThesisHint(
      candidate(9, { candidate_type: 'term', proposed_theme_id: 'photonics', proposed_label: 'https' }),
      [theme('photonics')],
      theses,
    )).toBeNull();
    expect(suggestedThesisId(
      candidate(4, { proposed_theme_id: 'nuclear', proposed_label: 'GEV' }),
      [theme('nuclear', { name: 'Nuclear energy' })],
      [thesis('ai_power_nuclear', { name: 'AI power bottleneck beneficiaries' })],
    )).toBe('ai_power_nuclear');
    expect(suggestedThesisId(
      candidate(5, { proposed_theme_id: 'ipo_events', proposed_label: 'Files', candidate_type: 'theme' }),
      [theme('ipo_events', { name: 'IPO events' })],
      theses,
    )).toBeNull();
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

  test('SQL deny-list stays in sync with the documented labels', async () => {
    const sql = await readFile(join(import.meta.dir, '../../../supabase/schemas/07_ontology_review.sql'), 'utf8');
    expect(sql).toContain('private.ontology_label_is_junk');
    expect(sql).toContain("review_note = 'junk_deny_list'");
    for (const label of ONTOLOGY_JUNK_LABELS) {
      expect(sql).toContain(`'${label}'`);
    }
  });
});
