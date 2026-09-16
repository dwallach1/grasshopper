/**
 * Map ledger time series into Liveline `{ time, value }` points.
 *
 * `time` is unix seconds (Liveline’s clock). `value` is a real mark from the
 * desk payload — never an interpolated price, never SOL→USD, never 0% for a
 * missing start. Visual spline between two ledger points is Liveline chrome,
 * not a new mark.
 *
 * Sources:
 * - QUANTANAMO equity/cash: Agentic `account_snapshots` (`total_value` / `cash`)
 * - ODDSBORNE equity/cash: `pm_pnl.equity` / `pm_pnl.cash`
 * - BANDIT equity/cash: `meme_pnl.equity_sol` / `meme_pnl.cash_sol`
 * - Fill clocks: last-known ledger equity/cash stamped at `fill_log.at`
 *   (LOCF of a real mark — not fill price, not invented P/L)
 *
 * Board hero is every live steward’s return curve on a shared % axis
 * (`all_pct`). Each book is % vs that book’s own start — never FX, never a
 * summed USD+SOL “desk NAV”. Standings still rank the same %. Book ALL does
 * not overlay raw dollars.
 */
import { agenticSnapshots } from './book-performance';
import { AVATAR_COLORS } from './desk-team';
import { rowVenue } from './desk-venue';
import type { AccountRow, DeskPayload, FillLogRow } from './ledger-types';
import {
  latestMemePnl,
  memeDesk,
  memeEquitySeries,
  memeStartEquity,
} from './meme-book';
import type { MoneyUnit } from './money-units';
import { formatAmount } from './money-units';
import {
  latestPredictionPnl,
  predictionDesk,
  predictionEquitySeries,
  predictionStartEquity,
} from './prediction-book';

export const DAY_SECS = 86_400;
export const DEGEN_ABS_PCT = 8;
export const LIVELINE_EMPTY = 'not in ledger';
/** Liveline default: 8% of the remaining gap per rAF tick (~60fps). */
export const LIVELINE_LERP_SPEED = 0.08;
export const LIVELINE_SNAP_EPS = 0.01;
/** Warm parchment stroke — Levla beige, not neon DeFi. */
export const LIVELINE_PARCHMENT = '#a8906a';
/**
 * Quiet inks for the Board % overlay. Distinct on cream, not avatar neon
 * (`#22c55e` / `#3b82f6` / `#ef4444`).
 */
export const LIVELINE_PARCHMENT_INKS: Record<LivelineBookId, string> = {
  quantanamo: '#7a6b3d',
  oddsborne: '#5a6e7c',
  bandit: '#9a5840',
};
export const BOARD_HERO_CAPTION = '% vs each book’s own start · no FX';
export const BOARD_HERO_EMPTY = 'no ranked book in ledger';

export type LivelineClock = {
  time: number;
  value: number;
};

export type LivelineUnit = MoneyUnit | 'PCT';

export type LivelineBookId = 'quantanamo' | 'oddsborne' | 'bandit';

export type LivelineWindowOpt = {
  label: string;
  secs: number;
};

export type LivelineBookCurve = {
  id: LivelineBookId;
  label: string;
  color: string;
  unit: MoneyUnit;
  source: string;
  equity: LivelineClock[];
  cash: LivelineClock[];
  pct: LivelineClock[];
  start: number | null;
  now: number | null;
  return_pct: number | null;
  empty_text: string;
};

export type LivelineOverlay = {
  id: string;
  label: string;
  color: string;
  data: LivelineClock[];
  value: number;
};

export type DeskLiveline = {
  books: LivelineBookCurve[];
  all_pct: LivelineOverlay[];
};

type BookMeta = {
  label: string;
  color: string;
  unit: MoneyUnit;
};

function bookMeta(id: LivelineBookId): BookMeta {
  if (id === 'oddsborne') return { label: 'ODDSBORNE', color: AVATAR_COLORS.blue, unit: 'USD' };
  if (id === 'bandit') return { label: 'BANDIT', color: AVATAR_COLORS.red, unit: 'SOL' };
  return { label: 'QUANTANAMO', color: AVATAR_COLORS.green, unit: 'USD' };
}

