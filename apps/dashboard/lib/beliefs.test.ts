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

  test('newest belief keeps a repeated slug; a distinct older slug stays', () => {
    const olderDistinct = belief({
      id: '8e941fc9-62e1-4ddf-80cc-1dc153dfe046',
      observed_at: '2026-09-10T20:30:06.932Z',
      prior_confidence: 78,
      new_confidence: 80,
      meta: {
        kind: PLAYBOOK_RULE_KIND,
        rules: ['soft_rth_confirmation_sector_conditional', 'no_chase_already_printed_leftovers'],
        steward: 'quantanamo',
      },
    });
    const sameSlugOlder = belief({
      id: '11111111-1111-4111-8111-111111111111',
      observed_at: AT,
      meta: {
        kind: PLAYBOOK_RULE_KIND,
        rules: ['no_chase_already_printed_leftovers'],
        steward: 'quantanamo',
        research_lesson_id: 1,
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
    const rules = assemblePlaybookRules(mapBeliefs([olderDistinct, sameSlugOlder, belief(), weather]));
    const gap = rules.filter((row) => row.thesis_id === 'earnings_gap_structure');
    expect(gap.map((row) => row.id)).toEqual([
      '645c3ea2-eb0d-4b4b-b329-7ac69b302ff1',
      olderDistinct.id,
    ]);
    expect(gap[0]?.rules).toEqual([
      'no_chase_already_printed_leftovers',
      'ignored_mcap_floor_50_100m',
      'never_pltr',
      'extra_rule',
    ]);
    expect(gap[0]?.new_confidence).toBe(84);
    expect(gap[0]?.research_lesson_id).toBe('36');
    expect(gap[1]?.rules).toEqual(['soft_rth_confirmation_sector_conditional']);
    expect(rules.find((row) => row.id === sameSlugOlder.id)).toBeUndefined();
    expect(rules.find((row) => row.thesis_id === 'weather_same_day_high')?.rules).toEqual([
      'mid_ge_0.70_half_or_trail',
    ]);
  });

  test('rules in force keep process slugs and append kill or negative_result', () => {
    const beliefs = mapBeliefs([belief()]);
    expect(rulesInForceFor({
      thesisId: 'earnings_gap_structure',
      domainId: null,
      beliefs,
    })).toEqual([
      'no_chase_already_printed_leftovers',
      'ignored_mcap_floor_50_100m',
      'never_pltr',
      'extra_rule',
    ]);
    expect(rulesInForceFor({
      thesisId: 'earnings_gap_structure',
      domainId: null,
      beliefs,
      cap: 3,
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
      'extra_rule',
    ]);
    expect(rulesInForceFor({
      thesisId: null,
      domainId: null,
      beliefs,
    })).toEqual([]);
    expect(humanizeRule('no_chase_already_printed_leftovers')).toBe('no chase already printed leftovers');
  });

  test('earnings_gap_structure keeps process rules beside lessons 78/79/80', () => {
    const process = [
      ['quality_drawdown_into_print', '2026-09-18T15:00:00.000Z', 'b-quality'],
      ['recycle_over_exact_tp', '2026-09-17T15:00:00.000Z', 'b-recycle'],
      ['residual_bp_watch_only', '2026-09-16T15:00:00.000Z', 'b-residual'],
      ['missed_swing', '2026-09-15T15:00:00.000Z', 'b-missed'],
    ] as const;
    const rows = [
      belief({
        id: 'b-80',
        observed_at: '2026-10-01T18:00:00.000Z',
        prior_confidence: null,
        new_confidence: null,
        rationale: 'Walk-forward autopsy: kill the earnings-gap clip.',
        meta: {
          kind: PLAYBOOK_RULE_KIND,
          rules: ['kill'],
          research_lesson_id: 80,
          lesson_type: 'kill',
        },
      }),
      belief({
        id: 'b-79',
        observed_at: '2026-10-01T17:00:00.000Z',
        prior_confidence: null,
        new_confidence: null,
        rationale: 'Walk-forward autopsy: negative result.',
        meta: {
          kind: PLAYBOOK_RULE_KIND,
          rules: ['negative_result'],
          research_lesson_id: 79,
          lesson_type: 'negative_result',
        },
      }),
      belief({
        id: 'b-78',
        observed_at: '2026-10-01T16:00:00.000Z',
        prior_confidence: null,
        new_confidence: null,
        rationale: 'Earlier negative result, same slug.',
        meta: {
          kind: PLAYBOOK_RULE_KIND,
          rules: ['negative_result'],
          research_lesson_id: 78,
          lesson_type: 'negative_result',
        },
      }),
      ...process.map(([slug, observed_at, id]) => belief({
        id,
        observed_at,
        prior_confidence: null,
        new_confidence: null,
        rationale: slug,
        meta: {
          kind: PLAYBOOK_RULE_KIND,
          rules: [slug],
          research_lesson_id: id,
        },
      })),
      belief(),
    ];
    const beliefs = mapBeliefs(rows);
    const assembled = assemblePlaybookRules(beliefs).filter((row) => row.thesis_id === 'earnings_gap_structure');
    expect(assembled.map((row) => row.id)).toEqual([
      'b-80',
      'b-79',
      'b-quality',
      'b-recycle',
      'b-residual',
      'b-missed',
      '645c3ea2-eb0d-4b4b-b329-7ac69b302ff1',
    ]);
    expect(assembled.find((row) => row.id === 'b-78')).toBeUndefined();
    expect(rulesInForceFor({
      thesisId: 'earnings_gap_structure',
      domainId: null,
      beliefs,
      cap: 3,
    })).toEqual([
      'quality_drawdown_into_print',
      'recycle_over_exact_tp',
      'residual_bp_watch_only',
      'kill',
      'negative_result',
    ]);
    expect(rulesInForceFor({
      thesisId: 'earnings_gap_structure',
      domainId: null,
      beliefs,
    })).toEqual([
      'quality_drawdown_into_print',
      'recycle_over_exact_tp',
      'residual_bp_watch_only',
      'missed_swing',
      'no_chase_already_printed_leftovers',
      'ignored_mcap_floor_50_100m',
      'never_pltr',
      'extra_rule',
      'kill',
      'negative_result',
    ]);
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

  test('closed clip shows the newest lesson and the playbook belief it became', () => {
    const lesson36: LessonRow = {
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
    const lesson62: LessonRow = {
      ...lesson36,
      id: 62,
      lesson_type: 'missed_swing',
      summary: '9/22 leftovers — no chase.',
      incorporated: true,
      created_at: '2026-09-22T23:37:06.642Z',
    };
    const lesson64: LessonRow = {
      ...lesson36,
      id: 64,
      lesson_type: 'process',
      summary: 'No chase after-close 9/22. Hold CODA.',
      incorporated: true,
      created_at: '2026-09-22T23:37:06.642Z',
    };
    const linked = mapBeliefs([belief()]);
    expect(clipNoteFor({
      thesisId: 'earnings_gap_structure',
      beliefs: linked,
      lessons: [lesson36],
    })).toMatchObject({
      kind: 'lesson',
      summary: 'Soft RTH is not confirmation for retail.',
      belief: {
        key: 'belief:645c3ea2-eb0d-4b4b-b329-7ac69b302ff1',
        summary: 'Stocks autopsy run 141: FEIM leftover already printed — no chase.',
      },
    });
    const incorporated = mapBeliefs([
      belief({
        id: 'e8781d9e-ef2c-4215-8d6b-e4b5b4fd7f19',
        observed_at: '2026-09-23T17:47:46.732Z',
        rationale: '9/22 leftovers became the playbook.',
        meta: {
          kind: PLAYBOOK_RULE_KIND,
          rules: ['missed_swing'],
          research_lesson_id: 62,
        },
      }),
      belief({
        id: '60ed9cb3-be49-4b16-9180-a487e7b1b12d',
        observed_at: '2026-09-22T17:51:16.377Z',
        rationale: 'older playbook stays off the clip',
        meta: { kind: PLAYBOOK_RULE_KIND, rules: ['missed_swing'], research_lesson_id: 58 },
      }),
    ]);
    expect(clipNoteFor({
      thesisId: 'earnings_gap_structure',
      beliefs: incorporated,
      lessons: [lesson62, lesson64],
    })).toMatchObject({
      key: 'lesson:64',
      kind: 'lesson',
      summary: 'No chase after-close 9/22. Hold CODA.',
      belief: {
        key: 'belief:e8781d9e-ef2c-4215-8d6b-e4b5b4fd7f19',
        summary: '9/22 leftovers became the playbook.',
      },
    });
    const cited = mapBeliefs([
      belief({
        id: 'newer-other',
        observed_at: '2026-09-23T17:47:46.732Z',
        rationale: 'newer rule cites a different lesson',
        meta: { kind: PLAYBOOK_RULE_KIND, rules: ['process'], research_lesson_id: 99 },
      }),
      belief(),
    ]);
    expect(clipNoteFor({
      thesisId: 'earnings_gap_structure',
      beliefs: cited,
      lessons: [lesson36],
    })?.belief?.key).toBe('belief:645c3ea2-eb0d-4b4b-b329-7ac69b302ff1');
    const unlinked = mapBeliefs([belief({
      meta: { kind: PLAYBOOK_RULE_KIND, rules: ['missed_swing'] },
    })]);
    expect(clipNoteFor({
      thesisId: 'earnings_gap_structure',
      beliefs: unlinked,
      lessons: [lesson36],
    })?.belief?.summary).toContain('FEIM leftover');
    const plain = mapBeliefs([belief({ meta: { kind: 'belief' } })]);
    expect(clipNoteFor({
      thesisId: 'earnings_gap_structure',
      beliefs: plain,
      lessons: [lesson36],
    })).toMatchObject({ kind: 'lesson', belief: null });
    expect(clipNoteFor({
      thesisId: 'earnings_gap_structure',
      beliefs: linked,
      lessons: [],
    })).toMatchObject({ kind: 'belief', belief: null });
    expect(clipNoteFor({ thesisId: 'orphan', beliefs: linked, lessons: [] })).toBeNull();
    expect(clipNoteFor({ thesisId: null, beliefs: linked, lessons: [lesson36] })).toBeNull();
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
