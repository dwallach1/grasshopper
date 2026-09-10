/**
 * Book OPEN strip — live tickets above closed-lot edge CRT.
 *
 * Series are published snapshot marks only. Never invent a tick, a timestamp,
 * or a CLOB print. CLOB last_* is used only when already on the market/token
 * row. Equities render only when the snapshot already has a multi-point mark
 * series (two+ `portfolio_exposure.last_price` clocks) — no new publish path.
 *
 * `referenceLine` is average cost — that number lives on the line, not also
 * as ticket chrome. Edge CRT keeps after-the-fact stats. A kill overlay is
 * included only when `kill_mid` is already a finite number on the row.
 */
import {
  clocksFromIso,
  latestClockValue,
  mergeLivelineClocks,
  type LivelineClock,
  type LivelineOverlay,
} from './desk-liveline';
import { AVATAR_COLORS, deskTeam } from './desk-team';
import type { DeskVenue } from './desk-venue';
import { venueShort } from './desk-venue';
import type { DeskPayload, ExposureRow } from './ledger-types';
import { memeDesk, tokenLabel, type MemeCoinsPayload } from './meme-book';
import type { MoneyUnit } from './money-units';
import { asOptionalNumber } from './numbers';
import {
  predictionDesk,
  type PredictionMarketRow,
  type PredictionMarketsPayload,
} from './prediction-book';

export const OPEN_POSITION = new Set(['open', 'active']);
export const OPEN_LABEL_MAX = 22;

export type BookOpenStewardId = 'quantanamo' | 'oddsborne' | 'bandit';

export type BookOpenTicket = {
  id: string;
  steward: BookOpenStewardId;
  venue: DeskVenue;
  unit: MoneyUnit;
  market: string;
  side: string;
  size: number;
  label: string;
  meta: string;
  color: string;
  points: LivelineClock[];
  value: number | null;
  /** Latest published clock on this ticket — never generated_at. */
  marked_at: string | null;
  /** Average cost → Liveline `referenceLine`. */
  cost: number | null;
  /** Published kill mid → optional second overlay. */
  kill_mid: number | null;
  source: string;
  overlays: LivelineOverlay[];
  /** Liveline 0.0.7 needs two clocks. One published mark is a label, not a fake line. */
  drawable: boolean;
};

export type BookOpenSteward = {
  id: BookOpenStewardId;
  slug: string;
  steward: string;
  accent: string;
  venue: DeskVenue;
  venue_label: string;
  unit: MoneyUnit;
  tickets: BookOpenTicket[];
  marked_at: string | null;
};

export type BookOpen = {
  rows: BookOpenSteward[];
  as_of: string | null;
};

