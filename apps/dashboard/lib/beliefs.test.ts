import { describe, expect, test } from 'bun:test';

import {
  assemblePlaybookRules,
  beliefTrailFor,
  clipNoteFor,
  domainIdForSteward,
  humanizeRule,
  isPlaybookRule,
  mapBeliefs,
  PLAYBOOK_RULE_KIND,
  rulesInForceFor,
  thesisForHolding,
  truncateRationale,
} from './beliefs';
import { fallbackTeam } from './desk-team';
import type { LessonRow, ThesisRow } from './ledger-types';

const AT = '2026-09-11T21:06:12.917Z';

function belief(partial: Record<string, unknown> = {}) {
  return {
    id: '645c3ea2-eb0d-4b4b-b329-7ac69b302ff1',
    thesis_id: 'earnings_gap_structure',
    domain_id: '271d5741-8058-4273-a28f-aa0961c0152d',
    agent_id: '0fcc2b6b-3bbf-486c-adca-f0649bcbae50',
    prior_confidence: '82',
    new_confidence: '84',
    rationale: '\nStocks autopsy run 141: FEIM leftover already printed — no chase.',
    observed_at: AT,
    meta: {
      kind: PLAYBOOK_RULE_KIND,
      rules: ['no_chase_already_printed_leftovers', 'ignored_mcap_floor_50_100m', 'never_pltr', 'extra_rule'],
      steward: 'quantanamo',
      research_lesson_id: 36,
    },
    ...partial,
  };
}

function thesis(id: string, extra: Partial<ThesisRow> = {}): ThesisRow {
  return {
    id,
    name: extra.name ?? id,
    summary: extra.summary ?? '',
    status: extra.status ?? 'hardening',
    confidence: extra.confidence ?? 70,
    time_horizon: extra.time_horizon ?? 'medium',
    stance: extra.stance ?? 'bullish',
    variant_perception: null,
    falsifier: null,
    created_at: AT,
    updated_at: AT,
    symbols: extra.symbols ?? [],
    lots: extra.lots ?? [],
    venues: extra.venues,
  };
}

