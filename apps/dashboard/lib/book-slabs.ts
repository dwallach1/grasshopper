import { MARK_NOT_IN_LEDGER, NOT_IN_LEDGER } from './book-performance';
import type { BookNameLine, BookPerformance } from './ledger-types';

export type BookSlabKind = 'lot' | 'cash';
export type BookSlabTone = 'up' | 'down' | 'neutral' | 'cash';

export type BookSlab = {
  id: string;
  kind: BookSlabKind;
  symbol: string;
  quantity: number | null;
  average_cost: number | null;
  cost: number | null;
  mark: number | null;
  /** Visual mass: marked notional, else cost, else leftover cash, else 0. */
  mass: number;
  /** quantity × mark when the ledger has a mark; cash amount for leftover; else null. */
  notional: number | null;
  pnl: number | null;
  muted: boolean;
  note: string;
};

function lotNotional(row: BookNameLine): number | null {
  if (row.mark === null) return null;
  return row.quantity * row.mark;
}

function lotSlab(row: BookNameLine): BookSlab {
  const notional = lotNotional(row);
  const marked = row.mark !== null;
  const hasPnl = row.pnl !== null && row.average_cost !== null && marked;
  return {
    id: row.symbol,
    kind: 'lot',
    symbol: row.symbol,
    quantity: row.quantity,
    average_cost: row.average_cost,
    cost: row.cost,
    mark: row.mark,
    mass: notional ?? row.cost ?? 0,
    notional,
    pnl: hasPnl ? row.pnl : null,
    muted: !marked,
    note: marked ? row.note : (row.note || MARK_NOT_IN_LEDGER),
  };
}

function cashSlab(book: BookPerformance): BookSlab {
  const leftover = book.cash ?? book.buying_power;
  if (leftover === null) {
    return {
      id: 'CASH',
      kind: 'cash',
      symbol: 'CASH',
      quantity: null,
      average_cost: null,
      cost: null,
      mark: null,
      mass: 0,
      notional: null,
      pnl: null,
      muted: true,
      note: NOT_IN_LEDGER,
    };
  }
  return {
    id: 'CASH',
    kind: 'cash',
    symbol: 'CASH',
    quantity: null,
    average_cost: null,
    cost: null,
    mark: null,
    mass: leftover,
    notional: leftover,
    pnl: null,
    muted: false,
    note: book.cash !== null ? 'cash' : 'buying power',
  };
}

/**
 * Lot-tile primitives. Size from ledger notional (or cost if unmarked).
 * Cash is leftover mass, never a fake fifth equity. P/L tone only when both
 * cost and mark exist.
 */
export function bookSlabs(book: BookPerformance): BookSlab[] {
  return [...book.names.map(lotSlab), cashSlab(book)];
}

export function slabTone(slab: BookSlab): BookSlabTone {
  if (slab.kind === 'cash') return 'cash';
  if (slab.pnl === null) return 'neutral';
  if (slab.pnl > 0) return 'up';
  if (slab.pnl < 0) return 'down';
  return 'neutral';
}

export type AllocSlice = {
  id: string;
  symbol: string;
  mass: number;
  pct: number | null;
  tone: BookSlabTone;
  muted: boolean;
};

/** Stacked allocation vs NAV. Missing NAV → pct null, never a invented share. */
export function allocationSlices(slabs: readonly BookSlab[], nav: number | null): AllocSlice[] {
  return slabs.map((slab) => ({
    id: slab.id,
    symbol: slab.symbol,
    mass: slab.mass,
    pct: nav !== null && nav > 0 ? slab.mass / nav : null,
    tone: slabTone(slab),
    muted: slab.muted,
  }));
}
