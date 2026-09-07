/**
 * Board CRT fill tape — phosphor ticker of real snapshot events.
 * Fills, steward marks, and snapshot freshness only. Never invent a price.
 */
import { assembleLeaderboard, type LeaderboardStanding } from './desk-leaderboard';
import type { DeskPayload, DeskRoutine, FillLogRow } from './ledger-types';
import { rowVenue, venueLabel, type DeskVenue } from './desk-venue';
import { memeDesk, memeFillLog } from './meme-book';
import { formatAmount, venueUnit, type MoneyUnit } from './money-units';
import { predictionDesk, predictionFillLog } from './prediction-book';

export const CRT_TAPE_MAX = 12;
export const CRT_TAPE_FILL_MAX = 8;

export const CRT_TAPE_KINDS = ['fill', 'mark', 'scan', 'snap'] as const;
export type CrtTapeKind = (typeof CRT_TAPE_KINDS)[number];

export type CrtTapeSteward = 'QNT' | 'ODD' | 'BND' | 'GHP';

export type CrtTapeLine = {
  id: string;
  kind: CrtTapeKind;
  glyph: string;
  steward: CrtTapeSteward;
  label: string;
  status: string;
  at: string;
};

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

export function crtStewardCode(venue: DeskVenue | null): CrtTapeSteward {
  if (venue === 'prediction') return 'ODD';
  if (venue === 'meme') return 'BND';
  if (venue === null) return 'GHP';
  return 'QNT';
}

export function compactCrtSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) return '—';
  const parts = trimmed.split(/\s*·\s*/);
  if (parts.length >= 2) {
    const head = parts[0] ?? '';
    const tail = parts[parts.length - 1] ?? '';
    const slug = tail.includes('-') ? (tail.split('-').pop() ?? tail) : tail;
    return `${clip(head, 6)}·${clip(slug, 8)}`;
  }
  return clip(trimmed, 10);
}

export function compactCrtQty(value: number | null): string {
  if (value === null) return '';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 10) return String(Math.round(value * 10) / 10);
  if (abs >= 1) return String(Math.round(value * 100) / 100);
  return String(Number(value.toPrecision(3)));
}

export function compactCrtPrice(value: number | null, unit: MoneyUnit): string {
  if (value === null) return '';
  return formatAmount(value, unit);
}

export function crtFillStatus(status: string): string {
  const value = status.toLowerCase();
  if (value === 'filled' || value === 'fill') return 'FILL';
  if (value === 'partial' || value === 'partially_filled') return 'PART';
  if (!status) return 'FILL';
  return clip(status.toUpperCase(), 4);
}

export function crtFillGlyph(side: string): string {
  return side.toLowerCase() === 'sell' ? '<' : '>';
}

export function formatCrtFillLabel(row: FillLogRow): string {
  const venue = rowVenue(row);
  const symbol = compactCrtSymbol(row.symbol || venueLabel(venue));
  const side = (row.side || '').toUpperCase();
  const qty = compactCrtQty(row.quantity);
  const price = compactCrtPrice(row.price, venueUnit(venue));
  const bits = [symbol];
  if (side) bits.push(side);
  if (qty) bits.push(qty);
  if (price) bits.push(`@${price}`);
  return bits.join(' ');
}

function compareTape(a: CrtTapeLine, b: CrtTapeLine): number {
  const byTime = b.at.localeCompare(a.at);
  if (byTime !== 0) return byTime;
  return a.id.localeCompare(b.id);
}

function snapshotFills(desk: DeskPayload): FillLogRow[] {
  const seen = new Set<string>();
  const rows: FillLogRow[] = [];
  const merged = [
    ...(desk.fill_log ?? []),
    ...predictionFillLog(predictionDesk(desk)),
    ...memeFillLog(memeDesk(desk)),
  ];
  for (const row of merged) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows.sort((a, b) => {
    const byTime = b.at.localeCompare(a.at);
    return byTime !== 0 ? byTime : a.symbol.localeCompare(b.symbol);
  });
}

function fillLine(row: FillLogRow): CrtTapeLine {
  const venue = rowVenue(row);
  return {
    id: `fill:${row.id}`,
    kind: 'fill',
    glyph: crtFillGlyph(row.side),
    steward: crtStewardCode(venue),
    label: formatCrtFillLabel(row),
    status: crtFillStatus(row.status),
    at: row.at,
  };
}

function snapLine(desk: DeskPayload): CrtTapeLine {
  return {
    id: `snap:${desk.generated_at}`,
    kind: 'snap',
    glyph: '#',
    steward: 'GHP',
    label: 'SNAP LEDGER',
    status: desk.source === 'snapshot' ? 'ONLINE' : desk.source.toUpperCase(),
    at: desk.generated_at,
  };
}

function markLine(row: LeaderboardStanding): CrtTapeLine | null {
  if (!row.last_marked) return null;
  const venue = row.venue;
  return {
    id: `mark:${row.id}:${row.last_marked}`,
    kind: 'mark',
    glyph: '*',
    steward: crtStewardCode(venue),
    label: `${row.steward} MARK`,
    status: 'MARK',
    at: row.last_marked,
  };
}

function scanLine(routine: DeskRoutine): CrtTapeLine | null {
  if (!routine.last_run_at) return null;
  const outcome = (routine.last_outcome ?? '').toLowerCase();
  return {
    id: `scan:${routine.id}:${routine.last_run_at}`,
    kind: 'scan',
    glyph: ':',
    steward: 'QNT',
    label: /scan/i.test(routine.name) ? 'SCAN' : 'RUN',
    status: outcome === 'passed' ? 'OK' : outcome === 'failed' ? 'FAIL' : 'RUN',
    at: routine.last_run_at,
  };
}

export function assembleCrtTape(desk: DeskPayload): CrtTapeLine[] {
  const fills = snapshotFills(desk).slice(0, CRT_TAPE_FILL_MAX).map(fillLine);
  const board = assembleLeaderboard(desk);
  const marks = board.rows
    .map(markLine)
    .filter((row): row is CrtTapeLine => row !== null);
  const scan = (desk.routines ?? [])
    .filter((row) => row.status === 'live')
    .map(scanLine)
    .find((row) => row !== null);
  const rows = [...fills, snapLine(desk), ...marks];
  if (scan) rows.push(scan);
  return rows.sort(compareTape).slice(0, CRT_TAPE_MAX);
}

export function crtTapeScrollText(lines: readonly CrtTapeLine[]): string {
  if (lines.length === 0) return 'SNAP LEDGER · not in ledger';
  return lines
    .map((row) => `${row.glyph} ${row.steward} ${row.label} ${row.status}`)
    .join('  ·  ');
}
