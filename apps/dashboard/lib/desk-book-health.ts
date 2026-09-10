/**
 * Read-only Book health. Never invents a close or a mark.
 * Flags ODDSBORNE-class leftovers: an open ticket sitting on a stale mid,
 * or a market the catalog still calls open after its close_time.
 */
import { OPEN_POSITION } from './book-open-strip';
import { isMarkStale } from './desk-freshness';
import type { DeskPayload } from './ledger-types';
import { memeDesk } from './meme-book';
import { predictionDesk } from './prediction-book';

export type DeskBookAlertKind = 'stale_open' | 'resolved_still_open' | 'stale_catalog';

export type DeskBookAlert = {
  kind: DeskBookAlertKind;
  steward: 'oddsborne' | 'bandit';
  id: string;
  label: string;
  at: string | null;
  detail: string;
};

export type DeskBookHealth = {
  marks_lagging: boolean;
  stale_opens: number;
  resolved_still_open: number;
  stale_catalog: number;
  alerts: DeskBookAlert[];
};

function isLiveStatus(status: string): boolean {
  return OPEN_POSITION.has(status.trim().toLowerCase());
}

function pastClose(closeTime: string | null | undefined, nowMs: number): boolean {
  if (!closeTime) return false;
  const ms = Date.parse(closeTime);
  return Number.isFinite(ms) && ms < nowMs;
}

export function assembleDeskBookHealth(desk: DeskPayload, nowMs: number): DeskBookHealth {
  const alerts: DeskBookAlert[] = [];
  const predictions = predictionDesk(desk);
  const meme = memeDesk(desk);
  const markets = new Map(predictions.markets.map((row) => [row.id, row]));
  const tokens = new Map(meme.tokens.map((row) => [row.id, row]));

  for (const position of predictions.positions) {
    const market = markets.get(position.market_id);
    const label = market?.slug ?? market?.question ?? position.market_id;
    if (isLiveStatus(position.status) && isMarkStale(position.mark_at, nowMs)) {
      alerts.push({
        kind: 'stale_open',
        steward: 'oddsborne',
        id: `pm-open-${position.id}`,
        label,
        at: position.mark_at,
        detail: 'open ticket mark older than 6h',
      });
    }
    const marketClosed = market
      ? !isLiveStatus(market.status) || pastClose(market.close_time, nowMs)
      : false;
    if (isLiveStatus(position.status) && marketClosed) {
      alerts.push({
        kind: 'resolved_still_open',
        steward: 'oddsborne',
        id: `pm-resolved-${position.id}`,
        label,
        at: market?.close_time ?? position.mark_at,
        detail: 'open ticket on a resolved or past-close market',
      });
    }
  }

  for (const market of predictions.markets) {
    if (isLiveStatus(market.status) && pastClose(market.close_time, nowMs)) {
      const already = alerts.some(
        (row) => row.kind === 'resolved_still_open' && row.label === (market.slug ?? market.question),
      );
      if (!already) {
        alerts.push({
          kind: 'resolved_still_open',
          steward: 'oddsborne',
          id: `pm-market-${market.id}`,
          label: market.slug ?? market.question,
          at: market.close_time,
          detail: 'market still open after close_time',
        });
      }
    }
    const laterClose = predictions.positions.find((position) => (
      position.market_id === market.id
      && position.closed_at
      && market.last_marked_at
      && position.closed_at > market.last_marked_at
    ));
    if (
      isLiveStatus(market.status)
      && !pastClose(market.close_time, nowMs)
      && laterClose
      && isMarkStale(market.last_marked_at, nowMs)
    ) {
      alerts.push({
        kind: 'stale_catalog',
        steward: 'oddsborne',
        id: `pm-catalog-${market.id}`,
        label: market.slug ?? market.question,
        at: market.last_marked_at,
        detail: 'market last_yes older than a later position close',
      });
    }
  }

  for (const position of meme.positions) {
    const token = tokens.get(position.token_id);
    const label = token?.symbol ?? token?.name ?? position.token_id;
    if (isLiveStatus(position.status) && isMarkStale(position.mark_at, nowMs)) {
      alerts.push({
        kind: 'stale_open',
        steward: 'bandit',
        id: `meme-open-${position.id}`,
        label,
        at: position.mark_at,
        detail: 'open ticket mark older than 6h',
      });
    }
    if (isLiveStatus(position.status) && token && !isLiveStatus(token.status)) {
      alerts.push({
        kind: 'resolved_still_open',
        steward: 'bandit',
        id: `meme-resolved-${position.id}`,
        label,
        at: position.mark_at,
        detail: 'open ticket on a retired token',
      });
    }
  }

  const stale_opens = alerts.filter((row) => row.kind === 'stale_open').length;
  const resolved_still_open = alerts.filter((row) => row.kind === 'resolved_still_open').length;
  const stale_catalog = alerts.filter((row) => row.kind === 'stale_catalog').length;
  return {
    marks_lagging: stale_opens > 0 || resolved_still_open > 0 || stale_catalog > 0,
    stale_opens,
    resolved_still_open,
    stale_catalog,
    alerts,
  };
}

export function deskHealthSummary(health: DeskBookHealth): {
  marks_lagging: boolean;
  stale_opens: number;
  resolved_still_open: number;
  stale_catalog: number;
} {
  return {
    marks_lagging: health.marks_lagging,
    stale_opens: health.stale_opens,
    resolved_still_open: health.resolved_still_open,
    stale_catalog: health.stale_catalog,
  };
}
