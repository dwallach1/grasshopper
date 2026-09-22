/**
 * One presence per steward, from the public desk payload only.
 * Board and Team both read this map. The avatar carries the state —
 * no second chip.
 *
 * Priority: blocked, then working, then waiting, then a brief done
 * settle, then idle. Blocked uses the same stale-mark and missing-gate
 * facts the freshness chips and learning pulse already show.
 */
import { assembleBookHoldings, isClosedPositionStatus } from './book-holdings';
import { stewardThinking } from './desk-avatar';
import { assembleDeskBookHealth } from './desk-book-health';
import { isMarkFresh } from './desk-freshness';
import { HEARTBEAT_FRESH_MS, deskTeam, teamCards } from './desk-team';
import type { DeskPayload } from './ledger-types';
import { memeDesk } from './meme-book';
import { predictionDesk } from './prediction-book';

export const STEWARD_PRESENCES = ['idle', 'working', 'waiting', 'blocked', 'done'] as const;

export type StewardPresence = (typeof STEWARD_PRESENCES)[number];

export type StewardPresenceState = {
  presence: StewardPresence;
  /** 1 at the close, easing to 0 across PRESENCE_DONE_MS. Other states stay 0. */
  settle: number;
};

/** Just-closed lots keep the settle pulse for two minutes, then idle. */
export const PRESENCE_DONE_MS = 2 * 60 * 1000;

/**
 * In-flight intents and fills use the same 15-minute window as a fresh
 * heartbeat. A mark refresh alone does not count as venue work.
 */
export const PRESENCE_ACTIVITY_MS = HEARTBEAT_FRESH_MS;

/** Quicker morph while working; calm blink while idle. */
export const PRESENCE_TEMPO = {
  idle: 0.56,
  working: 1.85,
  waiting: 0.74,
  blocked: 0.44,
  done: 1,
} as const satisfies Record<StewardPresence, number>;

const BOOK_SLUGS = ['quantanamo', 'oddsborne', 'bandit'] as const;

type BookSlug = (typeof BOOK_SLUGS)[number];

const OPENISH = new Set(['open', 'active', 'closing']);

/** Terminal order statuses, plus paper — paper is not a live venue. */
const TERMINAL_ORDER = new Set([
  'filled',
  'canceled',
  'cancelled',
  'rejected',
  'expired',
  'paper',
]);

const QUIET_BOOK: BookSignals = {
  blocked: false,
  inFlightRecent: false,
  recentFillWhileOpen: false,
  openRisk: false,
  closeAgeMs: null,
};

type BookSignals = {
  blocked: boolean;
  inFlightRecent: boolean;
  recentFillWhileOpen: boolean;
  openRisk: boolean;
  closeAgeMs: number | null;
};

type Stamp = string | null | undefined;

export function presenceTempo(presence: StewardPresence): number {
  return PRESENCE_TEMPO[presence];
}

/** Ease from a full settle pulse at the close to nothing at the end of the window. */
export function presenceSettle(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  if (ageMs >= PRESENCE_DONE_MS) return 0;
  const t = ageMs / PRESENCE_DONE_MS;
  return 1 - t * t;
}

export function stewardPresences(desk: DeskPayload, nowMs: number): Map<string, StewardPresenceState> {
  const books = bookSignals(desk, nowMs);
  const cards = teamCards(deskTeam(desk));
  const statusBySlug = new Map(cards.map((card) => [card.slug, card.status]));
  const slugs = new Set<string>([...statusBySlug.keys(), ...BOOK_SLUGS]);
  const faces = new Map<string, StewardPresenceState>();
  for (const slug of slugs) {
    const book = isBookSlug(slug) ? books.get(slug) ?? QUIET_BOOK : QUIET_BOOK;
    faces.set(slug, resolvePresence(stewardThinking(statusBySlug.get(slug) ?? ''), book));
  }
  return faces;
}

export function stewardPresence(desk: DeskPayload, slug: string, nowMs: number): StewardPresenceState {
  return stewardPresences(desk, nowMs).get(slug) ?? { presence: 'idle', settle: 0 };
}

function resolvePresence(scan: boolean, book: BookSignals): StewardPresenceState {
  if (book.blocked) return { presence: 'blocked', settle: 0 };
  if (scan || book.inFlightRecent || book.recentFillWhileOpen) {
    return { presence: 'working', settle: 0 };
  }
  if (book.openRisk) return { presence: 'waiting', settle: 0 };
  if (book.closeAgeMs !== null && book.closeAgeMs < PRESENCE_DONE_MS) {
    return { presence: 'done', settle: presenceSettle(book.closeAgeMs) };
  }
  return { presence: 'idle', settle: 0 };
}

