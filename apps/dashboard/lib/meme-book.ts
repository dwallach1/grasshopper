/**
 * Map BANDIT `meme_*` rows into the same Book / Theses / Events language
 * as QUANTANAMO equities and ODDSBORNE markets. Never invent a mark or P/L.
 */
import { MARK_NOT_IN_LEDGER } from './book-performance';
import type { DeskVenue } from './desk-venue';
import { thesisVenuesFor } from './desk-venue';
import type {
  BookNameLine,
  DeskLessonLine,
  DeskPayload,
  DeskTapeEvent,
  FillLogRow,
  IntentRow,
  ThesisLot,
  ThesisRow,
} from './ledger-types';
import { asFiniteNumber, asOptionalNumber, requireIso } from './numbers';

export type MemeTokenRow = {
  id: string;
  venue: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  status: string;
  bonding_curve_status: string | null;
  graduated_at: string | null;
  last_price_sol: number | null;
  last_mcap_sol: number | null;
  last_marked_at: string | null;
  thesis_id: string | null;
  kill_criteria: string | null;
};

export type MemePositionRow = {
  id: string;
  token_id: string;
  account_key: string;
  thesis_id: string | null;
  status: string;
  quantity: number;
  average_cost_sol: number | null;
  mark_sol: number | null;
  mark_at: string | null;
  thesis_text: string | null;
};

export type MemeOrderRow = {
  id: string;
  token_id: string;
  account_key: string;
  thesis_id: string | null;
  side: string;
  order_type: string;
  size_sol: number | null;
  size_tokens: number | null;
  price_sol: number | null;
  status: string;
  mode: string;
  venue_order_id: string | null;
  submitted_at: string | null;
  created_at: string;
};

export type MemeFillRow = {
  id: string;
  order_id: string;
  position_id: string | null;
  account_key: string;
  side: string;
  quantity: number;
  price_sol: number;
  fee_sol: number;
  executed_at: string;
};

export type MemePnlRow = {
  id: string;
  account_key: string;
  as_of: string;
  realized: number;
  unrealized: number | null;
  fees: number;
  cash_sol: number | null;
  equity_sol: number | null;
  notes: string | null;
};

export type MemeNoteRow = {
  id: string;
  token_id: string | null;
  thesis_id: string | null;
  note_type: string;
  title: string;
  body: string;
  created_at: string;
};

export type MemeCoinsPayload = {
  desk: 'BANDIT';
  venue: 'meme';
  tokens: MemeTokenRow[];
  positions: MemePositionRow[];
  orders: MemeOrderRow[];
  fills: MemeFillRow[];
  pnl: MemePnlRow[];
  notes: MemeNoteRow[];
};

const OPEN_POSITION = new Set(['open', 'active']);
const DEAD_ORDER = new Set(['filled', 'canceled', 'cancelled', 'rejected', 'expired']);

export function emptyMemeCoins(): MemeCoinsPayload {
  return {
    desk: 'BANDIT',
    venue: 'meme',
    tokens: [],
    positions: [],
    orders: [],
    fills: [],
    pnl: [],
    notes: [],
  };
}

export function memeDesk(desk: DeskPayload): MemeCoinsPayload {
  const raw = desk.meme_coins;
  if (!raw || !Array.isArray(raw.tokens)) {
    return emptyMemeCoins();
  }
  return {
    desk: 'BANDIT',
    venue: 'meme',
    tokens: raw.tokens,
    positions: raw.positions ?? [],
    orders: raw.orders ?? [],
    fills: raw.fills ?? [],
    pnl: raw.pnl ?? [],
    notes: raw.notes ?? [],
  };
}

export function tokenLabel(token: Pick<MemeTokenRow, 'symbol' | 'name' | 'mint'> | undefined): string {
  const symbol = token?.symbol?.trim();
  if (symbol) return symbol;
  const name = token?.name?.trim();
  if (name) return name;
  const mint = token?.mint?.trim();
  if (mint) return clip(mint, 12);
  return 'token';
}

