import { NOT_IN_LEDGER } from './book-performance';
import type {
  ExposureRow,
  FillLogRow,
  FillRow,
  IntentRow,
  PositionRow,
  ProposalRow,
  ThesisLot,
  ThesisRow,
  ThesisSymbolLink,
} from './ledger-types';

export const NO_POSITION = 'no position';
export const MARK_NOT_IN_LEDGER = 'mark not in ledger';
export const AGENTIC_LAST4 = '7638';

const LIVE_PROPOSAL_STATUSES = new Set(['filled', 'approved', 'submitted', 'open']);
const HELD_ROLES = new Set(['held']);
const FILLED_INTENT_STATUSES = new Set(['filled', 'partially_filled']);

type OpenLot = {
  symbol: string;
  quantity: number;
  average_cost: number | null;
  mark: number | null;
};

function costBasis(quantity: number, averageCost: number | null): number | null {
  if (averageCost === null) return null;
  return quantity * averageCost;
}

function pnlFor(lot: OpenLot) {
  if (lot.mark === null) return { pnl: null, note: MARK_NOT_IN_LEDGER };
  if (lot.average_cost === null) return { pnl: null, note: NOT_IN_LEDGER };
  return { pnl: (lot.mark - lot.average_cost) * lot.quantity, note: '' };
}

/**
 * Latest Agentic book only. Newer `observed_at` wins; if last4 7638 is present
 * at that timestamp, drop other accounts so personal books cannot leak in.
 */
export function latestBookExposures(rows: ExposureRow[]): ExposureRow[] {
  if (rows.length === 0) return [];
  const agentic = rows.filter((row) => row.account_last4 === AGENTIC_LAST4);
  const pool = agentic.length > 0 ? agentic : rows;
  let latestAt = pool[0]!.observed_at;
  for (const row of pool) {
    if (row.observed_at > latestAt) latestAt = row.observed_at;
  }
  return pool.filter((row) => row.observed_at === latestAt);
}

export function openLotsFromLedger(input: {
  exposures: ExposureRow[];
  positions: PositionRow[];
  marks?: ReadonlyMap<string, number>;
}): Map<string, OpenLot> {
  const lots = new Map<string, OpenLot>();
  for (const row of input.positions) {
    lots.set(row.symbol, {
      symbol: row.symbol,
      quantity: row.quantity,
      average_cost: row.average_cost,
      mark: input.marks?.get(row.symbol) ?? null,
    });
  }
  for (const row of latestBookExposures(input.exposures)) {
    lots.set(row.symbol, {
      symbol: row.symbol,
      quantity: row.quantity,
      average_cost: row.average_buy_price,
      mark: input.marks?.get(row.symbol) ?? null,
    });
  }
  return lots;
}

function claimSymbols(input: {
  lots: Map<string, OpenLot>;
  proposals: ProposalRow[];
  links: ThesisSymbolLink[];
}): Map<string, Set<string>> {
  const claimed = new Map<string, Set<string>>();
  const add = (thesisId: string | null, symbol: string) => {
    if (!thesisId || !input.lots.has(symbol)) return;
    const current = claimed.get(thesisId) ?? new Set<string>();
    current.add(symbol);
    claimed.set(thesisId, current);
  };
  for (const proposal of input.proposals) {
    if (!LIVE_PROPOSAL_STATUSES.has(proposal.status.toLowerCase())) continue;
    add(proposal.thesis_id, proposal.symbol);
  }
  for (const link of input.links) {
    if (!HELD_ROLES.has(link.role.toLowerCase())) continue;
    add(link.thesis_id, link.symbol);
  }
  return claimed;
}

function sideFor(thesisId: string, symbol: string, lot: OpenLot, proposals: ProposalRow[]): string {
  const match = proposals.find((row) =>
    row.thesis_id === thesisId
    && row.symbol === symbol
    && LIVE_PROPOSAL_STATUSES.has(row.status.toLowerCase()),
  );
  if (match) return match.side;
  return lot.quantity < 0 ? 'sell' : 'buy';
}

