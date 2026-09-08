/**
 * Closed-lot edge stats per steward. Read-only over the desk snapshot.
 * Win/size/hold come from closed episodes + venue fills / filled intents.
 * Missing exit, size, or hold stays null — never invented.
 */
import { deskTeam } from './desk-team';
import { venueShort, type DeskVenue } from './desk-venue';
import type {
  DeskPayload,
  FillRow,
  IntentRow,
} from './ledger-types';
import { memeDesk, tokenLabel, type MemeCoinsPayload, type MemeFillRow } from './meme-book';
import { formatAmount, type MoneyUnit } from './money-units';
import {
  marketLabel,
  predictionDesk,
  type PredictionFillRow,
  type PredictionMarketsPayload,
} from './prediction-book';

export const BOOK_EDGE_THIN_N = 3;
export const BOOK_EDGE_BAR = 16;
export const BOOK_EDGE_FLAT = 1e-8;

const CLOSED = new Set(['closed', 'settled', 'resolved', 'expired', 'redeemed']);
const OPEN = new Set(['proposed', 'open', 'closing', 'active']);
const FILLED = new Set(['filled', 'partially_filled']);

export type BookEdgeStewardId = 'quantanamo' | 'oddsborne' | 'bandit' | 'cointanamo';

export type ClosedLot = {
  id: string;
  steward: BookEdgeStewardId;
  symbol: string;
  size: number | null;
  pnl: number | null;
  hold_ms: number | null;
  opened_at: string | null;
  closed_at: string | null;
};

export type DistStat = {
  n: number;
  avg: number;
  min: number;
  max: number;
  std: number | null;
};

export type StewardEdge = {
  id: BookEdgeStewardId;
  slug: string;
  steward: string;
  accent: string;
  venue: DeskVenue;
  venue_label: string;
  unit: MoneyUnit;
  closed: number;
  scored: number;
  wins: number;
  losses: number;
  flats: number;
  unmarked: number;
  win_rate: number | null;
  size: DistStat | null;
  hold: DistStat | null;
  thin: boolean;
  note: string;
  lots: ClosedLot[];
};

export type BookEdge = {
  rows: StewardEdge[];
  as_of: string | null;
};

type FillEvent = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number | null;
  notional: number | null;
  at: string;
};

export function sampleStd(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function distStat(values: readonly number[]): DistStat | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const avg = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return { n: finite.length, avg, min, max, std: sampleStd(finite) };
}

export function winRate(wins: number, losses: number): number | null {
  const decided = wins + losses;
  if (decided <= 0) return null;
  return (wins / decided) * 100;
}

export function classifyPnl(pnl: number | null): 'win' | 'loss' | 'flat' | 'unknown' {
  if (pnl === null || !Number.isFinite(pnl)) return 'unknown';
  if (Math.abs(pnl) < BOOK_EDGE_FLAT) return 'flat';
  return pnl > 0 ? 'win' : 'loss';
}

export function durationMs(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
}

export function formatHold(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return 'not in ledger';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return `${minutes}m`;
  }
  if (ms < 24 * 3_600_000) {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.round((ms % 3_600_000) / 60_000);
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.round((ms % 86_400_000) / 3_600_000);
  if (hours === 0) return `${days}d`;
  return `${days}d ${hours}h`;
}

export function asciiFillBar(pct: number | null, width = BOOK_EDGE_BAR): string {
  if (pct === null || !Number.isFinite(pct) || width <= 0) return '░'.repeat(Math.max(0, width));
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

export function asciiRangeBar(
  min: number,
  avg: number,
  max: number,
  width = BOOK_EDGE_BAR,
): string {
  if (width < 3) return '*';
  if (!(max > min) || !Number.isFinite(avg)) {
    return `·${'─'.repeat(width - 2)}·`;
  }
  const inner = width - 2;
  const pos = Math.min(inner - 1, Math.max(0, Math.round(((avg - min) / (max - min)) * (inner - 1))));
  let mid = '';
  for (let i = 0; i < inner; i += 1) {
    mid += i === pos ? '*' : '─';
  }
  return `·${mid}·`;
}

export function formatEdgeAmount(value: number | null | undefined, unit: MoneyUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not in ledger';
  return formatAmount(value, unit);
}

function agenticIntent(intent: IntentRow | undefined): boolean {
  if (!intent) return true;
  if (!intent.account_key) return true;
  return /agentic|7638/i.test(intent.account_key);
}

function sideOf(value: string): 'buy' | 'sell' | null {
  const side = value.trim().toLowerCase();
  if (side === 'buy') return 'buy';
  if (side === 'sell') return 'sell';
  return null;
}

function near(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(1e-6, scale * 0.02);
}

function sumNotional(events: readonly FillEvent[]): number | null {
  if (events.length === 0) return null;
  let total = 0;
  for (const row of events) {
    if (row.notional === null || !Number.isFinite(row.notional)) return null;
    total += row.notional;
  }
  return total;
}

function sumQty(events: readonly FillEvent[]): number | null {
  if (events.length === 0) return null;
  let total = 0;
  for (const row of events) {
    if (row.quantity === null || !Number.isFinite(row.quantity)) return null;
    total += row.quantity;
  }
  return total;
}

function firstAt(events: readonly FillEvent[]): string | null {
  return events[0]?.at ?? null;
}

function lastAt(events: readonly FillEvent[]): string | null {
  return events[events.length - 1]?.at ?? null;
}

function inWindow(at: string, start: string | null, end: string | null): boolean {
  if (!start && !end) return true;
  if (start && at < start) return false;
  if (end && at > end) return false;
  return true;
}

function padWindow(iso: string | null, ms: number, dir: -1 | 1): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Date(time + dir * ms).toISOString();
}

