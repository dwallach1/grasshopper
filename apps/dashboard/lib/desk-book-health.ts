/**
 * Read-only Book health. Never invents a close or a mark.
 * Flags ODDSBORNE-class leftovers: an open ticket sitting on a stale mid,
 * or a market the catalog still calls open after its close_time.
 */
import { OPEN_POSITION } from './book-open-strip';
import { isMarkStale } from './desk-freshness';
import type { DeskPayload } from './ledger-types';
import { memeDesk } from './meme-book';
import { formatAmount } from './money-units';
import { breachDecidesAtOpen, escalatedBreachSentence, sessionPrintText, watchdogHealthSummary } from './ledger-watchdog';
import { predictionDesk } from './prediction-book';

export type DeskBookAlertKind =
  | 'stale_open'
  | 'resolved_still_open'
  | 'stale_catalog'
  | 'invalidation_breach'
  /** Equity marked through its line outside the regular session: decides at the open, not an exit. */
  | 'invalidation_review_at_open'
  | 'missing_invalidation'
  /** An add left the exit line at or below blended cost, and the trade did not record a scratch. */
  | 'line_at_or_below_cost';

export type DeskBookAlert = {
  kind: DeskBookAlertKind;
  steward: 'quantanamo' | 'oddsborne' | 'bandit';
  id: string;
  label: string;
  at: string | null;
  detail: string;
  /** Plain session name for `invalidation_review_at_open` (`premarket print`). */
  print?: string;
  /** Actionable breach past the next check or the 15-minute window. `detail` is the sell-now sentence. */
  escalated?: boolean;
};

export type DeskBookHealth = {
  marks_lagging: boolean;
  stale_opens: number;
  resolved_still_open: number;
  stale_catalog: number;
  /** v_ledger_watchdog backstop (0 when the views are unavailable). */
  invalidation_breaches: number;
  lots_missing_invalidation: number;
  integrity_issues: number;
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

  // Independent backstop: the ledger watchdog views (never invented marks).
  const watchdog = desk.watchdog;
  for (const lot of watchdog?.breaches ?? []) {
    const mark = lot.mark === null ? '—' : formatAmount(lot.mark, lot.unit);
    const line = lot.invalidation_price === null ? '—' : formatAmount(lot.invalidation_price, lot.unit);
    if (breachDecidesAtOpen(lot)) {
      // A pre / after-hours / closed equity print is not an exit: the rule counts regular-session trades.
      const print = sessionPrintText(lot.mark_session);
      alerts.push({
        kind: 'invalidation_review_at_open',
        steward: stewardSlug(lot.steward),
        id: `breach-${lot.lot_table}-${lot.lot_id}`,
        label: lot.instrument,
        at: lot.mark_at,
        detail: `${print} ${mark} under exit ${line} · decides at open`,
        print,
      });
      continue;
    }
    const sentence = lot.escalated && lot.breach_age_minutes !== null
      ? (lot.sentence ?? escalatedBreachSentence(lot.instrument, lot.breach_age_minutes))
      : null;
    if (sentence) {
      alerts.push({
        kind: 'invalidation_breach',
        steward: stewardSlug(lot.steward),
        id: `breach-${lot.lot_table}-${lot.lot_id}`,
        label: lot.instrument,
        at: lot.first_seen_at ?? lot.mark_at,
        detail: sentence,
        escalated: true,
      });
      continue;
    }
    alerts.push({
      kind: 'invalidation_breach',
      steward: stewardSlug(lot.steward),
      id: `breach-${lot.lot_table}-${lot.lot_id}`,
      label: lot.instrument,
      at: lot.mark_at,
      detail: `mark ${mark} at/below inval ${line}`,
    });
  }
  for (const issue of watchdog?.issues ?? []) {
    if (issue.check_name !== 'line_at_or_below_cost') continue;
    alerts.push({
      kind: 'line_at_or_below_cost',
      steward: stewardSlug(issue.steward),
      id: `line-cost-${issue.ref_table}-${issue.ref_id}`,
      label: issue.instrument ?? issue.ref_id,
      at: issue.at,
      detail: 'exit line is at or below the price paid',
    });
  }
  for (const lot of watchdog?.missing ?? []) {
    alerts.push({
      kind: 'missing_invalidation',
      steward: stewardSlug(lot.steward),
      id: `noinval-${lot.lot_table}-${lot.lot_id}`,
      label: lot.instrument,
      at: lot.mark_at,
      detail: 'open lot has no invalidation',
    });
  }

  const stale_opens = alerts.filter((row) => row.kind === 'stale_open').length;
  const resolved_still_open = alerts.filter((row) => row.kind === 'resolved_still_open').length;
  const stale_catalog = alerts.filter((row) => row.kind === 'stale_catalog').length;
  const counts = watchdogHealthSummary(watchdog);
  return {
    marks_lagging: stale_opens > 0 || resolved_still_open > 0 || stale_catalog > 0,
    stale_opens,
    resolved_still_open,
    stale_catalog,
    invalidation_breaches: counts.invalidation_breaches,
    lots_missing_invalidation: counts.lots_missing_invalidation,
    integrity_issues: counts.integrity_issues,
    alerts,
  };
}

function stewardSlug(value: string): DeskBookAlert['steward'] {
  return value === 'oddsborne' || value === 'bandit' ? value : 'quantanamo';
}

export function deskHealthSummary(health: DeskBookHealth): {
  marks_lagging: boolean;
  stale_opens: number;
  resolved_still_open: number;
  stale_catalog: number;
  invalidation_breaches: number;
  lots_missing_invalidation: number;
  integrity_issues: number;
} {
  return {
    marks_lagging: health.marks_lagging,
    stale_opens: health.stale_opens,
    resolved_still_open: health.resolved_still_open,
    stale_catalog: health.stale_catalog,
    invalidation_breaches: health.invalidation_breaches,
    lots_missing_invalidation: health.lots_missing_invalidation,
    integrity_issues: health.integrity_issues,
  };
}
