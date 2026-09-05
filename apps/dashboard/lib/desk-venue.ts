/** One desk, two ledgers: QUANTANAMO equities and ODDSBORNE prediction markets. */

export const DESK_VENUES = ['equity', 'prediction'] as const;
export type DeskVenue = (typeof DESK_VENUES)[number];
export type VenueFilter = 'all' | DeskVenue;

export const VENUE_FILTERS = [
  { id: 'all' as const, label: 'All', short: 'All' },
  { id: 'equity' as const, label: 'STOCKS', short: 'STOCKS' },
  { id: 'prediction' as const, label: 'PREDICTIONS', short: 'PREDICTIONS' },
] as const;

export function venueLabel(venue: DeskVenue): string {
  return venue === 'prediction' ? 'ODDSBORNE' : 'QUANTANAMO';
}

export function venueShort(venue: DeskVenue): string {
  return venue === 'prediction' ? 'PREDICTIONS' : 'STOCKS';
}

export function rowVenue(row: { venue?: DeskVenue | null }): DeskVenue {
  return row.venue === 'prediction' ? 'prediction' : 'equity';
}

export function lotKey(venue: DeskVenue, symbol: string): string {
  return `${venue}:${symbol}`;
}

export function matchesVenueFilter(venue: DeskVenue, filter: VenueFilter): boolean {
  return filter === 'all' || filter === venue;
}

export function thesisMatchesVenue(
  venues: readonly DeskVenue[] | undefined,
  filter: VenueFilter,
): boolean {
  if (filter === 'all') return true;
  const list = venues?.length ? venues : (['equity'] as const);
  return list.includes(filter);
}