export function isoToLivelineTime(iso: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return ms / 1000;
}

export function mergeLivelineClocks(rows: readonly LivelineClock[]): LivelineClock[] {
  const byTime = new Map<number, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.time) || !Number.isFinite(row.value)) continue;
    byTime.set(row.time, row.value);
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

export function clocksFromIso(
  rows: ReadonlyArray<{ as_of: string; value: number | null }>,
): LivelineClock[] {
  const clocks: LivelineClock[] = [];
  for (const row of rows) {
    if (row.value === null || !Number.isFinite(row.value)) continue;
    const time = isoToLivelineTime(row.as_of);
    if (time === null) continue;
    clocks.push({ time, value: row.value });
  }
  return mergeLivelineClocks(clocks);
}

/**
 * Last-observation-carried-forward onto fill clocks.
 * Value stays the latest ledger equity/cash at or before the fill.
 * Fill price and notional are ignored.
 */
export function stampFillsOnCurve(
  points: readonly LivelineClock[],
  fillIsos: readonly string[],
): LivelineClock[] {
  if (points.length === 0) return [];
  const extra: LivelineClock[] = [];
  for (const iso of fillIsos) {
    const time = isoToLivelineTime(iso);
    if (time === null) continue;
    let last: LivelineClock | null = null;
    for (const point of points) {
      if (point.time <= time) last = point;
      else break;
    }
    if (last === null) continue;
    extra.push({ time, value: last.value });
  }
  return mergeLivelineClocks([...points, ...extra]);
}

export function percentClocks(
  points: readonly LivelineClock[],
  start: number | null,
): LivelineClock[] {
  if (start === null || !(start > 0) || !Number.isFinite(start)) return [];
  return points.map((point) => ({
    time: point.time,
    value: ((point.value - start) / start) * 100,
  }));
}

export function latestClockValue(points: readonly LivelineClock[]): number | null {
  const last = points[points.length - 1];
  return last ? last.value : null;
}

