import { describe, expect, test } from 'bun:test';

import {
  lotKey,
  matchesVenueFilter,
  rowVenue,
  thesisMatchesVenue,
  thesisVenuesFor,
  VENUE_FILTERS,
  venueLabel,
  venueShort,
} from './desk-venue';

describe('desk venue chips', () => {
  test('labels stay one-desk language, not a second app', () => {
    expect(venueLabel('equity')).toBe('QUANTANAMO');
    expect(venueLabel('prediction')).toBe('ODDSBORNE');
    expect(venueLabel('meme')).toBe('BANDIT');
    expect(venueShort('equity')).toBe('STOCKS');
    expect(venueShort('prediction')).toBe('PREDICTIONS');
    expect(venueShort('meme')).toBe('COINS');
    expect(VENUE_FILTERS.map((item) => item.short)).toEqual(['All', 'STOCKS', 'PREDICTIONS', 'COINS']);
    expect(VENUE_FILTERS.map((item) => item.label)).toEqual(['All', 'STOCKS', 'PREDICTIONS', 'COINS']);
    expect(lotKey('prediction', 'YES · sample')).toBe('prediction:YES · sample');
    expect(lotKey('meme', 'ZDOG')).toBe('meme:ZDOG');
  });

  test('missing venue defaults to equities; meme is not collapsed into stocks', () => {
    expect(rowVenue({})).toBe('equity');
    expect(rowVenue({ venue: 'prediction' })).toBe('prediction');
    expect(rowVenue({ venue: 'meme' })).toBe('meme');
    expect(matchesVenueFilter('equity', 'all')).toBe(true);
    expect(matchesVenueFilter('prediction', 'all')).toBe(true);
    expect(matchesVenueFilter('meme', 'all')).toBe(true);
    expect(matchesVenueFilter('prediction', 'equity')).toBe(false);
    expect(matchesVenueFilter('meme', 'equity')).toBe(false);
    expect(matchesVenueFilter('meme', 'meme')).toBe(true);
    expect(thesisMatchesVenue(['prediction'], 'prediction')).toBe(true);
    expect(thesisMatchesVenue(undefined, 'equity')).toBe(true);
    expect(thesisMatchesVenue(['prediction'], 'equity')).toBe(false);
    expect(thesisMatchesVenue(['meme'], 'all')).toBe(true);
    expect(thesisMatchesVenue(['meme'], 'equity')).toBe(false);
  });

  test('thesis venues keep meme-only rows off the equity chip', () => {
    expect(thesisVenuesFor({ symbols: [] }, [{ venue: 'meme' }], ['meme'])).toEqual(['meme']);
    expect(thesisVenuesFor({ symbols: ['NVDA'] }, [{ venue: 'meme' }], ['meme'])).toEqual(['equity', 'meme']);
    expect(thesisVenuesFor({ symbols: [] }, [], [])).toEqual(['equity']);
  });
});