function bookSignals(desk: DeskPayload, nowMs: number): Map<BookSlug, BookSignals> {
  const health = assembleDeskBookHealth(desk, nowMs);
  const blockedByHealth = new Set(health.alerts.map((alert) => alert.steward));
  const missing = missingGateSlugs(desk);
  const equityOpen = equityOpenRisk(desk);
  const predictions = predictionDesk(desk);
  const meme = memeDesk(desk);
  const oddsOpen = rowsOpen(predictions.positions);
  const banditOpen = rowsOpen(meme.positions);

  const out = new Map<BookSlug, BookSignals>();
  out.set('quantanamo', signalsFor({
    blocked: missing.has('quantanamo') || (equityOpen && !isMarkFresh(desk.book?.observed_at, nowMs)),
    inFlightRecent: intentsInFlight(desk.intents ?? [], nowMs),
    recentFill: fillsRecent(equityFillStamps(desk), nowMs),
    openRisk: equityOpen,
    closeAgeMs: newestCloseAge(desk.positions ?? [], nowMs),
  }));
  out.set('oddsborne', signalsFor({
    blocked: missing.has('oddsborne') || blockedByHealth.has('oddsborne'),
    inFlightRecent: ordersInFlight(predictions.orders, nowMs),
    recentFill: fillsRecent(predictions.fills.map((row) => row.executed_at), nowMs),
    openRisk: oddsOpen,
    closeAgeMs: newestCloseAge(predictions.positions, nowMs),
  }));
  out.set('bandit', signalsFor({
    blocked: missing.has('bandit') || blockedByHealth.has('bandit'),
    inFlightRecent: ordersInFlight(meme.orders, nowMs),
    recentFill: fillsRecent(meme.fills.map((row) => row.executed_at), nowMs),
    openRisk: banditOpen,
    closeAgeMs: newestCloseAge(meme.positions, nowMs),
  }));
  return out;
}

function signalsFor(input: {
  blocked: boolean;
  inFlightRecent: boolean;
  recentFill: boolean;
  openRisk: boolean;
  closeAgeMs: number | null;
}): BookSignals {
  return {
    blocked: input.blocked,
    inFlightRecent: input.inFlightRecent,
    recentFillWhileOpen: input.recentFill && input.openRisk,
    openRisk: input.openRisk,
    closeAgeMs: input.closeAgeMs,
  };
}

/** Same gate as the learning pulse: tagged or an explicit untagged reason is ok. */
function missingGateSlugs(desk: DeskPayload): Set<string> {
  const missing = new Set<string>();
  for (const row of assembleBookHoldings(desk).rows) {
    if (row.life !== 'live') continue;
    if (row.thesis_id || row.untagged) continue;
    missing.add(row.steward_slug);
  }
  return missing;
}

function equityOpenRisk(desk: DeskPayload): boolean {
  for (const row of desk.book?.names ?? []) {
    if (row.venue && row.venue !== 'equity') continue;
    if (Number.isFinite(row.quantity) && row.quantity !== 0) return true;
  }
  return rowsOpen(desk.positions ?? []);
}

function rowsOpen(rows: readonly { status: string; quantity?: number | null }[]): boolean {
  for (const row of rows) {
    if (!OPENISH.has(row.status.trim().toLowerCase())) continue;
    if (row.quantity === 0) continue;
    return true;
  }
  return false;
}

function intentsInFlight(rows: readonly { status: string; mode?: string | null; created_at?: string; updated_at?: string }[], nowMs: number): boolean {
  return rows.some((row) => inFlight(row.status, row.mode) && isRecent(row.updated_at ?? row.created_at, nowMs));
}

function ordersInFlight(
  rows: readonly { status: string; mode?: string | null; created_at: string; submitted_at?: string | null }[],
  nowMs: number,
): boolean {
  return rows.some((row) => inFlight(row.status, row.mode) && isRecent(row.submitted_at ?? row.created_at, nowMs));
}

function inFlight(status: string, mode: string | null | undefined): boolean {
  const value = status.trim().toLowerCase();
  if (!value || TERMINAL_ORDER.has(value)) return false;
  if ((mode ?? '').trim().toLowerCase() === 'paper') return false;
  return true;
}

function equityFillStamps(desk: DeskPayload): Stamp[] {
  const stamps: Stamp[] = (desk.fills ?? []).map((row) => row.executed_at);
  for (const row of desk.fill_log ?? []) {
    if (row.venue === 'equity' || row.source === 'broker_fill' || row.source === 'filled_intent') {
      stamps.push(row.at);
    }
  }
  return stamps;
}

function fillsRecent(stamps: readonly Stamp[], nowMs: number): boolean {
  return stamps.some((stamp) => isRecent(stamp, nowMs));
}

function newestCloseAge(
  rows: readonly { status: string; closed_at?: string | null }[],
  nowMs: number,
): number | null {
  let best: number | null = null;
  for (const row of rows) {
    if (!row.closed_at || !isClosedPositionStatus(row.status)) continue;
    const age = ageMs(row.closed_at, nowMs);
    if (age === null) continue;
    if (best === null || age < best) best = age;
  }
  return best;
}

function isRecent(at: Stamp, nowMs: number): boolean {
  const age = ageMs(at, nowMs);
  return age !== null && age < PRESENCE_ACTIVITY_MS;
}

function ageMs(at: Stamp, nowMs: number): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return nowMs - ms;
}

function isBookSlug(slug: string): slug is BookSlug {
  return slug === 'quantanamo' || slug === 'oddsborne' || slug === 'bandit';
}