export function memeBookNames(payload: MemeCoinsPayload): BookNameLine[] {
  const tokens = new Map(payload.tokens.map((row) => [row.id, row]));
  return payload.positions
    .filter((row) => OPEN_POSITION.has(row.status.toLowerCase()))
    .map((row) => {
      const token = tokens.get(row.token_id);
      const cost = row.average_cost_sol === null ? null : row.quantity * row.average_cost_sol;
      const mark = row.mark_sol;
      const pnl = mark === null || row.average_cost_sol === null
        ? null
        : (mark - row.average_cost_sol) * row.quantity;
      return {
        symbol: tokenLabel(token),
        quantity: row.quantity,
        average_cost: row.average_cost_sol,
        cost,
        mark,
        pnl,
        note: mark === null ? MARK_NOT_IN_LEDGER : '',
        venue: 'meme' as const,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function memeFillLog(payload: MemeCoinsPayload): FillLogRow[] {
  const tokens = new Map(payload.tokens.map((row) => [row.id, row]));
  const orders = new Map(payload.orders.map((row) => [row.id, row]));
  return payload.fills.map((fill) => {
    const order = orders.get(fill.order_id);
    const token = order ? tokens.get(order.token_id) : undefined;
    return {
      id: fill.id,
      at: fill.executed_at,
      symbol: tokenLabel(token),
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price_sol,
      notional: fill.quantity * fill.price_sol,
      status: order?.status ?? 'filled',
      source: 'meme_fill' as const,
      note: '',
      venue: 'meme' as const,
    };
  });
}

export function mergeMemeFillLog(existing: FillLogRow[], payload: MemeCoinsPayload): FillLogRow[] {
  return [...existing, ...memeFillLog(payload)].sort((a, b) => {
    const byTime = b.at.localeCompare(a.at);
    return byTime !== 0 ? byTime : a.symbol.localeCompare(b.symbol);
  });
}

export function workingMemeOrders(payload: MemeCoinsPayload): IntentRow[] {
  const tokens = new Map(payload.tokens.map((row) => [row.id, row]));
  return payload.orders
    .filter((row) => !DEAD_ORDER.has(row.status.toLowerCase()))
    .map((row) => ({
      id: row.id,
      account_key: row.account_key || 'solana-bandit-primary',
      symbol: tokenLabel(tokens.get(row.token_id)),
      side: row.side,
      status: row.status,
      mode: row.mode,
      notional: memeOrderNotional(row),
      quantity: row.size_tokens,
      order_type: row.order_type,
      broker_order_id: row.venue_order_id,
      created_at: row.created_at,
      updated_at: row.submitted_at ?? row.created_at,
    }));
}

function memeOrderNotional(row: MemeOrderRow): number | null {
  if (row.size_sol !== null) return row.size_sol;
  if (row.size_tokens !== null && row.price_sol !== null) return row.size_tokens * row.price_sol;
  return null;
}

export function hydrateMemeDesk(
  theses: ThesisRow[],
  fillLog: FillLogRow[],
  meme: MemeCoinsPayload,
): Pick<DeskPayload, 'theses' | 'fill_log' | 'meme_coins'> {
  return {
    theses: attachMemeThesisLots(theses, meme),
    fill_log: mergeMemeFillLog(fillLog, meme),
    meme_coins: meme,
  };
}

export function attachMemeThesisLots(
  theses: ThesisRow[],
  payload: MemeCoinsPayload,
): ThesisRow[] {
  const tokens = new Map(payload.tokens.map((row) => [row.id, row]));
  const byThesis = new Map<string, ThesisLot[]>();
  for (const row of payload.positions.filter((item) => OPEN_POSITION.has(item.status.toLowerCase()))) {
    if (!row.thesis_id) continue;
    const token = tokens.get(row.token_id);
    const lot: ThesisLot = {
      symbol: tokenLabel(token),
      side: 'long',
      quantity: row.quantity,
      average_cost: row.average_cost_sol,
      invested: row.average_cost_sol === null ? null : row.quantity * row.average_cost_sol,
      mark: row.mark_sol,
      pnl: row.mark_sol === null || row.average_cost_sol === null
        ? null
        : (row.mark_sol - row.average_cost_sol) * row.quantity,
      note: row.mark_sol === null ? MARK_NOT_IN_LEDGER : '',
      venue: 'meme',
    };
    const current = byThesis.get(row.thesis_id) ?? [];
    current.push(lot);
    byThesis.set(row.thesis_id, current);
  }

  const linked = memeThesisIds(payload);
  return theses.map((thesis) => {
    const extra = byThesis.get(thesis.id) ?? [];
    const lots = [...thesis.lots, ...extra];
    const linkedVenues: DeskVenue[] = [];
    if (thesis.venues?.includes('prediction')) linkedVenues.push('prediction');
    if (linked.has(thesis.id)) linkedVenues.push('meme');
    return {
      ...thesis,
      lots,
      venues: thesisVenuesFor(thesis, lots, linkedVenues),
    };
  });
}

export function memeThesisIds(payload: MemeCoinsPayload): Set<string> {
  const ids = new Set<string>();
  for (const row of payload.tokens) if (row.thesis_id) ids.add(row.thesis_id);
  for (const row of payload.positions) if (row.thesis_id) ids.add(row.thesis_id);
  for (const row of payload.orders) if (row.thesis_id) ids.add(row.thesis_id);
  for (const row of payload.notes) if (row.thesis_id) ids.add(row.thesis_id);
  return ids;
}

export function memeEvents(payload: MemeCoinsPayload): DeskTapeEvent[] {
  return payload.tokens.map((row) => ({
    key: `meme-${row.id}`,
    venue: 'meme',
    name: tokenLabel(row),
    kind: row.bonding_curve_status?.trim() || 'token',
    when: row.graduated_at,
    thesis_id: row.thesis_id,
    status: row.status,
    summary: row.name?.trim() || row.mint,
  }));
}

export function memeLessons(payload: MemeCoinsPayload, thesisId?: string): DeskLessonLine[] {
  return payload.notes
    .filter((row) => !thesisId || row.thesis_id === thesisId)
    .map((row) => ({
      key: `meme-${row.id}`,
      venue: 'meme' as const,
      thesis_id: row.thesis_id,
      kind: row.note_type,
      regime: 'meme',
      pending: true,
      summary: row.body ? `${row.title} — ${row.body}` : row.title,
    }));
}

export function latestMemePnl(payload: MemeCoinsPayload): MemePnlRow | null {
  if (!payload.pnl.length) return null;
  return [...payload.pnl].sort((a, b) => b.as_of.localeCompare(a.as_of))[0] ?? null;
}

export function openMemeCount(payload: MemeCoinsPayload): number {
  return payload.positions.filter((row) => OPEN_POSITION.has(row.status.toLowerCase())).length;
}

type LooseRow = Record<string, unknown>;

function text(row: LooseRow, key: string): string {
  return String(row[key] ?? '');
}

function optionalText(row: LooseRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

// If the DB has meme_* rows but every array here is empty, publisher SELECT
// RLS is missing (GRANT alone is not enough). desk:publish fails loud on that.
export function mapMemeCoins(input: {
  tokens?: readonly LooseRow[];
  positions?: readonly LooseRow[];
  orders?: readonly LooseRow[];
  fills?: readonly LooseRow[];
  pnl?: readonly LooseRow[];
  notes?: readonly LooseRow[];
}): MemeCoinsPayload {
  return {
    desk: 'BANDIT',
    venue: 'meme',
    tokens: (input.tokens ?? []).map((row) => ({
      id: text(row, 'id'),
      venue: text(row, 'venue') || 'pumpfun',
      mint: text(row, 'mint'),
      symbol: optionalText(row, 'symbol'),
      name: optionalText(row, 'name'),
      status: text(row, 'status') || 'watch',
      bonding_curve_status: optionalText(row, 'bonding_curve_status'),
      graduated_at: row.graduated_at == null ? null : requireIso(row.graduated_at as string | Date, 'meme_tokens.graduated_at'),
      last_price_sol: asOptionalNumber(row.last_price_sol as string | number | null, 'meme_tokens.last_price_sol'),
      last_mcap_sol: asOptionalNumber(row.last_mcap_sol as string | number | null, 'meme_tokens.last_mcap_sol'),
      last_marked_at: row.last_marked_at == null ? null : requireIso(row.last_marked_at as string | Date, 'meme_tokens.last_marked_at'),
      thesis_id: optionalText(row, 'thesis_id'),
      kill_criteria: optionalText(row, 'kill_criteria'),
    })),
    positions: (input.positions ?? []).map((row) => ({
      id: text(row, 'id'),
      token_id: text(row, 'token_id'),
      account_key: text(row, 'account_key'),
      thesis_id: optionalText(row, 'thesis_id'),
      status: text(row, 'status'),
      quantity: asFiniteNumber(row.quantity as string | number, 'meme_positions.quantity'),
      average_cost_sol: asOptionalNumber(row.average_cost_sol as string | number | null, 'meme_positions.average_cost_sol'),
      mark_sol: asOptionalNumber(row.mark_sol as string | number | null, 'meme_positions.mark_sol'),
      mark_at: row.mark_at == null ? null : requireIso(row.mark_at as string | Date, 'meme_positions.mark_at'),
      thesis_text: optionalText(row, 'thesis_text'),
    })),
    orders: (input.orders ?? []).map((row) => ({
      id: text(row, 'id'),
      token_id: text(row, 'token_id'),
      account_key: text(row, 'account_key'),
      thesis_id: optionalText(row, 'thesis_id'),
      side: text(row, 'side'),
      order_type: text(row, 'order_type') || 'market',
      size_sol: asOptionalNumber(row.size_sol as string | number | null, 'meme_orders.size_sol'),
      size_tokens: asOptionalNumber(row.size_tokens as string | number | null, 'meme_orders.size_tokens'),
      price_sol: asOptionalNumber(row.price_sol as string | number | null, 'meme_orders.price_sol'),
      status: text(row, 'status'),
      mode: text(row, 'mode'),
      venue_order_id: optionalText(row, 'venue_order_id'),
      submitted_at: row.submitted_at == null ? null : requireIso(row.submitted_at as string | Date, 'meme_orders.submitted_at'),
      created_at: requireIso(row.created_at as string | Date, 'meme_orders.created_at'),
    })),
    fills: (input.fills ?? []).map((row) => ({
      id: text(row, 'id'),
      order_id: text(row, 'order_id'),
      position_id: optionalText(row, 'position_id'),
      account_key: text(row, 'account_key'),
      side: text(row, 'side'),
      quantity: asFiniteNumber(row.quantity as string | number, 'meme_fills.quantity'),
      price_sol: asFiniteNumber(row.price_sol as string | number, 'meme_fills.price_sol'),
      fee_sol: asOptionalNumber(row.fee_sol as string | number | null, 'meme_fills.fee_sol') ?? 0,
      executed_at: requireIso(row.executed_at as string | Date, 'meme_fills.executed_at'),
    })),
    pnl: (input.pnl ?? []).map((row) => ({
      id: text(row, 'id'),
      account_key: text(row, 'account_key'),
      as_of: requireIso(row.as_of as string | Date, 'meme_pnl.as_of'),
      realized: asFiniteNumber(row.realized as string | number, 'meme_pnl.realized'),
      unrealized: asOptionalNumber(row.unrealized as string | number | null, 'meme_pnl.unrealized'),
      fees: asFiniteNumber(row.fees as string | number, 'meme_pnl.fees'),
      cash_sol: asOptionalNumber(row.cash_sol as string | number | null, 'meme_pnl.cash_sol'),
      equity_sol: asOptionalNumber(row.equity_sol as string | number | null, 'meme_pnl.equity_sol'),
      notes: optionalText(row, 'notes'),
    })),
    notes: (input.notes ?? []).map((row) => ({
      id: text(row, 'id'),
      token_id: optionalText(row, 'token_id'),
      thesis_id: optionalText(row, 'thesis_id'),
      note_type: text(row, 'note_type'),
      title: text(row, 'title'),
      body: text(row, 'body'),
      created_at: requireIso(row.created_at as string | Date, 'meme_notes.created_at'),
    })),
  };
}
