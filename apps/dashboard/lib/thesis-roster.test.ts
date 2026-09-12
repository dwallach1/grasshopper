import { describe, expect, test } from 'bun:test';

import { AVATAR_COLORS } from './desk-team';
import type { DeskTeamPayload, OntologyThemeRow, ThesisEvidenceRow, ThesisRow } from './ledger-types';
import {
  assembleThesisRoster,
  isLiveThesis,
  thesisDomainLabel,
  thesisForId,
  thesisStewardAccent,
  thesisStewardSlug,
} from './thesis-roster';

const AT = '2026-09-08T16:00:00.000Z';

function thesis(id: string, extra: Partial<ThesisRow> = {}): ThesisRow {
  return {
    id,
    name: extra.name ?? id,
    summary: extra.summary ?? `${id} sentence`,
    status: extra.status ?? 'hardening',
    confidence: extra.confidence ?? 70,
    time_horizon: extra.time_horizon ?? 'medium',
    stance: extra.stance ?? 'bullish',
    variant_perception: extra.variant_perception ?? null,
    falsifier: extra.falsifier ?? null,
    created_at: extra.created_at ?? AT,
    updated_at: extra.updated_at ?? AT,
    symbols: extra.symbols ?? [],
    lots: extra.lots ?? [],
    venues: extra.venues,
  };
}

function theme(id: string, extra: Partial<OntologyThemeRow> = {}): OntologyThemeRow {
  return {
    id,
    thesis_id: extra.thesis_id === undefined ? id : extra.thesis_id,
    kind: extra.kind ?? 'theme',
    name: extra.name ?? id,
    description: extra.description ?? '',
    status: extra.status ?? 'active',
    match_threshold: extra.match_threshold ?? 30,
    auto_promote_sources: extra.auto_promote_sources ?? 3,
  };
}

function team(): DeskTeamPayload {
  return {
    agents: [
      {
        id: 'agent-q',
        slug: 'quantanamo',
        display_name: 'QUANTANAMO',
        role_title: 'Equities trader',
        charter: '',
        accent: '#22c55e',
        avatar_key: 'quant',
        status: 'active',
        heartbeat_at: AT,
        sort_order: 2,
        meta: {},
      },
    ],
    domains: [
      {
        id: 'dom-e',
        slug: 'equity',
        name: 'Stocks',
        kind: 'trading',
        description: '',
        accent: '#5b8def',
        status: 'active',
        sort_order: 10,
        meta: {},
      },
    ],
    stewards: [
      {
        id: 's-q',
        domain_id: 'dom-e',
        agent_id: 'agent-q',
        is_primary: true,
        assigned_at: AT,
        ended_at: null,
        note: null,
      },
    ],
    accounts: [],
  };
}

function evidence(thesisId: string, extra: Partial<ThesisEvidenceRow> = {}): ThesisEvidenceRow {
  return {
    id: extra.id ?? 1,
    thesis_id: thesisId,
    evidence_type: extra.evidence_type ?? 'note',
    direction: extra.direction ?? 'supporting',
    summary: extra.summary ?? 'A ledger note.',
    source_url: extra.source_url ?? null,
    confidence: extra.confidence ?? 60,
    created_at: extra.created_at ?? AT,
  };
}

describe('thesis roster', () => {
  test('lists ledger theses with stance, status, domain, and steward — no book facts', () => {
    const roster = assembleThesisRoster({
      theses: [
        thesis('neocloud_compute', {
          name: 'Neocloud and GPU compute burst basket',
          summary: 'Capacity and financing move the names.',
          stance: 'long',
          confidence: 72,
        }),
      ],
      ontology_themes: [
        theme('neocloud_compute', { name: 'Neocloud and GPU compute' }),
        theme('neocloud', { kind: 'concept', thesis_id: null, name: 'Neocloud' }),
      ],
      team: team(),
      evidence: [evidence('neocloud_compute', { summary: 'GPU rents are sticky.' })],
    });
    expect(roster.rows).toHaveLength(1);
    expect(roster.rows[0]).toMatchObject({
      id: 'neocloud_compute',
      name: 'Neocloud and GPU compute burst basket',
      stance: 'long',
      status: 'hardening',
      confidence: 72,
      domain: 'Neocloud and GPU compute',
      steward: 'quantanamo',
      steward_name: 'QUANTANAMO',
      live: true,
    });
    expect(roster.rows[0]?.evidence).toEqual([
      expect.objectContaining({ summary: 'GPU rents are sticky.' }),
    ]);
    expect(roster.rows[0]).not.toHaveProperty('nav');
    expect(roster.rows[0]).not.toHaveProperty('win_rate');
    expect(roster.rows[0]).not.toHaveProperty('lots');
    expect(roster.rows[0]).not.toHaveProperty('buildings');
    expect(roster.rows[0]).not.toHaveProperty('place');
  });

  test('killed theses stay on the list as historic; empty ledger is empty', () => {
    const roster = assembleThesisRoster({
      theses: [
        thesis('quantum', { status: 'rejected', name: 'Quantum' }),
        thesis('crypto', { status: 'forming', name: 'Crypto optionality' }),
      ],
      ontology_themes: [theme('crypto', { name: 'Crypto and decentralized AI' })],
      evidence: [],
    });
    expect(roster.rows.map((row) => row.id)).toEqual(['crypto', 'quantum']);
    expect(roster.rows[0]?.live).toBe(true);
    expect(roster.rows[1]?.live).toBe(false);
    expect(assembleThesisRoster({ theses: [], ontology_themes: [], evidence: [] }).rows).toEqual([]);
  });

  test('orphan thesis uses steward domain, not a made-up theme', () => {
    const roster = assembleThesisRoster({
      theses: [thesis('earnings_gap_structure', { name: 'Earnings gap structure' })],
      ontology_themes: [],
      evidence: [],
    });
    expect(roster.rows[0]?.domain).toBe('Stocks');
    expect(thesisDomainLabel(thesis('pm_row', { venues: ['prediction'] }))).toBe('Predictions');
  });

  test('steward color follows the thesis venue', () => {
    expect(thesisStewardSlug(['equity'])).toBe('quantanamo');
    expect(thesisStewardSlug(['prediction'])).toBe('oddsborne');
    expect(thesisStewardSlug(['meme'])).toBe('bandit');
    expect(thesisStewardAccent(['equity'])).toBe(AVATAR_COLORS.green);
    const painted = assembleThesisRoster({
      theses: [thesis('pm_row', { venues: ['prediction'], name: 'A prediction thesis' })],
      ontology_themes: [],
      team: team(),
      evidence: [],
    });
    expect(painted.rows[0]?.steward).toBe('oddsborne');
    expect(painted.rows[0]?.steward_name).toBe('ODDSBORNE');
    expect(thesisForId(painted.rows, 'pm_row')?.name).toBe('A prediction thesis');
    expect(thesisForId(painted.rows, 'missing')).toBeUndefined();
    expect(isLiveThesis(thesis('x'))).toBe(true);
    expect(isLiveThesis(thesis('x', { status: 'killed' }))).toBe(false);
  });
});
