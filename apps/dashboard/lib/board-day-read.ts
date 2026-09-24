/**
 * Board day-read. Two factual lines from the desk payload the Board already
 * holds. Missing facts drop out of the sentence. No commentary, P/L, or scores.
 *
 * Lead (plain counts):
 * - open books — live lots from `assembleBookHoldings` (same rows the learning
 *   pulse counts as `open_books`)
 * - beliefs in force — `assembleBeliefsInForce` (the Theses inspect list:
 *   newest playbook rule per thesis/domain)
 * - steward posture — `stewardPresences` for quantanamo, oddsborne, and bandit
 *   (the circle+eyes faces on this Board)
 *
 * Stamp (same clock as the header freshness chips):
 * - newest steward mark — `assembleStewardFreshness().mark_at`, display name
 *   from the team card
 * - desk read — `assembleDeskFreshness().read_at`, which is `generated_at`,
 *   the chip labeled "read"
 * Ages use the same second/minute/hour/day buckets as `age` in
 * `app/terminal/format.ts`.
 */
import { assembleBeliefsInForce } from './learning-inspect';
import { assembleBookHoldings } from './book-holdings';
import { assembleDeskFreshness, assembleStewardFreshness, type StewardFreshnessId } from './desk-freshness';
import { deskTeam, teamCards } from './desk-team';
import type { DeskPayload } from './ledger-types';
import { stewardPresences, type StewardPresence } from './steward-presence';

const BOOK_SLUGS = ['quantanamo', 'oddsborne', 'bandit'] as const;

const POSTURE_ORDER = ['working', 'waiting', 'blocked', 'done', 'idle'] as const satisfies readonly StewardPresence[];

const FALLBACK_NAME = {
  quantanamo: 'QUANTANAMO',
  oddsborne: 'ODDSBORNE',
  bandit: 'BANDIT',
} satisfies Record<StewardFreshnessId, string>;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type BoardDayRead = {
  lead: string;
  stamp: string;
};

type NewestMarks = {
  at: string;
  ids: StewardFreshnessId[];
};

/** Header-chip age buckets. Null when `at` is not a timestamp. */
export function freshnessAge(at: string, nowMs: number): string | null {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const elapsed = Math.max(0, nowMs - ms);
  if (elapsed < MINUTE_MS) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

export function assembleBoardDayRead(desk: DeskPayload, nowMs: number | null): BoardDayRead {
  const openBooks = assembleBookHoldings(desk).rows.filter((row) => row.life === 'live').length;
  const beliefs = assembleBeliefsInForce(desk).length;
  const lead = joinClauses([
    booksClause(openBooks),
    beliefsClause(beliefs),
    ...(nowMs === null ? [] : postureClauses(desk, nowMs)),
  ]);
  const stamp = nowMs === null
    ? ''
    : joinClauses([markClause(desk, nowMs), readClause(desk, nowMs)]);
  return { lead, stamp };
}

function booksClause(count: number): string {
  return count === 1 ? '1 book open' : `${count} books open`;
}

function beliefsClause(count: number): string {
  return count === 1 ? '1 belief in force' : `${count} beliefs in force`;
}

function postureClauses(desk: DeskPayload, nowMs: number): string[] {
  const faces = stewardPresences(desk, nowMs);
  let seen = 0;
  for (const slug of BOOK_SLUGS) {
    if (faces.get(slug)) seen += 1;
  }
  if (seen === 0) return [];
  const clauses: string[] = [];
  for (const posture of POSTURE_ORDER) {
    let count = 0;
    for (const slug of BOOK_SLUGS) {
      if (faces.get(slug)?.presence === posture) count += 1;
    }
    if (count <= 0) continue;
    const noun = count === 1 ? 'steward' : 'stewards';
    clauses.push(`${count} ${noun} ${posture}`);
  }
  return clauses;
}

function markClause(desk: DeskPayload, nowMs: number): string {
  const newest = newestStewardMarks(desk);
  if (!newest) return '';
  const age = freshnessAge(newest.at, nowMs);
  if (!age) return '';
  const names = newest.ids.map((id) => stewardName(desk, id));
  return `${joinNames(names)} marked ${age} ago`;
}

function readClause(desk: DeskPayload, nowMs: number): string {
  const at = assembleDeskFreshness(desk).read_at;
  if (!at) return '';
  const age = freshnessAge(at, nowMs);
  if (!age) return '';
  return `desk read ${age} ago`;
}

function newestStewardMarks(desk: DeskPayload): NewestMarks | null {
  const rows = assembleStewardFreshness(desk);
  let bestMs = Number.NEGATIVE_INFINITY;
  let bestAt: string | null = null;
  for (const row of rows) {
    if (!row.mark_at) continue;
    const ms = Date.parse(row.mark_at);
    if (!Number.isFinite(ms) || ms < bestMs) continue;
    bestMs = ms;
    bestAt = row.mark_at;
  }
  if (!bestAt) return null;
  const ids = BOOK_SLUGS.filter((id) => {
    const at = rows.find((row) => row.id === id)?.mark_at;
    if (!at) return false;
    return Date.parse(at) === bestMs;
  });
  if (!ids.length) return null;
  return { at: bestAt, ids };
}

function stewardName(desk: DeskPayload, id: StewardFreshnessId): string {
  const card = teamCards(deskTeam(desk)).find((row) => row.slug === id);
  const name = card?.display_name.trim() ?? '';
  return name || FALLBACK_NAME[id];
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const head = names.slice(0, -1).join(', ');
  return `${head}, and ${names[names.length - 1]}`;
}

function joinClauses(clauses: readonly string[]): string {
  return clauses.filter((clause) => clause.length > 0).join(' · ');
}