function equityFillEvents(fills: readonly FillRow[], intents: readonly IntentRow[]): FillEvent[] {
  const byId = new Map(intents.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const rows: FillEvent[] = [];

  for (const fill of fills) {
    const intent = byId.get(fill.trade_intent_id);
    if (intent && !agenticIntent(intent)) continue;
    const side = sideOf(intent?.side ?? '');
    if (!side) continue;
    const symbol = intent?.symbol?.trim();
    if (!symbol) continue;
    seen.add(fill.trade_intent_id);
    rows.push({
      id: fill.id,
      symbol,
      side,
      quantity: fill.quantity,
      notional: fill.quantity * fill.price,
      at: fill.executed_at,
    });
  }

  for (const intent of intents) {
    if (!agenticIntent(intent)) continue;
    if (!FILLED.has(intent.status.toLowerCase())) continue;
    if (seen.has(intent.id)) continue;
    const side = sideOf(intent.side);
    if (!side) continue;
    const symbol = intent.symbol.trim();
    if (!symbol) continue;
    const notional = intent.notional;
    const quantity = intent.quantity;
    const price = quantity && quantity !== 0 && notional !== null ? notional / quantity : null;
    rows.push({
      id: intent.id,
      symbol,
      side,
      quantity,
      notional: notional ?? (price !== null && quantity !== null ? price * quantity : null),
      at: intent.updated_at || intent.created_at,
    });
  }

  return rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function lotFromSides(
  id: string,
  steward: BookEdgeStewardId,
  symbol: string,
  buys: FillEvent[],
  sells: FillEvent[],
  openedAt: string | null,
  closedAt: string | null,
  fallbackSize: number | null,
): ClosedLot {
  const buyNotional = sumNotional(buys);
  const sellNotional = sumNotional(sells);
  let size = buyNotional;
  let pnl: number | null = null;
  if (buyNotional !== null && sellNotional !== null) {
    pnl = sellNotional - buyNotional;
  } else if (fallbackSize !== null && sellNotional !== null) {
    size = fallbackSize;
    pnl = sellNotional - fallbackSize;
  } else if (size === null) {
    size = fallbackSize;
  }
  const hold = durationMs(
    openedAt ?? firstAt(buys) ?? firstAt(sells),
    closedAt ?? lastAt(sells) ?? lastAt(buys),
  );
  return {
    id,
    steward,
    symbol,
    size,
    pnl,
    hold_ms: hold,
    opened_at: openedAt ?? firstAt(buys),
    closed_at: closedAt ?? lastAt(sells),
  };
}

function equityLots(desk: DeskPayload): ClosedLot[] {
  const episodes = desk.positions ?? [];
  const events = equityFillEvents(desk.fills ?? [], desk.intents ?? []);
  const openSymbols = new Set(
    episodes.filter((row) => OPEN.has(row.status.toLowerCase())).map((row) => row.symbol),
  );
  const lots: ClosedLot[] = [];
  const usedSymbols = new Set<string>();

  for (const episode of episodes.filter((row) => CLOSED.has(row.status.toLowerCase()))) {
    const start = padWindow(episode.opened_at, 10 * 60_000, -1);
    const end = padWindow(episode.closed_at, 10 * 60_000, 1);
    const window = events.filter((row) => row.symbol === episode.symbol && inWindow(row.at, start, end));
    const sellQty = sumQty(window.filter((row) => row.side === 'sell'));
    const fallback = episode.average_cost !== null && sellQty !== null
      ? episode.average_cost * sellQty
      : episode.average_cost !== null && episode.quantity > 0
        ? episode.average_cost * episode.quantity
        : null;
    lots.push(lotFromSides(
      `ep:${episode.id}`,
      'quantanamo',
      episode.symbol,
      window.filter((row) => row.side === 'buy'),
      window.filter((row) => row.side === 'sell'),
      episode.opened_at,
      episode.closed_at,
      fallback,
    ));
    usedSymbols.add(episode.symbol);
  }

  const leftover = events.filter((row) => !usedSymbols.has(row.symbol) && !openSymbols.has(row.symbol));
  lots.push(...fifoLots(leftover, 'quantanamo'));
  return lots;
}

function fifoLots(events: readonly FillEvent[], steward: BookEdgeStewardId): ClosedLot[] {
  const bySymbol = new Map<string, FillEvent[]>();
  for (const row of events) {
    const list = bySymbol.get(row.symbol) ?? [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }
  const lots: ClosedLot[] = [];
  for (const [symbol, rows] of bySymbol) {
    const buys = rows.filter((row) => row.side === 'buy');
    const sells = rows.filter((row) => row.side === 'sell');
    if (sells.length === 0) continue;
    const buyQty = sumQty(buys);
    const sellQty = sumQty(sells);
    if (buyQty !== null && sellQty !== null && !near(buyQty, sellQty)) continue;
    if (buyQty === null && sellQty === null && buys.length === 0) continue;
    lots.push(lotFromSides(
      `fifo:${steward}:${symbol}:${sells[0]?.id ?? symbol}`,
      steward,
      symbol,
      buys,
      sells,
      firstAt(buys),
      lastAt(sells),
      null,
    ));
  }
  return lots;
}

function venueLots(
  steward: BookEdgeStewardId,
  positions: readonly {
    id: string;
    status: string;
    quantity: number;
    average_cost: number | null;
    opened_at?: string | null;
    closed_at?: string | null;
    mark_at?: string | null;
    symbol: string;
  }[],
  fills: readonly { id: string; position_id: string | null; side: string; quantity: number; price: number; executed_at: string }[],
): ClosedLot[] {
  const byPosition = new Map<string, FillEvent[]>();
  for (const fill of fills) {
    if (!fill.position_id) continue;
    const side = sideOf(fill.side);
    if (!side) continue;
    const list = byPosition.get(fill.position_id) ?? [];
    list.push({
      id: fill.id,
      symbol: fill.position_id,
      side,
      quantity: fill.quantity,
      notional: fill.quantity * fill.price,
      at: fill.executed_at,
    });
    byPosition.set(fill.position_id, list);
  }

  const lots: ClosedLot[] = [];
  for (const position of positions) {
    if (!CLOSED.has(position.status.toLowerCase())) continue;
    const window = (byPosition.get(position.id) ?? []).sort((a, b) => a.at.localeCompare(b.at));
    const buys = window.filter((row) => row.side === 'buy');
    const sells = window.filter((row) => row.side === 'sell');
    const sellQty = sumQty(sells);
    const fallback = position.average_cost !== null && sellQty !== null
      ? position.average_cost * sellQty
      : position.average_cost !== null && position.quantity > 0
        ? position.average_cost * position.quantity
        : null;
    lots.push(lotFromSides(
      `${steward}:${position.id}`,
      steward,
      position.symbol,
      buys,
      sells,
      position.opened_at ?? firstAt(buys),
      position.closed_at ?? lastAt(sells) ?? position.mark_at ?? null,
      fallback,
    ));
  }
  return lots;
}

function predictionLots(payload: PredictionMarketsPayload): ClosedLot[] {
  const markets = new Map(payload.markets.map((row) => [row.id, row]));
  const orders = new Map(payload.orders.map((row) => [row.id, row]));
  const fills: Array<PredictionFillRow & { symbol: string }> = payload.fills.map((fill) => {
    const order = orders.get(fill.order_id);
    const market = order ? markets.get(order.market_id) : undefined;
    return { ...fill, symbol: marketLabel(market, fill.outcome) };
  });
  return venueLots(
    'oddsborne',
    payload.positions.map((row) => ({
      id: row.id,
      status: row.status,
      quantity: row.quantity,
      average_cost: row.average_cost,
      opened_at: row.opened_at ?? null,
      closed_at: row.closed_at ?? null,
      mark_at: row.mark_at,
      symbol: marketLabel(markets.get(row.market_id), row.outcome),
    })),
    fills,
  );
}

function memeLots(payload: MemeCoinsPayload): ClosedLot[] {
  const tokens = new Map(payload.tokens.map((row) => [row.id, row]));
  const orders = new Map(payload.orders.map((row) => [row.id, row]));
  const fills: Array<MemeFillRow & { symbol: string; price: number }> = payload.fills.map((fill) => {
    const order = orders.get(fill.order_id);
    const token = order ? tokens.get(order.token_id) : undefined;
    return { ...fill, symbol: tokenLabel(token), price: fill.price_sol };
  });
  return venueLots(
    'bandit',
    payload.positions.map((row) => ({
      id: row.id,
      status: row.status,
      quantity: row.quantity,
      average_cost: row.average_cost_sol,
      opened_at: row.opened_at ?? null,
      closed_at: row.closed_at ?? null,
      mark_at: row.mark_at,
      symbol: tokenLabel(tokens.get(row.token_id)),
    })),
    fills,
  );
}

function finishSteward(input: {
  id: BookEdgeStewardId;
  slug: string;
  steward: string;
  accent: string;
  venue: DeskVenue;
  unit: MoneyUnit;
  lots: ClosedLot[];
}): StewardEdge {
  const wins = input.lots.filter((row) => classifyPnl(row.pnl) === 'win').length;
  const losses = input.lots.filter((row) => classifyPnl(row.pnl) === 'loss').length;
  const flats = input.lots.filter((row) => classifyPnl(row.pnl) === 'flat').length;
  const unmarked = input.lots.filter((row) => classifyPnl(row.pnl) === 'unknown').length;
  const scored = wins + losses + flats;
  const rate = winRate(wins, losses);
  const thin = input.lots.length < BOOK_EDGE_THIN_N;
  let note = `${input.lots.length} closed lots`;
  if (input.lots.length === 0) note = 'no closed lots in ledger';
  else if (thin) note = `thin — ${input.lots.length} closed`;
  if (unmarked > 0 && input.lots.length > 0) {
    note = `${note} · ${unmarked} unmarked`;
  }
  return {
    id: input.id,
    slug: input.slug,
    steward: input.steward,
    accent: input.accent,
    venue: input.venue,
    venue_label: venueShort(input.venue),
    unit: input.unit,
    closed: input.lots.length,
    scored,
    wins,
    losses,
    flats,
    unmarked,
    win_rate: rate,
    size: distStat(input.lots.map((row) => row.size).filter((value): value is number => value !== null)),
    hold: distStat(input.lots.map((row) => row.hold_ms).filter((value): value is number => value !== null)),
    thin,
    note,
    lots: input.lots,
  };
}

function identity(
  desk: DeskPayload,
  slug: BookEdgeStewardId,
  fallbackName: string,
  fallbackAccent: string,
): { slug: string; steward: string; accent: string } {
  const card = deskTeam(desk).agents.find((row) => row.slug === slug);
  return {
    slug,
    steward: card?.display_name ?? fallbackName,
    accent: card?.accent || fallbackAccent,
  };
}

export function assembleBookEdge(desk: DeskPayload): BookEdge {
  const rows: StewardEdge[] = [
    finishSteward({
      id: 'quantanamo',
      ...identity(desk, 'quantanamo', 'QUANTANAMO', '#7dd3a7'),
      venue: 'equity',
      unit: 'USD',
      lots: equityLots(desk),
    }),
    finishSteward({
      id: 'oddsborne',
      ...identity(desk, 'oddsborne', 'ODDSBORNE', '#7eb6ff'),
      venue: 'prediction',
      unit: 'USD',
      lots: predictionLots(predictionDesk(desk)),
    }),
    finishSteward({
      id: 'bandit',
      ...identity(desk, 'bandit', 'BANDIT', '#f0a3b5'),
      venue: 'meme',
      unit: 'SOL',
      lots: memeLots(memeDesk(desk)),
    }),
  ];
  const coin = deskTeam(desk).agents.find((row) => row.slug === 'cointanamo');
  if (coin) {
    rows.push(finishSteward({
      id: 'cointanamo',
      slug: coin.slug,
      steward: coin.display_name || 'COINTANAMO',
      accent: coin.accent || '#94a3b8',
      venue: 'meme',
      unit: 'SOL',
      lots: [],
    }));
  }
  return {
    rows,
    as_of: desk.generated_at ?? desk.book.observed_at ?? null,
  };
}