describe('belief mapping', () => {
  test('coerces playbook_rule meta and keeps confidence numeric', () => {
    const [row] = mapBeliefs([belief()]);
    expect(row).toMatchObject({
      thesis_id: 'earnings_gap_structure',
      prior_confidence: 82,
      new_confidence: 84,
      kind: PLAYBOOK_RULE_KIND,
      steward: 'quantanamo',
      research_lesson_id: '36',
    });
    expect(row?.rules).toEqual([
      'no_chase_already_printed_leftovers',
      'ignored_mcap_floor_50_100m',
      'never_pltr',
      'extra_rule',
    ]);
    expect(isPlaybookRule(row!)).toBe(true);
    expect(row?.rationale).toContain('FEIM leftover');
  });

  test('newest playbook_rule per thesis/domain wins; older siblings drop', () => {
    const older = belief({
      id: '8e941fc9-62e1-4ddf-80cc-1dc153dfe046',
      observed_at: '2026-09-10T20:30:06.932Z',
      prior_confidence: 78,
      new_confidence: 80,
      meta: {
        kind: PLAYBOOK_RULE_KIND,
        rules: ['soft_rth_confirmation_sector_conditional'],
        steward: 'quantanamo',
      },
    });
    const weather = belief({
      id: '93686adc-37f6-41cf-9d47-5b12e8ef8852',
      thesis_id: 'weather_same_day_high',
      domain_id: '2cd36bf1-5630-44d3-97df-27bf2ab0e683',
      observed_at: '2026-09-10T18:34:37.282Z',
      prior_confidence: 72,
      new_confidence: 78,
      meta: {
        kind: PLAYBOOK_RULE_KIND,
        rules: ['mid_ge_0.70_half_or_trail'],
        steward: 'oddsborne',
      },
    });
    const rules = assemblePlaybookRules(mapBeliefs([older, belief(), weather]));
    expect(rules).toHaveLength(2);
    expect(rules[0]?.thesis_id).toBe('earnings_gap_structure');
    expect(rules[0]?.new_confidence).toBe(84);
    expect(rules[0]?.rules[0]).toBe('no_chase_already_printed_leftovers');
    expect(rules[1]?.thesis_id).toBe('weather_same_day_high');
    expect(rules.find((row) => row.id === older.id)).toBeUndefined();
  });

  test('rules in force are at most three ledger slugs; missing thesis is empty', () => {
    const beliefs = mapBeliefs([belief()]);
    expect(rulesInForceFor({
      thesisId: 'earnings_gap_structure',
      domainId: null,
      beliefs,
    })).toEqual([
      'no_chase_already_printed_leftovers',
      'ignored_mcap_floor_50_100m',
      'never_pltr',
    ]);
    expect(rulesInForceFor({
      thesisId: 'missing',
      domainId: null,
      beliefs,
    })).toEqual([]);
    expect(rulesInForceFor({
      thesisId: 'neocloud_compute',
      domainId: '271d5741-8058-4273-a28f-aa0961c0152d',
      beliefs,
    })).toEqual([]);
    expect(rulesInForceFor({
      thesisId: null,
      domainId: '271d5741-8058-4273-a28f-aa0961c0152d',
      beliefs,
    })).toEqual([
      'no_chase_already_printed_leftovers',
      'ignored_mcap_floor_50_100m',
      'never_pltr',
    ]);
    expect(humanizeRule('no_chase_already_printed_leftovers')).toBe('no chase already printed leftovers');
  });

  test('trail truncates rationale and stays newest-first', () => {
    const long = 'x'.repeat(200);
    const trail = beliefTrailFor('earnings_gap_structure', mapBeliefs([
      belief({ id: 'b-old', observed_at: '2026-09-09T20:49:57.799Z', rationale: 'older move' }),
      belief({ rationale: long }),
    ]));
    expect(trail).toHaveLength(2);
    expect(trail[0]?.id).toBe('645c3ea2-eb0d-4b4b-b329-7ac69b302ff1');
    expect(trail[0]?.rationale.endsWith('…')).toBe(true);
    expect(trail[0]?.rationale.length).toBeLessThanOrEqual(181);
    expect(truncateRationale('  short  ')).toBe('short');
  });

  test('closed clip prefers a linked lesson; else the newest belief; never invents', () => {
    const lesson: LessonRow = {
      id: 36,
      cycle_id: 1,
      test_id: null,
      thesis_id: 'earnings_gap_structure',
      lesson_type: 'autopsy',
      summary: 'Soft RTH is not confirmation for retail.',
      market_regime: null,
      incorporated: false,
      created_at: '2026-09-10T20:31:00.000Z',
    };
    expect(clipNoteFor({
      thesisId: 'earnings_gap_structure',
      beliefs: mapBeliefs([belief()]),
      lessons: [lesson],
    })).toMatchObject({ kind: 'lesson', summary: 'Soft RTH is not confirmation for retail.' });
    expect(clipNoteFor({
      thesisId: 'earnings_gap_structure',
      beliefs: mapBeliefs([belief()]),
      lessons: [],
    })?.kind).toBe('belief');
    expect(clipNoteFor({ thesisId: 'orphan', beliefs: mapBeliefs([belief()]), lessons: [] })).toBeNull();
    expect(clipNoteFor({ thesisId: null, beliefs: mapBeliefs([belief()]), lessons: [lesson] })).toBeNull();
  });

  test('holding thesis prefers an explicit id, then a held lot, then a symbol list', () => {
    const theses = [
      thesis('neocloud_compute', {
        name: 'Neocloud',
        symbols: ['NBIS', 'CIFR'],
        lots: [{
          symbol: 'NBIS',
          side: 'buy',
          quantity: 4,
          average_cost: 200,
          invested: 800,
          mark: 220,
          pnl: 80,
          note: '',
        }],
      }),
      thesis('semis_photonics', { name: 'Semis', symbols: ['NBIS'] }),
    ];
    expect(thesisForHolding(theses, { symbol: 'NBIS' })).toEqual({
      id: 'neocloud_compute',
      name: 'Neocloud',
    });
    expect(thesisForHolding(theses, { symbol: 'CIFR' })?.id).toBe('neocloud_compute');
    expect(thesisForHolding(theses, { symbol: 'WEATHER', thesisId: 'weather_same_day_high' })).toEqual({
      id: 'weather_same_day_high',
      name: 'weather_same_day_high',
    });
    expect(thesisForHolding(theses, { symbol: 'NONE' })).toBeNull();
  });

  test('steward domain follows desk_domains slugs', () => {
    const team = fallbackTeam();
    expect(domainIdForSteward(team, 'quantanamo')).toBe(
      team.domains.find((row) => row.slug === 'equity')?.id ?? null,
    );
    expect(domainIdForSteward(undefined, 'quantanamo')).toBeNull();
  });
});
