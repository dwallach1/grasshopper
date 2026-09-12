/**
 * Open + closed lots across Stocks + Predictions + Coins — one table, native units.
 * Missing cost/mark stay unmarked. Never invent a % or UPL.
 * Closed rows come from position episodes / pm_positions / meme_positions only.
 */
import { OPEN_POSITION, type BookOpenTicket } from './book-open-strip';
import { venueLabel, type DeskVenue } from './desk-venue';
import type { DeskPayload } from './ledger-types';
import { memeDesk, tokenLabel } from './meme-book';
import { unitForRow, type MoneyUnit } from './money-units';
import { marketLabel, predictionDesk } from './prediction-book';

export type BookHoldingBook = 'QUANTANAMO' | 'ODDSBORNE' | 'BANDIT';
export type BookHoldingLife = 'live' | 'closed';
export type BookHoldingStewardSlug = 'quantanamo' | 'oddsborne' | 'bandit';

export const CLOSED_POSITION = new Set(['closed', 'settled', 'resolved', 'expired', 'redeemed']);

export type BookHolding = {
  id: string;
  name: string;
  glyph: string;
  book: BookHoldingBook;
  book_short: 'QNT' | 'ODD' | 'BND';
  steward: BookHoldingBook;
  steward_slug: BookHoldingStewardSlug;
  venue: DeskVenue;
  unit: MoneyUnit;
  life: BookHoldingLife;
  cost: number | null;
  mark: number | null;
  change_pct: number | null;
  size: number | null;
  upl: number | null;
  note: string;
};

export type BookHoldings = {
  rows: BookHolding[];
};

export function holdingChangePct(cost: number | null, mark: number | null): number | null {
  if (cost === null || mark === null) return null;
  if (!(cost > 0) || !Number.isFinite(cost) || !Number.isFinite(mark)) return null;
  return ((mark - cost) / cost) * 100;
}

export function holdingUpl(cost: number | null, mark: number | null, size: number | null): number | null {
  if (cost === null || mark === null || size === null) return null;
  if (!Number.isFinite(cost) || !Number.isFinite(mark) || !Number.isFinite(size)) return null;
  return (mark - cost) * size;
}

export function holdingLifeLabel(life: BookHoldingLife): 'LIVE' | 'CLOSED' {
  return life === 'closed' ? 'CLOSED' : 'LIVE';
}

export function isClosedPositionStatus(status: string): boolean {
  return CLOSED_POSITION.has(status.trim().toLowerCase());
}

export function assembleBookHoldings(desk: DeskPayload): BookHoldings {
  return {
    rows: [...equityHoldings(desk), ...predictionHoldings(desk), ...memeHoldings(desk)]
      .sort((a, b) => (
        lifeRank(a.life) - lifeRank(b.life)
        || a.venue.localeCompare(b.venue)
        || a.name.localeCompare(b.name)
        || a.id.localeCompare(b.id)
      )),
  };
}

export function holdingTicket(
  holding: BookHolding,
  tickets: readonly BookOpenTicket[],
): BookOpenTicket | undefined {
  if (holding.life === 'closed') return undefined;
  return tickets.find((ticket) => ticket.id === holding.id)
    ?? tickets.find((ticket) => ticket.venue === holding.venue && ticket.market === holding.glyph)
    ?? tickets.find((ticket) => ticket.venue === holding.venue && holding.name.includes(ticket.market));
}

function lifeRank(life: BookHoldingLife): number {
  return life === 'live' ? 0 : 1;
}

