import { describe, expect, test } from 'bun:test';

import { AVATAR_COLORS } from './desk-team';
import type { DeskTeamPayload, OntologyThemeRow, ThesisRow } from './ledger-types';
import {
  assembleThesisDistricts,
  buildingForThesis,
  districtForThesis,
  districtPlace,
  districtPlaceWord,
  isLiveThesis,
  thesisStewardAccent,
  thesisStewardSlug,
} from './thesis-districts';

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
      {
        id: 'agent-o',
        slug: 'oddsborne',
        display_name: 'ODDSBORNE',
        role_title: 'Prediction markets trader',
        charter: '',
        accent: '#3b82f6',
        avatar_key: 'odds',
        status: 'active',
        heartbeat_at: AT,
        sort_order: 3,
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
      {
        id: 'dom-p',
        slug: 'prediction',
        name: 'Predictions',
        kind: 'trading',
        description: '',
        accent: '#c084fc',
        status: 'active',
        sort_order: 20,
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
      {
        id: 's-o',
        domain_id: 'dom-p',
        agent_id: 'agent-o',
        is_primary: true,
        assigned_at: AT,
        ended_at: null,
        note: null,
      },
    ],
    accounts: [],
  };
}

describe('thesis districts', () => {
  test('a live theme with one thesis is a small district, not a fake city', () => {
    const districts = assembleThesisDistricts({
      theses: [
        thesis('neocloud_compute', {
          name: 'Neocloud and GPU compute burst basket',
          summary: 'Capacity and financing move the names.',
        }),
      ],
      ontology_themes: [
        theme('neocloud_compute', {
          name: 'Neocloud and GPU compute',
          description: 'GPU cloud capacity and data centers.',
        }),
        theme('neocloud', { kind: 'concept', thesis_id: null, name: 'Neocloud' }),
      ],
      team: team(),
    });
    expect(districts).toHaveLength(1);
    expect(districts[0]).toMatchObject({
      id: 'neocloud_compute',
      name: 'Neocloud and GPU compute',
      source: 'theme',
      place: 'campus',
    });
    expect(districts[0]?.buildings).toHaveLength(1);
    expect(districts[0]?.buildings[0]).toMatchObject({
      id: 'neocloud_compute',
      name: 'Neocloud and GPU compute burst basket',
      steward: 'quantanamo',
    });
    expect(districts[0]?.buildings[0]).not.toHaveProperty('nav');
    expect(districts[0]?.buildings[0]).not.toHaveProperty('win_rate');
    expect(districts[0]?.buildings[0]).not.toHaveProperty('fills');
    expect(districts.some((row) => row.id === 'neocloud')).toBe(false);
  });

  test('energy and neocloud stay separate districts', () => {
    const districts = assembleThesisDistricts({
      theses: [
        thesis('neocloud_compute', { name: 'Neocloud basket' }),
        thesis('ai_power_nuclear', { name: 'AI power bottleneck beneficiaries' }),
      ],
      ontology_themes: [
        theme('neocloud_compute', { name: 'Neocloud and GPU compute' }),
        theme('ai_power_nuclear', { name: 'AI power bottleneck beneficiaries' }),
      ],
    });
    expect(districts.map((row) => row.id)).toEqual(['ai_power_nuclear', 'neocloud_compute']);
    expect(districts.find((row) => row.id === 'ai_power_nuclear')?.place).toBe('plant');
    expect(districts.find((row) => row.id === 'neocloud_compute')?.place).toBe('campus');
    expect(districts.every((row) => row.buildings.length === 1)).toBe(true);
  });

  test('empty snapshot is honest empty — no fake buildings', () => {
    expect(assembleThesisDistricts({ theses: [], ontology_themes: [] })).toEqual([]);
    expect(assembleThesisDistricts({
      theses: [thesis('gone', { status: 'killed' })],
      ontology_themes: [theme('gone', { name: 'Gone' })],
    })).toEqual([]);
    expect(assembleThesisDistricts({
      theses: [],
      ontology_themes: [theme('neocloud_compute', { name: 'Neocloud and GPU compute' })],
    })).toEqual([]);
  });

  test('rejected and concept-only rows do not invent a neighborhood', () => {
    const districts = assembleThesisDistricts({
      theses: [
        thesis('quantum', { status: 'rejected' }),
        thesis('crypto', { status: 'forming', name: 'Crypto optionality' }),
      ],
      ontology_themes: [
        theme('quantum', { name: 'Quantum computing' }),
        theme('crypto', { name: 'Crypto and decentralized AI' }),
        theme('nuclear', { kind: 'concept', thesis_id: null, name: 'Nuclear energy' }),
      ],
    });
    expect(districts.map((row) => row.id)).toEqual(['crypto']);
    expect(districts[0]?.buildings[0]?.id).toBe('crypto');
  });

  test('an orphan live thesis is its own district under the thesis name', () => {
    const districts = assembleThesisDistricts({
      theses: [
        thesis('earnings_gap_structure', {
          name: 'Earnings gap structure and missed-swing autopsy',
          summary: 'Large RTH/AH gaps after earnings have a repeating shape.',
        }),
        thesis('neocloud_compute', { name: 'Neocloud basket' }),
      ],
      ontology_themes: [theme('neocloud_compute', { name: 'Neocloud and GPU compute' })],
    });
    expect(districts.map((row) => row.source)).toEqual(['theme', 'thesis']);
    const orphan = districts.find((row) => row.id === 'earnings_gap_structure');
    expect(orphan?.name).toBe('Earnings gap structure and missed-swing autopsy');
    expect(orphan?.source).toBe('thesis');
    expect(orphan?.buildings).toHaveLength(1);
  });

  test('steward color follows the thesis venue, not a made-up paint', () => {
    expect(thesisStewardSlug(['equity'])).toBe('quantanamo');
    expect(thesisStewardSlug(['prediction'])).toBe('oddsborne');
    expect(thesisStewardSlug(['meme'])).toBe('bandit');
    expect(thesisStewardAccent(['equity'])).toBe(AVATAR_COLORS.green);
    const painted = assembleThesisDistricts({
      theses: [thesis('pm_row', { venues: ['prediction'], name: 'A prediction thesis' })],
      ontology_themes: [],
      team: team(),
    });
    expect(painted[0]?.buildings[0]?.accent).toBe(AVATAR_COLORS.blue);
    expect(painted[0]?.buildings[0]?.steward).toBe('oddsborne');
  });

  test('place massing reads live theme tokens', () => {
    expect(districtPlace('neocloud_compute', 'Neocloud and GPU compute')).toBe('campus');
    expect(districtPlace('ai_power_nuclear', 'AI power bottleneck beneficiaries')).toBe('plant');
    expect(districtPlace('defense_drones_space', 'Defense, drones, and space')).toBe('hangar');
    expect(districtPlace('quantum', 'Quantum computing')).toBe('lab');
    expect(districtPlace('earnings_gap_structure', 'Earnings gap structure')).toBe('yard');
    expect(districtPlaceWord('campus')).toBe('CAMPUS');
    expect(districtPlaceWord('plant')).toBe('POWER');
    expect(isLiveThesis(thesis('x'))).toBe(true);
    expect(isLiveThesis(thesis('x', { status: 'killed' }))).toBe(false);
  });

  test('lookup helpers find the building without inventing ids', () => {
    const districts = assembleThesisDistricts({
      theses: [thesis('semis_photonics', { name: 'Photonics second derivative' })],
      ontology_themes: [theme('semis_photonics', { name: 'Semiconductors and photonics' })],
    });
    expect(districtPlace('semis_photonics', 'Semiconductors and photonics')).toBe('lab');
    expect(districtForThesis(districts, 'semis_photonics')?.place).toBe('lab');
    expect(buildingForThesis(districts, 'semis_photonics')?.name).toBe('Photonics second derivative');
    expect(buildingForThesis(districts, 'missing')).toBeUndefined();
  });
});