export function clipOpenLabel(value: string, max = OPEN_LABEL_MAX): string {
  const trimmed = value.trim();
  if (!trimmed) return 'market';
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export function formatOpenSide(value: string): string {
  return value.trim().toUpperCase() || 'SIDE';
}

export function formatOpenSize(quantity: number): string {
  if (!Number.isFinite(quantity)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(quantity);
}

export function formatOpenTicketLabel(market: string, side: string, size: number): {
  market: string;
  side: string;
  label: string;
  meta: string;
} {
  const clipped = clipOpenLabel(market);
  const sideLabel = formatOpenSide(side);
  return {
    market: clipped,
    side: sideLabel,
    label: `${sideLabel} · ${clipped}`,
    meta: formatOpenSize(size),
  };
}

/**
 * Read a published kill mid only. Does not parse `kill_criteria` prose.
 */
export function publishedKillMid(row: object | null | undefined): number | null {
  if (!row || typeof row !== 'object') return null;
  const bag = row as Record<string, unknown>;
  try {
    return asOptionalNumber(
      (bag.kill_mid ?? bag.killMid) as string | number | null | undefined,
      'kill_mid',
    );
  } catch {
    return null;
  }
}

export function clobLastForOutcome(
  market: Pick<PredictionMarketRow, 'last_yes' | 'last_no' | 'last_marked_at'>,
  outcome: string,
): { as_of: string; value: number } | null {
  const side = outcome.trim().toLowerCase();
  let value: number | null = null;
  if (side === 'yes' || side === 'y') value = market.last_yes;
  else if (side === 'no' || side === 'n') value = market.last_no;
  else return null;
  if (value === null || !Number.isFinite(value) || !market.last_marked_at) return null;
  return { as_of: market.last_marked_at, value };
}

export function assembleBookOpen(desk: DeskPayload): BookOpen {
  const rows = [
    finishSteward(desk, 'quantanamo', 'QUANTANAMO', AVATAR_COLORS.green, 'equity', 'USD', equityTickets(desk)),
    finishSteward(desk, 'oddsborne', 'ODDSBORNE', AVATAR_COLORS.blue, 'prediction', 'USD', predictionTickets(predictionDesk(desk))),
    finishSteward(desk, 'bandit', 'BANDIT', AVATAR_COLORS.red, 'meme', 'SOL', memeTickets(memeDesk(desk))),
  ].filter((row) => row.tickets.length > 0);
  return {
    rows,
    as_of: oldestTicketMark(rows),
  };
}

function finishSteward(
  desk: DeskPayload,
  id: BookOpenStewardId,
  fallbackName: string,
  fallbackAccent: string,
  venue: DeskVenue,
  unit: MoneyUnit,
  tickets: BookOpenTicket[],
): BookOpenSteward {
  const card = deskTeam(desk).agents.find((row) => row.slug === id);
  return {
    id,
    slug: id,
    steward: card?.display_name ?? fallbackName,
    accent: card?.accent || fallbackAccent,
    venue,
    venue_label: venueShort(venue),
    unit,
    tickets,
    marked_at: oldestTicketMark([{ tickets }]),
  };
}

function predictionTickets(payload: PredictionMarketsPayload): BookOpenTicket[] {
  const markets = new Map(payload.markets.map((row) => [row.id, row]));
  const orders = new Map(payload.orders.map((row) => [row.id, row]));
  const tickets: BookOpenTicket[] = [];
  for (const row of payload.positions) {
    if (!OPEN_POSITION.has(row.status.toLowerCase())) continue;
    const market = markets.get(row.market_id);
    const marks: Array<{ as_of: string; value: number | null; field: string }> = [];
    const clob = market ? clobLastForOutcome(market, row.outcome) : null;
    if (clob) {
      marks.push({
        as_of: clob.as_of,
        value: clob.value,
        field: row.outcome.trim().toLowerCase() === 'no' ? 'pm_markets.last_no' : 'pm_markets.last_yes',
      });
    }
    if (row.mark !== null && row.mark_at) {
      marks.push({ as_of: row.mark_at, value: row.mark, field: 'pm_positions.mark' });
    }
    for (const fill of payload.fills) {
      const order = orders.get(fill.order_id);
      const samePosition = fill.position_id === row.id;
      const sameMarket = (order?.market_id ?? '') === row.market_id
        && fill.outcome.trim().toLowerCase() === row.outcome.trim().toLowerCase();
      if (!samePosition && !sameMarket) continue;
      marks.push({ as_of: fill.executed_at, value: fill.price, field: 'pm_fills.price' });
    }
    const points = clocksFromIso(marks.map((item) => ({ as_of: item.as_of, value: item.value })));
    if (points.length === 0) continue;
    const fields = uniqueFields(marks);
    const marketName = market?.slug?.trim() || clipOpenLabel(market?.question ?? '', 36);
    tickets.push(ticket({
      id: `pm:${row.id}`,
      steward: 'oddsborne',
      venue: 'prediction',
      unit: 'USD',
      market: marketName,
      side: row.outcome,
      size: row.quantity,
      color: AVATAR_COLORS.blue,
      points,
      marked_at: latestMarkAt(marks),
      cost: finiteOrNull(row.average_cost),
      kill_mid: publishedKillMid(row) ?? publishedKillMid(market),
      source: `${fields.join(' · ')} · pm_positions.average_cost`,
    }));
  }
  return tickets.sort(byLabel);
}

function memeTickets(payload: MemeCoinsPayload): BookOpenTicket[] {
  const tokens = new Map(payload.tokens.map((row) => [row.id, row]));
  const orders = new Map(payload.orders.map((row) => [row.id, row]));
  const tickets: BookOpenTicket[] = [];
  for (const row of payload.positions) {
    if (!OPEN_POSITION.has(row.status.toLowerCase())) continue;
    const token = tokens.get(row.token_id);
    const marks: Array<{ as_of: string; value: number | null; field: string }> = [];
    if (token?.last_price_sol !== null && token?.last_price_sol !== undefined && token.last_marked_at) {
      marks.push({
        as_of: token.last_marked_at,
        value: token.last_price_sol,
        field: 'meme_tokens.last_price_sol',
      });
    }
    if (row.mark_sol !== null && row.mark_at) {
      marks.push({ as_of: row.mark_at, value: row.mark_sol, field: 'meme_positions.mark_sol' });
    }
    for (const fill of payload.fills) {
      const order = orders.get(fill.order_id);
      const samePosition = fill.position_id === row.id;
      const sameToken = (order?.token_id ?? '') === row.token_id;
      if (!samePosition && !sameToken) continue;
      marks.push({ as_of: fill.executed_at, value: fill.price_sol, field: 'meme_fills.price_sol' });
    }
    const points = clocksFromIso(marks.map((item) => ({ as_of: item.as_of, value: item.value })));
    if (points.length === 0) continue;
    tickets.push(ticket({
      id: `meme:${row.id}`,
      steward: 'bandit',
      venue: 'meme',
      unit: 'SOL',
      market: tokenLabel(token),
      side: 'long',
      size: row.quantity,
      color: AVATAR_COLORS.red,
      points,
      marked_at: latestMarkAt(marks),
      cost: finiteOrNull(row.average_cost_sol),
      kill_mid: publishedKillMid(row) ?? publishedKillMid(token),
      source: `${uniqueFields(marks).join(' · ')} · meme_positions.average_cost_sol`,
    }));
  }
  return tickets.sort(byLabel);
}

function equityTickets(desk: DeskPayload): BookOpenTicket[] {
  const open = new Map<string, { quantity: number; average_cost: number | null; kill_mid: number | null }>();
  for (const row of desk.book.names) {
    if (row.venue && row.venue !== 'equity') continue;
    if (!Number.isFinite(row.quantity) || row.quantity === 0) continue;
    open.set(row.symbol, {
      quantity: row.quantity,
      average_cost: row.average_cost,
      kill_mid: publishedKillMid(row),
    });
  }
  for (const row of desk.positions ?? []) {
    if (!OPEN_POSITION.has(row.status.toLowerCase()) && row.status.toLowerCase() !== 'closing') continue;
    if (!Number.isFinite(row.quantity) || row.quantity === 0) continue;
    if (open.has(row.symbol)) continue;
    open.set(row.symbol, {
      quantity: row.quantity,
      average_cost: row.average_cost,
      kill_mid: publishedKillMid(row),
    });
  }

  const bySymbol = groupExposureMarks(desk.exposures ?? []);
  const tickets: BookOpenTicket[] = [];
  for (const [symbol, lot] of [...open.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const clocks = bySymbol.get(symbol) ?? [];
    // Equities need a real series already in the snapshot — a single last_price
    // is a mark, not a series. Do not invent history from fills or NAV.
    if (clocks.length < 2) continue;
    tickets.push(ticket({
      id: `eq:${symbol}`,
      steward: 'quantanamo',
      venue: 'equity',
      unit: 'USD',
      market: symbol,
      side: lot.quantity < 0 ? 'sell' : 'buy',
      size: Math.abs(lot.quantity),
      color: AVATAR_COLORS.green,
      points: clocks,
      marked_at: latestExposureAt(desk.exposures ?? [], symbol),
      cost: finiteOrNull(lot.average_cost),
      kill_mid: lot.kill_mid,
      source: 'portfolio_exposure.last_price · book.names.average_cost',
    }));
  }
  return tickets;
}

function groupExposureMarks(rows: readonly ExposureRow[]): Map<string, LivelineClock[]> {
  const grouped = new Map<string, Array<{ as_of: string; value: number | null }>>();
  for (const row of rows) {
    const symbol = row.symbol.trim();
    if (!symbol) continue;
    const list = grouped.get(symbol) ?? [];
    list.push({ as_of: row.observed_at, value: row.last_price });
    grouped.set(symbol, list);
  }
  const series = new Map<string, LivelineClock[]>();
  for (const [symbol, marks] of grouped) {
    const clocks = clocksFromIso(marks);
    if (clocks.length) series.set(symbol, clocks);
  }
  return series;
}

function ticket(input: {
  id: string;
  steward: BookOpenStewardId;
  venue: DeskVenue;
  unit: MoneyUnit;
  market: string;
  side: string;
  size: number;
  color: string;
  points: LivelineClock[];
  marked_at: string | null;
  cost: number | null;
  kill_mid: number | null;
  source: string;
}): BookOpenTicket {
  const names = formatOpenTicketLabel(input.market, input.side, input.size);
  const value = latestClockValue(input.points);
  const overlays: LivelineOverlay[] = [];
  if (input.kill_mid !== null && Number.isFinite(input.kill_mid) && input.points.length > 0) {
    overlays.push({
      id: `${input.id}:kill`,
      label: 'kill',
      color: 'rgba(232, 237, 242, 0.45)',
      data: killClocks(input.points, input.kill_mid),
      value: input.kill_mid,
    });
  }
  return {
    id: input.id,
    steward: input.steward,
    venue: input.venue,
    unit: input.unit,
    market: names.market,
    side: names.side,
    size: input.size,
    label: names.label,
    meta: names.meta,
    color: input.color,
    points: input.points,
    value,
    marked_at: input.marked_at,
    cost: input.cost,
    kill_mid: input.kill_mid,
    source: input.kill_mid === null ? input.source : `${input.source} · kill_mid`,
    overlays,
    drawable: input.points.length >= 2,
  };
}

function killClocks(points: readonly LivelineClock[], killMid: number): LivelineClock[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  return mergeLivelineClocks([
    { time: first.time, value: killMid },
    { time: last.time, value: killMid },
  ]);
}

function uniqueFields(marks: ReadonlyArray<{ field: string }>): string[] {
  return [...new Set(marks.map((row) => row.field))];
}

function latestMarkAt(marks: ReadonlyArray<{ as_of: string }>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const row of marks) {
    const ms = Date.parse(row.as_of);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = row.as_of;
  }
  return best;
}

function latestExposureAt(rows: readonly ExposureRow[], symbol: string): string | null {
  return latestMarkAt(
    rows
      .filter((row) => row.symbol.trim() === symbol)
      .map((row) => ({ as_of: row.observed_at })),
  );
}

function oldestTicketMark(rows: ReadonlyArray<{ tickets: readonly BookOpenTicket[] }>): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    for (const ticket of row.tickets) {
      if (!ticket.marked_at) continue;
      const ms = Date.parse(ticket.marked_at);
      if (!Number.isFinite(ms) || ms >= bestMs) continue;
      bestMs = ms;
      best = ticket.marked_at;
    }
  }
  return best;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function byLabel(a: BookOpenTicket, b: BookOpenTicket): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}