function equityHoldings(desk: DeskPayload): BookHolding[] {
  const seenOpen = new Set<string>();
  const rows: BookHolding[] = [];
  for (const row of desk.book.names) {
    if (row.venue && row.venue !== 'equity') continue;
    if (!Number.isFinite(row.quantity) || row.quantity === 0) continue;
    const symbol = row.symbol.trim();
    if (!symbol || seenOpen.has(symbol)) continue;
    seenOpen.add(symbol);
    rows.push(holdingRow({
      id: `eq:${symbol}`,
      name: symbol,
      glyph: symbol,
      venue: 'equity',
      life: 'live',
      cost: finiteOrNull(row.average_cost),
      mark: finiteOrNull(row.mark),
      size: Math.abs(row.quantity),
      upl: finiteOrNull(row.pnl),
      note: row.note,
    }));
  }
  for (const row of desk.positions ?? []) {
    const status = row.status.toLowerCase();
    const symbol = row.symbol.trim();
    if (!symbol) continue;
    if (OPEN_POSITION.has(status) || status === 'closing') {
      if (!Number.isFinite(row.quantity) || row.quantity === 0) continue;
      if (seenOpen.has(symbol)) continue;
      seenOpen.add(symbol);
      rows.push(holdingRow({
        id: `eq:${symbol}`,
        name: symbol,
        glyph: symbol,
        venue: 'equity',
        life: 'live',
        cost: finiteOrNull(row.average_cost),
        mark: null,
        size: Math.abs(row.quantity),
        upl: null,
        note: '',
      }));
      continue;
    }
    if (!isClosedPositionStatus(status)) continue;
    rows.push(holdingRow({
      id: `eq-closed:${row.id}`,
      name: symbol,
      glyph: symbol,
      venue: 'equity',
      life: 'closed',
      cost: finiteOrNull(row.average_cost),
      mark: null,
      size: Number.isFinite(row.quantity) ? Math.abs(row.quantity) : null,
      upl: null,
      note: '',
    }));
  }
  return rows;
}

function predictionHoldings(desk: DeskPayload): BookHolding[] {
  const payload = predictionDesk(desk);
  const markets = new Map(payload.markets.map((row) => [row.id, row]));
  const rows: BookHolding[] = [];
  for (const row of payload.positions) {
    const status = row.status.toLowerCase();
    const live = OPEN_POSITION.has(status);
    const closed = isClosedPositionStatus(status);
    if (!live && !closed) continue;
    if (live && (!Number.isFinite(row.quantity) || row.quantity === 0)) continue;
    const market = markets.get(row.market_id);
    const cost = finiteOrNull(row.average_cost);
    const mark = finiteOrNull(row.mark);
    const size = Number.isFinite(row.quantity) ? row.quantity : null;
    rows.push(holdingRow({
      id: `pm:${row.id}`,
      name: marketLabel(market, row.outcome),
      glyph: market?.slug?.trim() || row.outcome,
      venue: 'prediction',
      life: closed ? 'closed' : 'live',
      cost,
      mark,
      size,
      upl: holdingUpl(cost, mark, size),
      note: row.mark === null ? 'mark not in ledger' : '',
    }));
  }
  return rows;
}

function memeHoldings(desk: DeskPayload): BookHolding[] {
  const payload = memeDesk(desk);
  const tokens = new Map(payload.tokens.map((row) => [row.id, row]));
  const rows: BookHolding[] = [];
  for (const row of payload.positions) {
    const status = row.status.toLowerCase();
    const live = OPEN_POSITION.has(status);
    const closed = isClosedPositionStatus(status);
    if (!live && !closed) continue;
    if (live && (!Number.isFinite(row.quantity) || row.quantity === 0)) continue;
    const token = tokens.get(row.token_id);
    const name = tokenLabel(token);
    const cost = finiteOrNull(row.average_cost_sol);
    const mark = finiteOrNull(row.mark_sol);
    const size = Number.isFinite(row.quantity) ? row.quantity : null;
    rows.push(holdingRow({
      id: `meme:${row.id}`,
      name,
      glyph: token?.symbol?.trim() || name,
      venue: 'meme',
      life: closed ? 'closed' : 'live',
      cost,
      mark,
      size,
      upl: holdingUpl(cost, mark, size),
      note: row.mark_sol === null ? 'mark not in ledger' : '',
    }));
  }
  return rows;
}

function holdingRow(input: {
  id: string;
  name: string;
  glyph: string;
  venue: DeskVenue;
  life: BookHoldingLife;
  cost: number | null;
  mark: number | null;
  size: number | null;
  upl: number | null;
  note: string;
}): BookHolding {
  const book = venueLabel(input.venue) as BookHoldingBook;
  const steward_slug: BookHoldingStewardSlug = book === 'ODDSBORNE'
    ? 'oddsborne'
    : book === 'BANDIT'
      ? 'bandit'
      : 'quantanamo';
  return {
    id: input.id,
    name: input.name,
    glyph: input.glyph,
    book,
    book_short: book === 'ODDSBORNE' ? 'ODD' : book === 'BANDIT' ? 'BND' : 'QNT',
    steward: book,
    steward_slug,
    venue: input.venue,
    unit: unitForRow({ venue: input.venue }),
    life: input.life,
    cost: input.cost,
    mark: input.mark,
    change_pct: holdingChangePct(input.cost, input.mark),
    size: input.size,
    upl: input.upl,
    note: input.note,
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}