/**
 * Bind a thesis to an open Agentic lot only via a live trade_proposal
 * (filled/approved/submitted/open) or thesis_symbols.role = held.
 * Candidate/member watchlist tags do not count as skin-in-the-game.
 */
export function attachThesisLots(
  theses: ThesisRow[],
  input: {
    links: ThesisSymbolLink[];
    proposals: ProposalRow[];
    exposures: ExposureRow[];
    positions: PositionRow[];
    marks?: ReadonlyMap<string, number>;
  },
): ThesisRow[] {
  const lots = openLotsFromLedger(input);
  const claimed = claimSymbols({ lots, proposals: input.proposals, links: input.links });
  return theses.map((thesis) => {
    const symbols = claimed.get(thesis.id);
    if (!symbols || symbols.size === 0) return { ...thesis, lots: [] };
    const attached: ThesisLot[] = [...symbols].sort().map((symbol) => {
      const lot = lots.get(symbol);
      if (!lot) {
        return {
          symbol,
          side: 'buy',
          quantity: 0,
          average_cost: null,
          invested: null,
          mark: null,
          pnl: null,
          note: NO_POSITION,
        };
      }
      const { pnl, note } = pnlFor(lot);
      return {
        symbol,
        side: sideFor(thesis.id, symbol, lot, input.proposals),
        quantity: lot.quantity,
        average_cost: lot.average_cost,
        invested: costBasis(lot.quantity, lot.average_cost),
        mark: lot.mark,
        pnl,
        note,
      };
    });
    return { ...thesis, lots: attached };
  });
}

function isAgenticIntent(intent: IntentRow | undefined): boolean {
  if (!intent) return true;
  if (!intent.account_key) return true;
  return /agentic|7638/i.test(intent.account_key);
}

function compareFillLog(a: FillLogRow, b: FillLogRow): number {
  const byTime = b.at.localeCompare(a.at);
  if (byTime !== 0) return byTime;
  return a.symbol.localeCompare(b.symbol);
}

function priceFromIntent(intent: IntentRow): number | null {
  if (intent.quantity === null || intent.notional === null || intent.quantity === 0) return null;
  return intent.notional / intent.quantity;
}

/**
 * Home fill tape. Prefer `broker_fills`; if that table is empty, show filled
 * trade_intents. Never invent a price — derive from ledger qty/notional only.
 */
export function assembleFillLog(input: {
  fills: FillRow[];
  intents: IntentRow[];
}): FillLogRow[] {
  const intentsById = new Map(input.intents.map((row) => [row.id, row]));
  if (input.fills.length > 0) {
    const rows: FillLogRow[] = [];
    for (const fill of input.fills) {
      const intent = intentsById.get(fill.trade_intent_id);
      if (intent && !isAgenticIntent(intent)) continue;
      const quantity = fill.quantity;
      const price = fill.price;
      rows.push({
        id: fill.id,
        at: fill.executed_at,
        symbol: intent?.symbol ?? '',
        side: intent?.side ?? '',
        quantity,
        price,
        notional: quantity * price,
        status: intent?.status ?? 'filled',
        source: 'broker_fill',
        note: intent ? '' : 'intent not in ledger',
      });
    }
    return rows.sort(compareFillLog);
  }

  return input.intents
    .filter((row) => FILLED_INTENT_STATUSES.has(row.status.toLowerCase()))
    .filter((row) => isAgenticIntent(row))
    .map((intent) => {
      const price = priceFromIntent(intent);
      return {
        id: intent.id,
        at: intent.created_at,
        symbol: intent.symbol,
        side: intent.side,
        quantity: intent.quantity,
        price,
        notional: intent.notional,
        status: intent.status,
        source: 'filled_intent' as const,
        note: price === null ? 'price not in ledger' : 'broker fills not in ledger',
      };
    })
    .sort(compareFillLog);
}

export function fillLogCaption(rows: FillLogRow[]): string {
  if (rows.length === 0) return NOT_IN_LEDGER;
  const sources = new Set(rows.map((row) => row.source));
  if (sources.size === 1 && sources.has('broker_fill')) return 'broker fills';
  if (sources.size === 1 && sources.has('filled_intent')) {
    return 'filled intents · broker fills not in ledger';
  }
  return 'fills';
}
