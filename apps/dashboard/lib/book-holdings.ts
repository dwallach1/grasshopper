/**
 * Every open lot across Stocks + Predictions + Coins — one table, native units.
 * Missing cost/mark stay unmarked. Never invent a % or UPL.
 */
import { OPEN_POSITION, type BookOpenTicket } from './book-open-strip';
import { venueLabel, type DeskVenue } from './desk-venue';
import type { DeskPayload } from './ledger-types';
import { memeDesk, tokenLabel } from './meme-book';
import { unitForRow, type MoneyUnit } from './money-units';
import { marketLabel, predictionDesk } from './prediction-book';

export type BookHoldingBook = 'QUANTANAMO' | 'ODDSBORNE' | 'BANDIT';

export type BookHolding = {
  id: string;
  name: string;
  glyph: string;
  book: BookHoldingBook;
  book_short: 'QNT' | 'ODD' | 'BND';
  venue: DeskVenue;
  unit: MoneyUnit;
  cost: number | null;
  mark: number | null;
  change_pct: number | null;
  size: number;
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

export function holdingUpl(cost: number | null, mark: number | null, size: number): number | null {
  if (cost === null || mark === null) return null;
  if (!Number.isFinite(cost) || !Number.isFinite(mark) || !Number.isFinite(size)) return null;
  return (mark - cost) * size;
}

export function assembleBookHoldings(desk: DeskPayload): BookHoldings {
  return {
    rows: [...equityHoldings(desk), ...predictionHoldings(desk), ...memeHoldings(desk)]
      .sort((a, b) => a.venue.localeCompare(b.venue) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}

export function holdingTicket(
  holding: BookHolding,
  tickets: readonly BookOpenTicket[],
): BookOpenTicket | undefined {
  return tickets.find((ticket) => ticket.id === holding.id)
    ?? tickets.find((ticket) => ticket.venue === holding.venue && ticket.market === holding.glyph)
    ?? tickets.find((ticket) => ticket.venue === holding.venue && holding.name.includes(ticket.market));
}

function equityHoldings(desk: DeskPayload): BookHolding[] {
  const seen = new Set<string>();
  const rows: BookHolding[] = [];
  for (const row of desk.book.names) {
    if (row.venue && row.venue !== 'equity') continue;
    if (!Number.isFinite(row.quantity) || row.quantity === 0) continue;
    const symbol = row.symbol.trim();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push(holdingRow({
      id: `eq:${symbol}`,
      name: symbol,
      glyph: symbol,
      venue: 'equity',
      cost: finiteOrNull(row.average_cost),
      mark: finiteOrNull(row.mark),
      size: Math.abs(row.quantity),
      upl: finiteOrNull(row.pnl),
      note: row.note,
    }));
  }
  for (const row of desk.positions ?? []) {
    if (!OPEN_POSITION.has(row.status.toLowerCase()) && row.status.toLowerCase() !== 'closing') continue;
    if (!Number.isFinite(row.quantity) || row.quantity === 0) continue;
    const symbol = row.symbol.trim();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push(holdingRow({
      id: `eq:${symbol}`,
      name: symbol,
      glyph: symbol,
      venue: 'equity',
      cost: finiteOrNull(row.average_cost),
      mark: null,
      size: Math.abs(row.quantity),
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
    if (!OPEN_POSITION.has(row.status.toLowerCase())) continue;
    if (!Number.isFinite(row.quantity) || row.quantity === 0) continue;
    const market = markets.get(row.market_id);
    rows.push(holdingRow({
      id: `pm:${row.id}`,
      name: marketLabel(market, row.outcome),
      glyph: market?.slug?.trim() || row.outcome,
      venue: 'prediction',
      cost: finiteOrNull(row.average_cost),
      mark: finiteOrNull(row.mark),
      size: row.quantity,
      upl: holdingUpl(finiteOrNull(row.average_cost), finiteOrNull(row.mark), row.quantity),
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
    if (!OPEN_POSITION.has(row.status.toLowerCase())) continue;
    if (!Number.isFinite(row.quantity) || row.quantity === 0) continue;
    const token = tokens.get(row.token_id);
    const name = tokenLabel(token);
    rows.push(holdingRow({
      id: `meme:${row.id}`,
      name,
      glyph: token?.symbol?.trim() || name,
      venue: 'meme',
      cost: finiteOrNull(row.average_cost_sol),
      mark: finiteOrNull(row.mark_sol),
      size: row.quantity,
      upl: holdingUpl(finiteOrNull(row.average_cost_sol), finiteOrNull(row.mark_sol), row.quantity),
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
  cost: number | null;
  mark: number | null;
  size: number;
  upl: number | null;
  note: string;
}): BookHolding {
  const book = venueLabel(input.venue) as BookHoldingBook;
  return {
    id: input.id,
    name: input.name,
    glyph: input.glyph,
    book,
    book_short: book === 'ODDSBORNE' ? 'ODD' : book === 'BANDIT' ? 'BND' : 'QNT',
    venue: input.venue,
    unit: unitForRow({ venue: input.venue }),
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
