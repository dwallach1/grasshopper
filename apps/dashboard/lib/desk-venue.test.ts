import { describe, expect, test } from 'bun:test';

import {
  lotKey,
  matchesVenueFilter,
  rowVenue,
  thesisMatchesVenue,
  VENUE_FILTERS,
  venueLabel,
  venueShort,
} from './desk-venue';

describe('desk venue chips', () => {
  test('labels stay one-desk language, not a second app', () => {
    expect(venueLabel('equity')).toBe('QUANTANAMO');
    expect(venueLabel('prediction')).toBe('ODDSBORNE');
    expect(venueShort('equity')).toBe('STOCKS');
    expect(venueShort('prediction')).toBe('PREDICTIONS');
    expect(VENUE_FILTERS.map((item) => item.short)).toEqual(['All', 'STOCKS', 'PREDICTIONS']);
    expect(VENUE_FILTERS.map((item) => item.label)).toEqual(['All', 'STOCKS', 'PREDICTIONS']);
    expect(lotKey('prediction', 'YES · sample')).toBe('prediction:YES · sample');
  });

  test('missing venue defaults to equities', () => {
    expect(rowVenue({})).toBe('equity');
    expect(rowVenue({ venue: 'prediction' })).toBe('prediction');
    expect(matchesVenueFilter('equity', 'all')).toBe(true);
    expect(matchesVenueFilter('prediction', 'equity')).toBe(false);
    expect(thesisMatchesVenue(['prediction'], 'prediction')).toBe(true);
    expect(thesisMatchesVenue(undefined, 'equity')).toBe(true);
    expect(thesisMatchesVenue(['prediction'], 'equity')).toBe(false);
  });
});
