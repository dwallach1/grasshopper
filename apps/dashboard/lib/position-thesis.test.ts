import { describe, expect, test } from 'bun:test';

import {
  CONSERVATIVE_POSITION_THESIS_BACKFILL,
  HISTORICAL_UNTAGGED,
  SYNC_MISSING_THESIS,
  bindPositionThesisWrite,
  isConservativeLaxWeatherSlug,
  leanUntagged,
  positionThesisGate,
  unambiguousThesisId,
} from './position-thesis';

describe('position thesis write gate', () => {
  test('new lots need thesis_id or an explicit untagged reason', () => {
    expect(positionThesisGate({ thesis_id: 'earnings_gap_structure' })).toEqual({
      ok: true,
      thesis_id: 'earnings_gap_structure',
      untagged: null,
    });
    expect(positionThesisGate({
      thesis_id: null,
      meta: { untagged: 'paper_lot' },
    })).toEqual({
      ok: true,
      thesis_id: null,
      untagged: 'paper_lot',
    });
    expect(positionThesisGate({ thesis_id: '  ', meta: { untagged: '' } }).ok).toBe(false);
    expect(leanUntagged({ untagged: 'historical' })).toBe(HISTORICAL_UNTAGGED);
    expect(leanUntagged({ meta: { untagged: 'paper_lot' } })).toBe('paper_lot');
    expect(leanUntagged({ untagged: '  ', meta: { untagged: 'historical' } })).toBe(HISTORICAL_UNTAGGED);
    expect(leanUntagged({})).toBeNull();
  });

  test('write path keeps a thesis, else stamps sync_missing_thesis', () => {
    expect(bindPositionThesisWrite({
      thesis_id: 'weather_same_day_high',
      existing_thesis_id: null,
      existing_meta: { untagged: HISTORICAL_UNTAGGED },
    })).toEqual({
      thesis_id: 'weather_same_day_high',
      meta: {},
    });
    expect(bindPositionThesisWrite({
      existing_thesis_id: 'earnings_gap_structure',
      meta: { note: 'mark refresh' },
    })).toEqual({
      thesis_id: 'earnings_gap_structure',
      meta: { note: 'mark refresh' },
    });
    expect(bindPositionThesisWrite({ thesis_id: null })).toEqual({
      thesis_id: null,
      meta: { untagged: SYNC_MISSING_THESIS },
    });
  });

  test('unambiguous thesis is one symbol match; multi-thesis names stay skipped', () => {
    const theses = [
      { id: 'neocloud_compute', symbols: ['CIFR', 'NBIS'] },
      { id: 'semis_photonics', symbols: ['NBIS'] },
      { id: 'earnings_gap_structure', symbols: ['CODA'] },
    ];
    expect(unambiguousThesisId('CODA', theses)).toBe('earnings_gap_structure');
    expect(unambiguousThesisId('CIFR', theses)).toBe('neocloud_compute');
    expect(unambiguousThesisId('NBIS', theses)).toBeNull();
    expect(unambiguousThesisId('NONE', theses)).toBeNull();
  });

  test('conservative backfill map is CODA + LAX weather only', () => {
    expect(CONSERVATIVE_POSITION_THESIS_BACKFILL).toEqual([
      { venue: 'equity', match: 'CODA', thesis_id: 'earnings_gap_structure' },
      { venue: 'prediction', match: 'tc-temp-laxhigh-', thesis_id: 'weather_same_day_high' },
    ]);
    expect(isConservativeLaxWeatherSlug('tc-temp-laxhigh-2026-09-13-gte76lt77f')).toBe(true);
    expect(isConservativeLaxWeatherSlug('tc-temp-mdwhigh-2026-09-09-lt80f')).toBe(false);
    expect(isConservativeLaxWeatherSlug('rdc-usfed-fomc-2026-09-16-hike25')).toBe(false);
  });
});
