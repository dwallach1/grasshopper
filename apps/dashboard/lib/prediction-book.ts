/**
 * Map ODDSBORNE `pm_*` rows into the same Book / Theses / Events language
 * as QUANTANAMO equities and BANDIT coins. Never invent a mark or P/L.
 */
import { MARK_NOT_IN_LEDGER, NOT_IN_LEDGER } from './book-performance';
import type { DeskVenue } from './desk-venue';
import { rowVenue, thesisMatchesVenue, thesisVenuesFor, venueShort, type VenueFilter } from './desk-venue';
import type {
  BookNameLine,
  CatalystRow,
  DeskLessonLine,
  DeskPayload,
  DeskTapeEvent,
  FillLogRow,
  IntentRow,
  LessonRow,
  ThesisLot,
  ThesisRow,
} from './ledger-types';
import { emptyMemeCoins, memeBookNames, memeDesk, memeEvents, memeLessons, workingMemeOrders } from './meme-book';
import { asFiniteNumber, asOptionalNumber, requireIso } from './numbers';

export type { DeskLessonLine, DeskTapeEvent } from './ledger-types';

export type PredictionMarketRow = {
  id: string;
  venue: string;
  slug: string | null;
  question: string;
  status: string;
  close_time: string | null;
  last_yes: number | null;
  last_no: number | null;
  last_marked_at: string | null;
  thesis_id: string | null;
  rules_summary: string | null;
};

export type PredictionPositionRow = {
  id: string;
  market_id: string;
  account_key: string;
  thesis_id: string | null;
  outcome: string;
  status: string;
  quantity: number;
  average_cost: number | null;
  mark: number | null;
  mark_at: string | null;
  thesis_text: string | null;
};

export type PredictionOrderRow = {
  id: string;
  market_id: string;
  thesis_id: string | null;
  outcome: string;
  side: string;
  order_type: string;
  size: number;
  price: number | null;
  status: string;
  mode: string;
  venue_order_id: string | null;
  submitted_at: string | null;
  created_at: string;
};

export type PredictionFillRow = {
  id: string;
  order_id: string;
  position_id: string | null;
  outcome: string;
  side: string;
  quantity: number;
  price: number;
  executed_at: string;
};

export type PredictionPnlRow = {
  id: string;
  account_key: string;
  as_of: string;
  realized: number;
  unrealized: number | null;
  fees: number;
  cash: number | null;
  equity: number | null;
  notes: string | null;
};

export type PredictionNoteRow = {
  id: string;
  market_id: string | null;
  thesis_id: string | null;
  note_type: string;
  title: string;
  body: string;
  created_at: string;
};

export type PredictionMarketsPayload = {
  desk: 'ODDSBORNE';
  venue: 'prediction';
  markets: PredictionMarketRow[];
  positions: PredictionPositionRow[];
  orders: PredictionOrderRow[];
  fills: PredictionFillRow[];
  pnl: PredictionPnlRow[];
  notes: PredictionNoteRow[];
};

const OPEN_POSITION = new Set(['open', 'active']);
const DEAD_ORDER = new Set(['filled', 'canceled', 'cancelled', 'rejected', 'expired']);

export function emptyPredictionMarkets(): PredictionMarketsPayload {
  return {
    desk: 'ODDSBORNE',
    venue: 'prediction',
    markets: [],
    positions: [],
    orders: [],
    fills: [],
    pnl: [],
    notes: [],
  };
}

export function predictionDesk(desk: DeskPayload): PredictionMarketsPayload {
  const raw = desk.prediction_markets;
  if (!raw || !Array.isArray(raw.markets)) {
    return emptyPredictionMarkets();
  }
  return {
    desk: 'ODDSBORNE',
    venue: 'prediction',
    markets: raw.markets,
    positions: raw.positions ?? [],
    orders: raw.orders ?? [],
    fills: raw.fills ?? [],
    pnl: raw.pnl ?? [],
    notes: raw.notes ?? [],
  };
}

export function marketLabel(market: Pick<PredictionMarketRow, 'slug' | 'question'> | undefined, outcome: string): string {
  const base = market?.slug?.trim() || clip(market?.question ?? '', 36) || 'market';
  const side = outcome.trim().toUpperCase() || 'OUTCOME';
  return `${side} · ${base}`;
}

