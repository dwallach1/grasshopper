/**
 * Open lessons and the strategy test each one is waiting on.
 * Rows come from public.v_open_lesson_tests. A missing test, status, or age
 * stays null — the desk does not invent a day count.
 */
import type { JsonObjectRow } from './ledger-map';

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
  if (wait.test_status === null) return `Waiting on test ${id}`;
  if (wait.test_status !== 'queued') return null;
  if (wait.age_days === null || wait.age_days < 0) return `Waiting on test ${id}, still queued`;
  if (wait.age_days === 0) return `Waiting on test ${id}, queued today`;
  const word = wait.age_days === 1 ? 'day' : 'days';
  return `Waiting on test ${id}, queued ${wait.age_days} ${word}`;
}