/** Last ledger clock as ISO. Null when the series is empty — never a fake now. */
export function livelineStampIso(points: readonly LivelineClock[]): string | null {
  const last = points[points.length - 1];
  if (!last) return null;
  const ms = last.time * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Approach `target` at Liveline's 8%/frame. Snap when close so the overlay
 * does not hunt forever. Idle / first paint must not invent in-between marks.
 */
export function lerpToward(
  shown: number,
  target: number,
  speed = LIVELINE_LERP_SPEED,
): number {
  if (!Number.isFinite(shown) || !Number.isFinite(target)) return target;
  const next = shown + (target - shown) * speed;
  if (Math.abs(next - target) < LIVELINE_SNAP_EPS) return target;
  return next;
}

/** Hold or snap when idle/stale so a weekend book does not fake a walk. */
export function lerpMark(
  shown: number | null,
  target: number | null,
  idle: boolean,
): number | null {
  if (target === null || !Number.isFinite(target)) return null;
  if (shown === null || !Number.isFinite(shown) || idle) return target;
  return lerpToward(shown, target);
}

/** Freeze the rAF loop when marks are stale, the tab is hidden, or motion is reduced. */
export function livelineIdle(stale: boolean, reduce: boolean, hidden: boolean): boolean {
  return stale || reduce || hidden;
}

export function seriesSpanSecs(points: readonly LivelineClock[], nowSecs: number): number {
  const first = points[0];
  if (!first) return DAY_SECS;
  return Math.max(60, nowSecs - first.time);
}

export function livelineWindows(
  points: readonly LivelineClock[],
  nowSecs: number,
): LivelineWindowOpt[] {
  const span = seriesSpanSecs(points, nowSecs);
  const last = points[points.length - 1];
  const lastAge = last ? Math.max(0, nowSecs - last.time) : 0;
  const all = { label: 'all', secs: span };
  const lookbacks: LivelineWindowOpt[] = [
    { label: '1d', secs: DAY_SECS },
    { label: '7d', secs: 7 * DAY_SECS },
    { label: '30d', secs: 30 * DAY_SECS },
  ];
  // Liveline uses windows[0] as the initial view. Keep `all` first so a
  // sparse book whose last mark is older than 1d is not an empty canvas.
  const shown = lookbacks.filter((row) => row.secs > lastAge + 60 && row.secs < span);
  return [all, ...shown];
}

export function livelineDegen(returnPct: number | null): boolean {
  if (returnPct === null || !Number.isFinite(returnPct)) return false;
  return Math.abs(returnPct) >= DEGEN_ABS_PCT;
}

export function formatLivelineValue(value: number, unit: LivelineUnit): string {
  if (unit === 'PCT') {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  }
  return formatAmount(value, unit);
}

export function formatLivelineTime(time: number, spanSecs: number): string {
  const date = new Date(time * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  if (spanSecs >= 2 * DAY_SECS) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function assembleLiveline(desk: DeskPayload): DeskLiveline {
  // COINTANAMO has no book curve in this assembler — do not invent one.
  const books = [
    quantanamoCurve(desk),
    oddsborneCurve(desk),
    banditCurve(desk),
  ];
  const all_pct: LivelineOverlay[] = [];
  for (const book of books) {
    const last = book.pct[book.pct.length - 1];
    if (!last) continue;
    all_pct.push({
      id: book.id,
      label: book.label,
      color: parchmentInk(book.id),
      data: book.pct,
      value: last.value,
    });
  }
  return { books, all_pct };
}

export function bookCurve(desk: DeskLiveline, id: LivelineBookId): LivelineBookCurve | null {
  return desk.books.find((row) => row.id === id) ?? null;
}

export function parchmentInk(id: string): string {
  if (id === 'oddsborne') return LIVELINE_PARCHMENT_INKS.oddsborne;
  if (id === 'bandit') return LIVELINE_PARCHMENT_INKS.bandit;
  if (id === 'quantanamo') return LIVELINE_PARCHMENT_INKS.quantanamo;
  return LIVELINE_PARCHMENT;
}

export type BoardHeroLiveline = {
  series: LivelineOverlay[];
  unit: 'PCT';
  showValue: boolean;
  emptyText: string;
  caption: string;
};

/**
 * Board hero mapping: one parchment Liveline of every live steward’s % curve.
 * `showValue` only when a single book is plotted — that number is that book’s
 * %, never QUANTANAMO dollars as a desk-wide NAV. No equal-weight composite
 * line: the shared view is the overlay itself.
 */
export function boardHeroLiveline(line: DeskLiveline): BoardHeroLiveline {
  const series = line.all_pct.map((row) => ({
    ...row,
    color: parchmentInk(row.id),
  }));
  return {
    series,
    unit: 'PCT',
    showValue: series.length === 1,
    emptyText: series.length ? LIVELINE_EMPTY : BOARD_HERO_EMPTY,
    caption: BOARD_HERO_CAPTION,
  };
}

/** Idle the hero only when every plotted book’s last equity mark is stale. */
export function boardHeroIdle(
  line: DeskLiveline,
  nowMs: number,
  stale: (at: string | null, now: number) => boolean,
): boolean {
  const stamps = line.books
    .filter((book) => book.pct.length > 0)
    .map((book) => livelineStampIso(book.equity));
  if (stamps.length === 0) return true;
  return stamps.every((iso) => stale(iso, nowMs));
}

function finishCurve(
  id: LivelineBookId,
  source: string,
  equity: LivelineClock[],
  cash: LivelineClock[],
  start: number | null,
): LivelineBookCurve {
  const meta = bookMeta(id);
  const now = latestClockValue(equity);
  const return_pct = start !== null && now !== null && start > 0
    ? ((now - start) / start) * 100
    : null;
  return {
    id,
    label: meta.label,
    color: meta.color,
    unit: meta.unit,
    source,
    equity,
    cash,
    pct: percentClocks(equity, start),
    start,
    now,
    return_pct,
    empty_text: equity.length ? '' : `${meta.label} ${LIVELINE_EMPTY}`,
  };
}

function quantanamoCurve(desk: DeskPayload): LivelineBookCurve {
  const rows = agenticNavRows(desk);
  const fills = fillTimes(desk.fill_log ?? [], 'equity');
  const equity = stampFillsOnCurve(
    clocksFromIso(rows.map((row) => ({ as_of: row.as_of, value: row.nav }))),
    fills,
  );
  const cash = stampFillsOnCurve(
    clocksFromIso(rows.map((row) => ({ as_of: row.as_of, value: row.cash }))),
    fills,
  );
  return finishCurve(
    'quantanamo',
    'account_snapshots.total_value (Agentic) · fill clocks LOCF',
    equity,
    cash,
    desk.book.starting_nav,
  );
}

function oddsborneCurve(desk: DeskPayload): LivelineBookCurve {
  const payload = predictionDesk(desk);
  const startMark = predictionStartEquity(payload);
  const fills = [
    ...payload.fills.map((row) => row.executed_at),
    ...fillTimes(desk.fill_log ?? [], 'prediction'),
  ];
  const equity = stampFillsOnCurve(
    clocksFromIso(predictionEquitySeries(payload).map((row) => ({
      as_of: row.as_of,
      value: row.equity,
    }))),
    fills,
  );
  const cash = stampFillsOnCurve(
    clocksFromIso([...payload.pnl]
      .sort((a, b) => a.as_of.localeCompare(b.as_of))
      .map((row) => ({ as_of: row.as_of, value: row.cash }))),
    fills,
  );
  const latest = latestPredictionPnl(payload);
  const start = startMark?.equity ?? null;
  const curve = finishCurve(
    'oddsborne',
    `pm_pnl.${startMark?.source ?? 'equity'} · fill clocks LOCF`,
    equity,
    cash,
    start,
  );
  if (curve.now === null && latest?.equity !== null && latest?.equity !== undefined) {
    return { ...curve, now: latest.equity };
  }
  return curve;
}

function banditCurve(desk: DeskPayload): LivelineBookCurve {
  const payload = memeDesk(desk);
  const startMark = memeStartEquity(payload);
  const fills = [
    ...payload.fills.map((row) => row.executed_at),
    ...fillTimes(desk.fill_log ?? [], 'meme'),
  ];
  const equity = stampFillsOnCurve(
    clocksFromIso(memeEquitySeries(payload).map((row) => ({
      as_of: row.as_of,
      value: row.equity_sol,
    }))),
    fills,
  );
  const cash = stampFillsOnCurve(
    clocksFromIso([...payload.pnl]
      .sort((a, b) => a.as_of.localeCompare(b.as_of))
      .map((row) => ({ as_of: row.as_of, value: row.cash_sol }))),
    fills,
  );
  const latest = latestMemePnl(payload);
  const start = startMark?.equity_sol ?? null;
  const curve = finishCurve(
    'bandit',
    `meme_pnl.${startMark?.source ?? 'equity_sol'} · fill clocks LOCF`,
    equity,
    cash,
    start,
  );
  if (curve.now === null && latest?.equity_sol !== null && latest?.equity_sol !== undefined) {
    return { ...curve, now: latest.equity_sol };
  }
  return curve;
}

function fillTimes(rows: readonly FillLogRow[], venue: FillLogRow['venue']): string[] {
  const times: string[] = [];
  for (const row of rows) {
    if (rowVenue(row) !== venue) continue;
    times.push(row.at);
  }
  return times;
}

function agenticNavRows(desk: DeskPayload): Array<{ as_of: string; nav: number; cash: number | null }> {
  const snapshots = oldestAgentic(desk.snapshots ?? []);
  const series: Array<{ as_of: string; nav: number; cash: number | null }> = snapshots.map((row) => ({
    as_of: row.observed_at,
    nav: row.total_value,
    cash: row.cash,
  }));
  const startAt = startTimestamp(desk.book.vs_start_note);
  const startNav = desk.book.starting_nav;
  const first = series[0];
  if (startAt && startNav !== null && (!first || first.as_of > startAt)) {
    series.unshift({ as_of: startAt, nav: startNav, cash: null });
  }
  return series;
}

function oldestAgentic(rows: readonly AccountRow[]): AccountRow[] {
  return [...agenticSnapshots([...rows])].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

function startTimestamp(note: string | null | undefined): string | null {
  if (!note) return null;
  const match = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(note);
  return match?.[0] ?? null;
}