export function predictionBookNames(
  payload: PredictionMarketsPayload,
): BookNameLine[] {
  const markets = new Map(payload.markets.map((row) => [row.id, row]));
  return payload.positions
    .filter((row) => OPEN_POSITION.has(row.status.toLowerCase()))
    .map((row) => {
      const market = markets.get(row.market_id);
      const cost = row.average_cost === null ? null : row.quantity * row.average_cost;
      const mark = row.mark;
      const pnl = mark === null || row.average_cost === null
        ? null
        : (mark - row.average_cost) * row.quantity;
      return {
        symbol: marketLabel(market, row.outcome),
        quantity: row.quantity,
        average_cost: row.average_cost,
        cost,
        mark,
        pnl,
        note: mark === null ? MARK_NOT_IN_LEDGER : '',
        venue: 'prediction' as const,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function deskBookNames(desk: DeskPayload): BookNameLine[] {
  const equity = desk.book.names.map((row) => ({ ...row, venue: rowVenue(row) }));
  return [
    ...equity,
    ...predictionBookNames(predictionDesk(desk)),
    ...memeBookNames(memeDesk(desk)),
  ];
}

export function filterBookNames(names: readonly BookNameLine[], filter: VenueFilter): BookNameLine[] {
  return names.filter((row) => filter === 'all' || rowVenue(row) === filter);
}

export function predictionFillLog(
  payload: PredictionMarketsPayload,
): FillLogRow[] {
  const markets = new Map(payload.markets.map((row) => [row.id, row]));
  const orders = new Map(payload.orders.map((row) => [row.id, row]));
  return payload.fills.map((fill) => {
    const order = orders.get(fill.order_id);
    const market = order ? markets.get(order.market_id) : undefined;
    return {
      id: fill.id,
      at: fill.executed_at,
      symbol: marketLabel(market, fill.outcome),
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      notional: fill.quantity * fill.price,
      status: order?.status ?? 'filled',
      source: 'prediction_fill' as const,
      note: '',
      venue: 'prediction' as const,
    };
  });
}

export function mergeFillLog(equity: FillLogRow[], payload: PredictionMarketsPayload): FillLogRow[] {
  return [...equity.map((row) => ({ ...row, venue: rowVenue(row) })), ...predictionFillLog(payload)]
    .sort((a, b) => {
      const byTime = b.at.localeCompare(a.at);
      return byTime !== 0 ? byTime : a.symbol.localeCompare(b.symbol);
    });
}

export function filterFillLog(rows: readonly FillLogRow[], filter: VenueFilter): FillLogRow[] {
  return rows.filter((row) => filter === 'all' || rowVenue(row) === filter);
}

export function workingPredictionOrders(payload: PredictionMarketsPayload): IntentRow[] {
  const markets = new Map(payload.markets.map((row) => [row.id, row]));
  return payload.orders
    .filter((row) => !DEAD_ORDER.has(row.status.toLowerCase()))
    .map((row) => ({
      id: row.id,
      account_key: 'oddsborne',
      symbol: marketLabel(markets.get(row.market_id), row.outcome),
      side: row.side,
      status: row.status,
      mode: row.mode,
      notional: row.price === null ? null : row.size * row.price,
      quantity: row.size,
      order_type: row.order_type,
      broker_order_id: row.venue_order_id,
      created_at: row.created_at,
      updated_at: row.submitted_at ?? row.created_at,
    }));
}

export function filterIntents(
  intents: readonly IntentRow[],
  payload: PredictionMarketsPayload,
  filter: VenueFilter,
  meme = emptyMemeCoins(),
): Array<IntentRow & { venue: DeskVenue }> {
  const equity = intents.map((row) => ({ ...row, venue: 'equity' as const }));
  const prediction = workingPredictionOrders(payload).map((row) => ({ ...row, venue: 'prediction' as const }));
  const coins = workingMemeOrders(meme).map((row) => ({ ...row, venue: 'meme' as const }));
  const rows = [...equity, ...prediction, ...coins];
  return rows.filter((row) => filter === 'all' || row.venue === filter);
}

export function hydratePredictionDesk(
  theses: ThesisRow[],
  fillLog: FillLogRow[],
  prediction: PredictionMarketsPayload,
): Pick<DeskPayload, 'theses' | 'fill_log' | 'prediction_markets'> {
  return {
    theses: attachPredictionThesisLots(theses, prediction),
    fill_log: mergeFillLog(fillLog, prediction),
    prediction_markets: prediction,
  };
}

export function attachPredictionThesisLots(
  theses: ThesisRow[],
  payload: PredictionMarketsPayload,
): ThesisRow[] {
  const markets = new Map(payload.markets.map((row) => [row.id, row]));
  const byThesis = new Map<string, ThesisLot[]>();
  for (const row of payload.positions.filter((item) => OPEN_POSITION.has(item.status.toLowerCase()))) {
    if (!row.thesis_id) continue;
    const market = markets.get(row.market_id);
    const lot: ThesisLot = {
      symbol: marketLabel(market, row.outcome),
      side: row.outcome,
      quantity: row.quantity,
      average_cost: row.average_cost,
      invested: row.average_cost === null ? null : row.quantity * row.average_cost,
      mark: row.mark,
      pnl: row.mark === null || row.average_cost === null
        ? null
        : (row.mark - row.average_cost) * row.quantity,
      note: row.mark === null ? MARK_NOT_IN_LEDGER : '',
      venue: 'prediction',
    };
    const current = byThesis.get(row.thesis_id) ?? [];
    current.push(lot);
    byThesis.set(row.thesis_id, current);
  }

  const linked = predictionThesisIds(payload);
  return theses.map((thesis) => {
    const extra = byThesis.get(thesis.id) ?? [];
    const lots = [...thesis.lots.map((lot) => ({ ...lot, venue: lot.venue ?? 'equity' as const })), ...extra];
    const linkedVenues: DeskVenue[] = linked.has(thesis.id) ? ['prediction'] : [];
    if (thesis.venues?.includes('meme')) linkedVenues.push('meme');
    return {
      ...thesis,
      lots,
      venues: thesisVenuesFor(thesis, lots, linkedVenues),
    };
  });
}

export function predictionThesisIds(payload: PredictionMarketsPayload): Set<string> {
  const ids = new Set<string>();
  for (const row of payload.markets) if (row.thesis_id) ids.add(row.thesis_id);
  for (const row of payload.positions) if (row.thesis_id) ids.add(row.thesis_id);
  for (const row of payload.orders) if (row.thesis_id) ids.add(row.thesis_id);
  for (const row of payload.notes) if (row.thesis_id) ids.add(row.thesis_id);
  return ids;
}

export function filterTheses(theses: readonly ThesisRow[], filter: VenueFilter): ThesisRow[] {
  return theses.filter((row) => thesisMatchesVenue(row.venues, filter));
}

export function deskEvents(desk: DeskPayload): DeskTapeEvent[] {
  const equity: DeskTapeEvent[] = desk.catalysts.map((row: CatalystRow) => ({
    key: `eq-${row.id}`,
    venue: 'equity',
    name: row.symbol || '—',
    kind: row.catalyst_type,
    when: row.event_date,
    thesis_id: row.thesis_id,
    status: row.status,
    summary: row.summary,
  }));
  const prediction: DeskTapeEvent[] = predictionDesk(desk).markets.map((row) => ({
    key: `pm-${row.id}`,
    venue: 'prediction',
    name: row.slug?.trim() || clip(row.question, 40),
    kind: 'market_close',
    when: row.close_time,
    thesis_id: row.thesis_id,
    status: row.status,
    summary: row.question,
  }));
  const meme = memeEvents(memeDesk(desk));
  return [...equity, ...prediction, ...meme].sort((a, b) => (a.when || 'zzz').localeCompare(b.when || 'zzz'));
}

export function filterEvents(events: readonly DeskTapeEvent[], filter: VenueFilter): DeskTapeEvent[] {
  return events.filter((row) => filter === 'all' || row.venue === filter);
}

export function deskLessons(desk: DeskPayload, thesisId?: string): DeskLessonLine[] {
  const equity: DeskLessonLine[] = desk.lessons
    .filter((row: LessonRow) => !thesisId || row.thesis_id === thesisId)
    .map((row) => ({
      key: `eq-${row.id}`,
      venue: 'equity',
      thesis_id: row.thesis_id,
      kind: row.lesson_type,
      regime: row.market_regime,
      pending: !row.incorporated,
      summary: row.summary,
    }));
  const prediction: DeskLessonLine[] = predictionDesk(desk).notes
    .filter((row) => !thesisId || row.thesis_id === thesisId)
    .map((row) => ({
      key: `pm-${row.id}`,
      venue: 'prediction',
      thesis_id: row.thesis_id,
      kind: row.note_type,
      regime: 'prediction',
      pending: true,
      summary: row.body ? `${row.title} — ${row.body}` : row.title,
    }));
  const meme = memeLessons(memeDesk(desk), thesisId);
  return [...equity, ...prediction, ...meme];
}

export function filterLessons(rows: readonly DeskLessonLine[], filter: VenueFilter): DeskLessonLine[] {
  return rows.filter((row) => filter === 'all' || row.venue === filter);
}

export function latestPredictionPnl(payload: PredictionMarketsPayload): PredictionPnlRow | null {
  if (!payload.pnl.length) return null;
  return [...payload.pnl].sort((a, b) => b.as_of.localeCompare(a.as_of))[0] ?? null;
}

export function openPredictionCount(payload: PredictionMarketsPayload): number {
  return payload.positions.filter((row) => OPEN_POSITION.has(row.status.toLowerCase())).length;
}

export function venueChipLabel(venues: readonly DeskVenue[] | undefined): string {
  const list = venues?.length ? venues : (['equity'] as const);
  return list.map((venue) => venueShort(venue)).join(' ');
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
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

export function mapPredictionMarkets(input: {
  markets?: readonly LooseRow[];
  positions?: readonly LooseRow[];
  orders?: readonly LooseRow[];
  fills?: readonly LooseRow[];
  pnl?: readonly LooseRow[];
  notes?: readonly LooseRow[];
}): PredictionMarketsPayload {
  return {
    desk: 'ODDSBORNE',
    venue: 'prediction',
    markets: (input.markets ?? []).map((row) => ({
      id: text(row, 'id'),
      venue: text(row, 'venue') || 'polymarket',
      slug: optionalText(row, 'slug'),
      question: text(row, 'question'),
      status: text(row, 'status'),
      close_time: row.close_time == null ? null : requireIso(row.close_time as string | Date, 'pm_markets.close_time'),
      last_yes: asOptionalNumber(row.last_yes as string | number | null, 'pm_markets.last_yes'),
      last_no: asOptionalNumber(row.last_no as string | number | null, 'pm_markets.last_no'),
      last_marked_at: row.last_marked_at == null ? null : requireIso(row.last_marked_at as string | Date, 'pm_markets.last_marked_at'),
      thesis_id: optionalText(row, 'thesis_id'),
      rules_summary: optionalText(row, 'rules_summary'),
    })),
    positions: (input.positions ?? []).map((row) => ({
      id: text(row, 'id'),
      market_id: text(row, 'market_id'),
      account_key: text(row, 'account_key'),
      thesis_id: optionalText(row, 'thesis_id'),
      outcome: text(row, 'outcome'),
      status: text(row, 'status'),
      quantity: asFiniteNumber(row.quantity as string | number, 'pm_positions.quantity'),
      average_cost: asOptionalNumber(row.average_cost as string | number | null, 'pm_positions.average_cost'),
      mark: asOptionalNumber(row.mark as string | number | null, 'pm_positions.mark'),
      mark_at: row.mark_at == null ? null : requireIso(row.mark_at as string | Date, 'pm_positions.mark_at'),
      thesis_text: optionalText(row, 'thesis_text'),
    })),
    orders: (input.orders ?? []).map((row) => ({
      id: text(row, 'id'),
      market_id: text(row, 'market_id'),
      thesis_id: optionalText(row, 'thesis_id'),
      outcome: text(row, 'outcome'),
      side: text(row, 'side'),
      order_type: text(row, 'order_type'),
      size: asFiniteNumber(row.size as string | number, 'pm_orders.size'),
      price: asOptionalNumber(row.price as string | number | null, 'pm_orders.price'),
      status: text(row, 'status'),
      mode: text(row, 'mode'),
      venue_order_id: optionalText(row, 'venue_order_id'),
      submitted_at: row.submitted_at == null ? null : requireIso(row.submitted_at as string | Date, 'pm_orders.submitted_at'),
      created_at: requireIso(row.created_at as string | Date, 'pm_orders.created_at'),
    })),
    fills: (input.fills ?? []).map((row) => ({
      id: text(row, 'id'),
      order_id: text(row, 'order_id'),
      position_id: optionalText(row, 'position_id'),
      outcome: text(row, 'outcome'),
      side: text(row, 'side'),
      quantity: asFiniteNumber(row.quantity as string | number, 'pm_fills.quantity'),
      price: asFiniteNumber(row.price as string | number, 'pm_fills.price'),
      executed_at: requireIso(row.executed_at as string | Date, 'pm_fills.executed_at'),
    })),
    pnl: (input.pnl ?? []).map((row) => ({
      id: text(row, 'id'),
      account_key: text(row, 'account_key'),
      as_of: requireIso(row.as_of as string | Date, 'pm_pnl.as_of'),
      realized: asFiniteNumber(row.realized as string | number, 'pm_pnl.realized'),
      unrealized: asOptionalNumber(row.unrealized as string | number | null, 'pm_pnl.unrealized'),
      fees: asFiniteNumber(row.fees as string | number, 'pm_pnl.fees'),
      cash: asOptionalNumber(row.cash as string | number | null, 'pm_pnl.cash'),
      equity: asOptionalNumber(row.equity as string | number | null, 'pm_pnl.equity'),
      notes: optionalText(row, 'notes'),
    })),
    notes: (input.notes ?? []).map((row) => ({
      id: text(row, 'id'),
      market_id: optionalText(row, 'market_id'),
      thesis_id: optionalText(row, 'thesis_id'),
      note_type: text(row, 'note_type'),
      title: text(row, 'title'),
      body: text(row, 'body'),
      created_at: requireIso(row.created_at as string | Date, 'pm_notes.created_at'),
    })),
  };
}
