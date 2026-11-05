/**
 * Open lessons and the strategy test each one is waiting on.
 * Rows come from public.v_open_lesson_tests. A missing test, status, or age
 * stays null — the desk does not invent a day count.
 */
import type { JsonObjectRow } from './ledger-map';
import { nyCalendarDaysSince } from './waiting-tests';

export type LessonWait = {
  lesson_id: number;
  thesis_id: string;
  test_id: number | null;
  test_status: string | null;
  /** New York calendar days since the test row's tested_at. Null when that time is missing. */
  age_days: number | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function int(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Open lessons older than this are marked so a stale one is visible in the list. */
export const OPEN_LESSON_STALE_DAYS = 7;

const TEST_FINISHED = new Set(['killed', 'retired', 'survived', 'lookahead_invalid']);

/** New York calendar days since the lesson was written. Null when the time is missing. */
export function lessonAgeDays(createdAt: string, nowMs: number): number | null {
  return nyCalendarDaysSince(createdAt, nowMs);
}

export function lessonAgeLine(createdAt: string, nowMs: number): string | null {
  const days = lessonAgeDays(createdAt, nowMs);
  if (days === null) return null;
  if (days <= 0) return 'Opened today';
  if (days === 1) return 'Open 1 day';
  return `Open ${days} days`;
}

export function mapLessonWaits(rows: readonly JsonObjectRow[] | unknown): LessonWait[] {
  if (!Array.isArray(rows)) return [];
  const out: LessonWait[] = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!row) continue;
    const lessonId = int(row.lesson_id);
    const thesisId = text(row.thesis_id);
    if (lessonId === null || lessonId <= 0 || !thesisId) continue;
    const testId = int(row.test_id);
    out.push({
      lesson_id: lessonId,
      thesis_id: thesisId,
      test_id: testId !== null && testId > 0 ? testId : null,
      test_status: text(row.test_status),
      age_days: int(row.age_days),
    });
  }
  return out;
}

/**
 * Plain Book line for an open lesson. Only a still-queued test, or a named
 * test whose status was not stored. A passed or failed test already has its
 * own measured line.
 */
export function lessonWaitLine(
  wait: Pick<LessonWait, 'test_id' | 'test_status' | 'age_days'> | null | undefined,
): string | null {
  if (!wait || wait.test_id === null) return null;
  const id = wait.test_id;
  const status = wait.test_status?.trim().toLowerCase() ?? null;
  if (status && TEST_FINISHED.has(status)) return 'Test finished, ready to decide';
  if (status === null) return `Waiting on test ${id}`;
  if (status !== 'queued') return null;
  if (wait.age_days === null || wait.age_days < 0) return `Waiting on test ${id}, still queued`;
  if (wait.age_days === 0) return `Waiting on test ${id}, queued today`;
  const word = wait.age_days === 1 ? 'day' : 'days';
  return `Waiting on test ${id}, queued ${wait.age_days} ${word}`;
}

export type OpenLessonGroup = 'ready' | 'waiting';

/**
 * Where an open lesson sits. A line that starts "Waiting on test" is still
 * queued or unnamed. A finished test, a missing wait, or any other status
 * is ready to write into the playbook.
 */
export function openLessonGroup(
  wait: Pick<LessonWait, 'test_id' | 'test_status' | 'age_days'> | null | undefined,
): OpenLessonGroup {
  const line = lessonWaitLine(wait);
  if (line !== null && line.startsWith('Waiting on test')) return 'waiting';
  return 'ready';
}
