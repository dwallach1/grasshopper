/** One desk, three ledgers: QUANTANAMO equities, ODDSBORNE prediction, BANDIT coins. */

export const DESK_VENUES = ['equity', 'prediction', 'meme'] as const;
export type DeskVenue = (typeof DESK_VENUES)[number];
export type VenueFilter = 'all' | DeskVenue;

export const VENUE_FILTERS = [
  { id: 'all' as const, label: 'All', short: 'All' },
  { id: 'equity' as const, label: 'STOCKS', short: 'STOCKS' },
  { id: 'prediction' as const, label: 'PREDICTIONS', short: 'PREDICTIONS' },
  { id: 'meme' as const, label: 'COINS', short: 'COINS' },
] as const;

const VENUE_SET = new Set<string>(DESK_VENUES);

export function isDeskVenue(value: unknown): value is DeskVenue {
  return typeof value === 'string' && VENUE_SET.has(value);
}

export function venueLabel(venue: DeskVenue): string {
  if (venue === 'prediction') return 'ODDSBORNE';
  if (venue === 'meme') return 'BANDIT';
  return 'QUANTANAMO';
}

export function venueShort(venue: DeskVenue): string {
  if (venue === 'prediction') return 'PREDICTIONS';
  if (venue === 'meme') return 'COINS';
  return 'STOCKS';
}

/** Missing or unknown venue stays equities — never collapse meme/prediction into STOCKS. */
export function rowVenue(row: { venue?: DeskVenue | null }): DeskVenue {
  return isDeskVenue(row.venue) ? row.venue : 'equity';
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

/** Equity is the default only when no prediction/meme lot or link exists. */
export function thesisVenuesFor(
  thesis: { symbols: readonly string[] },
  lots: readonly { venue?: DeskVenue | null }[],
  linked: readonly DeskVenue[] = [],
): DeskVenue[] {
  const fromLots = new Set(lots.map((lot) => rowVenue(lot)));
  const hasEquity = fromLots.has('equity') || thesis.symbols.length > 0;
  const hasPrediction = fromLots.has('prediction') || linked.includes('prediction');
  const hasMeme = fromLots.has('meme') || linked.includes('meme');
  const venues: DeskVenue[] = [];
  if (hasEquity || (!hasPrediction && !hasMeme)) venues.push('equity');
  if (hasPrediction) venues.push('prediction');
  if (hasMeme) venues.push('meme');
  return venues;
}
