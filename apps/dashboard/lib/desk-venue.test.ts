import { describe, expect, test } from 'bun:test';

import {
  lotKey,
  matchesVenueFilter,
  rowVenue,
  thesisMatchesVenue,
  venueLabel,
  venueShort,
} from './desk-venue';

describe('desk venue chips', () => {
  test('labels stay one-desk language, not a second app', () => {
    expect(venueLabel('equity')).toBe('QUANTANAMO');
    expect(venueLabel('prediction')).toBe('ODDSBORNE');
    expect(venueShort('equity')).toBe('EQ');
    expect(venueShort('prediction')).toBe('PM');
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
