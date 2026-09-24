import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isJunkOntologyLabel,
  leanPendingCandidates,
  ONTOLOGY_JUNK_LABELS,
  ONTOLOGY_THEME_THESIS_ALIASES,
  ONTOLOGY_THEME_THESIS_UNALIASED,
  ontologyThemeThesisAlias,
  parseReviewRequest,
  REVIEW_QUEUE_CAP,
  reviewHttpError,
  reviewThesisHint,
  suggestedThesisId,
} from './candidate-review';
import type { OntologyCandidateRow, OntologyThemeRow, ThesisRow } from './ledger-types';

const AT = '2026-09-13T12:00:00.000Z';

function junkLabelsFromSql(sql: string): string[] {
  const start = sql.indexOf('create or replace function private.ontology_label_is_junk');
  expect(start).toBeGreaterThan(-1);
  const next = sql.indexOf('create or replace function', start + 1);
  const block = next === -1 ? sql.slice(start) : sql.slice(start, next);
  const match = block.match(/v in \(([\s\S]*?)\)\s*\n\s*or exists/);
  expect(match).toBeTruthy();
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((row) => row[1]);
}

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
    const singleSource = leanPendingCandidates([
      candidate(453, { candidate_type: 'term', proposed_label: 'photonics', score: 95, source_count: 2 }),
      candidate(5328, { candidate_type: 'membership', proposed_label: 'AVGO', score: 100, source_count: 1 }),
    ]);
    expect(singleSource.map((row) => row.proposed_label)).toEqual(['AVGO', 'photonics']);
    expect(singleSource[0]?.source_count).toBe(1);
    expect(isJunkOntologyLabel('https t.co')).toBe(true);
    expect(isJunkOntologyLabel('POPULAR', 'membership')).toBe(true);
    expect(isJunkOntologyLabel('VARCHAR', 'membership')).toBe(true);
    expect(isJunkOntologyLabel('Another', 'theme')).toBe(true);
    expect(isJunkOntologyLabel('since', 'term')).toBe(true);
    expect(isJunkOntologyLabel('awaited quarters', 'term')).toBe(true);
    expect(isJunkOntologyLabel('avgo cien', 'term')).toBe(true);
    expect(isJunkOntologyLabel('IREN MRVL', 'term')).toBe(true);
    expect(isJunkOntologyLabel('NVDA', 'membership')).toBe(false);
    expect(isJunkOntologyLabel('nuclear', 'theme')).toBe(false);
    expect(isJunkOntologyLabel('inference', 'term')).toBe(false);
    expect(isJunkOntologyLabel('scarcity', 'term')).toBe(false);
    expect(isJunkOntologyLabel('neocloud', 'term')).toBe(false);
    expect(isJunkOntologyLabel('further')).toBe(true);
    expect(isJunkOntologyLabel('sso')).toBe(true);
    expect(isJunkOntologyLabel('cuda')).toBe(true);
    expect(REVIEW_QUEUE_CAP).toBe(40);
  });

  test('resolves unlinked concept themes through the stable alias map', () => {
    const live = [
      thesis('neocloud_compute', { name: 'Neocloud and GPU compute' }),
      thesis('ai_power_nuclear', { name: 'AI power bottleneck beneficiaries' }),
      thesis('semis_photonics', { name: 'Semiconductors and photonics' }),
      thesis('crypto', { name: 'Crypto and decentralized AI' }),
      thesis('earnings_gap_structure', { name: 'Earnings gap structure' }),
    ];
    const themes = [
      theme('neocloud'),
      theme('neocloud_compute', { thesis_id: 'neocloud_compute', kind: 'theme' }),
      theme('nuclear', { name: 'Nuclear energy' }),
      theme('ai_power', { name: 'AI power' }),
      theme('ai_power_nuclear', { thesis_id: 'ai_power_nuclear', kind: 'theme' }),
      theme('photonics'),
      theme('semis_photonics', { thesis_id: 'semis_photonics', kind: 'theme' }),
      theme('crypto_ai', { name: 'Crypto AI' }),
      theme('crypto', { thesis_id: 'crypto', kind: 'theme' }),
      theme('earnings_events', { name: 'Earnings events' }),
      theme('earnings_gap_structure', { thesis_id: 'earnings_gap_structure', kind: 'theme' }),
      theme('ipo_events', { name: 'IPO events' }),
    ];
    expect(ontologyThemeThesisAlias('neocloud')).toBe('neocloud_compute');
    expect(ontologyThemeThesisAlias('nuclear')).toBe('ai_power_nuclear');
    expect(ontologyThemeThesisAlias('ai_power')).toBe('ai_power_nuclear');
    expect(ontologyThemeThesisAlias('photonics')).toBe('semis_photonics');
    expect(ontologyThemeThesisAlias('crypto_ai')).toBe('crypto');
    expect(ontologyThemeThesisAlias('earnings_events')).toBe('earnings_gap_structure');
    expect(ontologyThemeThesisAlias('ipo_events')).toBeNull();
    expect(ONTOLOGY_THEME_THESIS_UNALIASED).toEqual(['ipo_events']);
    expect(suggestedThesisId(
      candidate(1, { proposed_theme_id: 'neocloud', proposed_label: 'SNDK' }),
      themes,
      live,
    )).toBe('neocloud_compute');
    expect(suggestedThesisId(
      candidate(2, { proposed_theme_id: 'nuclear', proposed_label: 'GEV' }),
      themes,
      live,
    )).toBe('ai_power_nuclear');
    expect(suggestedThesisId(
      candidate(3, { proposed_theme_id: 'ai_power', proposed_label: 'VST' }),
      themes,
      live,
    )).toBe('ai_power_nuclear');
    expect(suggestedThesisId(
      candidate(4, { proposed_theme_id: 'photonics', proposed_label: 'DOCN' }),
      themes,
      live,
    )).toBe('semis_photonics');
    expect(suggestedThesisId(
      candidate(5, { proposed_theme_id: 'crypto_ai', proposed_label: 'TAO-USD' }),
      themes,
      live,
    )).toBe('crypto');
    expect(suggestedThesisId(
      candidate(6, { proposed_theme_id: 'earnings_events', proposed_label: 'DG' }),
      themes,
      live,
    )).toBe('earnings_gap_structure');
    expect(suggestedThesisId(
      candidate(7, { proposed_theme_id: 'ipo_events', proposed_label: 'Files', candidate_type: 'theme' }),
      themes,
      live,
    )).toBeNull();
    expect(reviewThesisHint(
      candidate(1, { proposed_theme_id: 'neocloud', proposed_label: 'SNDK' }),
      themes,
      live,
    )).toBe('Unlinked concept · fits Neocloud and GPU compute');
    expect(reviewThesisHint(
      candidate(7, { proposed_theme_id: 'ipo_events', proposed_label: 'Files', candidate_type: 'theme' }),
      themes,
      live,
    )).toBeNull();
    expect(suggestedThesisId(
      candidate(8, { proposed_theme_id: 'photonics', proposed_label: 'DOCN' }),
      [theme('photonics', { thesis_id: 'quantum' }), theme('semis_photonics', { thesis_id: 'semis_photonics', kind: 'theme' })],
      [thesis('quantum', { name: 'Quantum computing' }), ...live],
    )).toBe('quantum');
    expect(suggestedThesisId(
      candidate(9, { proposed_theme_id: 'semis_photonics', proposed_label: 'DOCN' }),
      [theme('semis_photonics', { thesis_id: 'semis_photonics', kind: 'theme' })],
      live,
    )).toBe('semis_photonics');
    expect(suggestedThesisId(
      candidate(10, { proposed_theme_id: null, proposed_label: 'Semiconductors and photonics' }),
      [],
      live,
    )).toBe('semis_photonics');
    expect(reviewThesisHint(
      candidate(11, { candidate_type: 'term', proposed_theme_id: 'photonics', proposed_label: 'https' }),
      themes,
      live,
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
    const migration = await readFile(
      join(import.meta.dir, '../../../supabase/migrations/20260924180000_ontology_junk_it_acronyms.sql'),
      'utf8',
    );
    expect(sql).toContain('private.ontology_label_is_junk');
    expect(sql).toContain("review_note = 'junk_deny_list'");
    expect(sql).toContain("v ~ '^[a-z]{2,5}( [a-z]{2,5})+$'");
    expect(migration).toContain("v ~ '^[a-z]{2,5}( [a-z]{2,5})+$'");
    for (const source of [sql, migration]) {
      expect(junkLabelsFromSql(source)).toEqual([...ONTOLOGY_JUNK_LABELS]);
    }
  });

  test('SQL alias map stays in sync with the documented pairs', async () => {
    const sql = await readFile(join(import.meta.dir, '../../../supabase/schemas/07_ontology_review.sql'), 'utf8');
    const migration = await readFile(
      join(import.meta.dir, '../../../supabase/migrations/20260914234500_ontology_theme_thesis_alias.sql'),
      'utf8',
    );
    for (const source of [sql, migration]) {
      expect(source).toContain('private.ontology_theme_thesis_alias');
      expect(source).toContain('v_alias := private.ontology_theme_thesis_alias(v_theme_id)');
      expect(source).not.toMatch(/when 'ipo_events' then/);
      for (const [from, to] of Object.entries(ONTOLOGY_THEME_THESIS_ALIASES)) {
        expect(source).toContain(`when '${from}' then '${to}'`);
      }
    }
  });
});
