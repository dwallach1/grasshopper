/**
 * Queued strategy tests, in the words the Book can show.
 * Days come from tested_at (New York calendar) or from v_open_lesson_tests.age_days.
 * A missing clock stays uncounted. Nothing here scores a test or closes a lesson.
 */
import type { LessonRow, StrategyTestRow } from './ledger-types';
import type { LessonWait } from './lesson-waits';

export type WaitingLesson = {
  id: number;
  phrase: string;
};

export type WaitingTest = {
  id: number;
  /** One short line from the hypothesis. Null when the cycle has none. */
  check: string | null;
  /** New York calendar days since the test was written. Null when that time is missing. */
  days: number | null;
  daysLine: string;
  /** Plain reason the test is still sitting. Null when the row did not say. */
  why: string | null;
  lessons: WaitingLesson[];
  lessonsLine: string | null;
};

type CycleLike = {
  id: number;
  thesis_id?: string | null;
  hypothesis?: string | null;
};

export function namedTestIds(summary: string | null | undefined): number[] {
  const ids = new Set<number>();
  const text = summary ?? '';
  const named = /(?:preregistered\s+as\s+strategy_test\s*#\s*(\d+)|strategy_test\s*#\s*(\d+)|\btest\s+#?\s*(\d+)\s+preregistered|\bqueued\s+test\s+#?\s*(\d+))/gi;
  for (const match of text.matchAll(named)) {
    const raw = match[1] || match[2] || match[3] || match[4];
    if (!raw) continue;
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/** New York calendar date for an ISO timestamp. Null when it is not a time. */
export function nyDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/** Whole New York calendar days from `iso` to `nowMs`. Null when the start is missing. */
export function nyCalendarDaysSince(iso: string | null | undefined, nowMs: number): number | null {
  const start = nyDate(iso);
  const end = nyDate(new Date(nowMs).toISOString());
  if (!start || !end) return null;
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const days = Math.round((b - a) / 86_400_000);
  return days >= 0 ? days : null;
}

export function testCheckLine(hypothesis: string | null | undefined): string | null {
  const text = (hypothesis ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const mark = text.lastIndexOf('?');
  if (mark >= 16) {
    const before = text.slice(0, mark + 1);
    const breakAt = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '));
    const question = (breakAt >= 0 ? before.slice(breakAt + 2) : before).trim();
    if (question.endsWith('?') && question.length >= 16) return clip(question, 140);
  }
  const raw = (text.split(/(?<=\.)\s/)[0] ?? text).trim();
  return clip(raw, 140);
}

/**
 * The stored reason is a machine tag plus a lab note. The Book says what is
 * actually stuck: the price history was never built, and why the run stopped.
 */
export function stuckReason(failure: string | null | undefined): string | null {
  const raw = (failure ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const text = raw.toLowerCase();
  const universe = text.startsWith('queued_needs_universe_build')
    || text.includes('universe build')
    || text.includes('qualifying count');
  if (universe) {
    if (text.includes('out of credits') || text.includes('financial datasets')) {
      return 'The price history was never built. The market-data feed ran out of credits.';
    }
    if (text.includes('timed out') || text.includes('no time')) {
      return 'The price history was never built. The last run ran out of time.';
    }
    return 'The price history for this test has not been built yet.';
  }
  return clip(raw.replace(/^[a-z0-9_]+:\s*/i, ''), 160);
}

export function waitingDaysLine(days: number | null): string {
  if (days === null) return 'Still waiting.';
  if (days <= 0) return 'Queued today.';
  if (days === 1) return 'Waiting 1 day.';
  return `Waiting ${days} days.`;
}

export function lessonsWaitingLine(phrases: readonly string[]): string | null {
  if (!phrases.length) return null;
  const shown = phrases.slice(0, 4);
  const label = shown.length === 1 ? 'Lesson still open' : 'Lessons still open';
  return `${label}: ${shown.join('; ')}.`;
}

/** One line for a thesis row. Null when nothing is queued. */
export function waitingBlurb(rows: readonly WaitingTest[]): string | null {
  if (!rows.length) return null;
  const oldest = rows.reduce<number | null>((max, row) => {
    if (row.days === null) return max;
    return max === null ? row.days : Math.max(max, row.days);
  }, null);
  if (rows.length === 1) {
    return oldest === null ? 'One test is still waiting.' : waitingDaysLine(oldest).replace(/\.$/, '') + '.';
  }
  if (oldest === null) return `${rows.length} tests are still waiting.`;
  const day = oldest === 1 ? 'day' : 'days';
  return `${rows.length} tests are still waiting, the oldest for ${oldest} ${day}.`;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const word = (space > 40 ? cut.slice(0, space) : cut).replace(/[,:;.\s]+$/, '');
  return `${word}…`;
}

function lessonPhrase(summary: string): string {
  const text = summary.replace(/\s+/g, ' ').trim();
  const sentence = (text.split(/(?<=\.)\s/)[0] ?? text).replace(/\.$/, '');
  return clip(sentence, 72);
}

function lessonDependsOn(
  lesson: Pick<LessonRow, 'incorporated' | 'thesis_id' | 'test_id' | 'cycle_id' | 'summary'>,
  test: { id: number; cycleId: number; thesisId: string },
): boolean {
  if (lesson.incorporated) return false;
  if (lesson.thesis_id !== test.thesisId) return false;
  if (lesson.test_id === test.id) return true;
  const named = namedTestIds(lesson.summary);
  if (named.includes(test.id)) return true;
  if (named.length > 0 || lesson.test_id !== null) return false;
  if (lesson.cycle_id !== test.cycleId) return false;
  return /\bprereg\b/i.test(lesson.summary);
}

export function waitingTestsForThesis(input: {
  thesisId: string;
  tests: readonly StrategyTestRow[];
  cycles: readonly CycleLike[];
  lessons: readonly LessonRow[];
  lessonWaits?: readonly LessonWait[];
  nowMs: number;
}): WaitingTest[] {
  const cycleById = new Map(input.cycles.map((row) => [row.id, row]));
  const onThesis = new Set(
    input.cycles.filter((row) => row.thesis_id === input.thesisId).map((row) => row.id),
  );
  const waitsByTest = new Map<number, number>();
  for (const wait of input.lessonWaits ?? []) {
    if (wait.thesis_id !== input.thesisId || wait.test_id === null || wait.age_days === null) continue;
    const prev = waitsByTest.get(wait.test_id);
    waitsByTest.set(wait.test_id, prev === undefined ? wait.age_days : Math.max(prev, wait.age_days));
  }
  const queued = input.tests.filter((row) => {
    if (row.status !== 'queued') return false;
    if (onThesis.has(row.cycle_id)) return true;
    return input.lessons.some((lesson) => lessonDependsOn(lesson, {
      id: row.id,
      cycleId: row.cycle_id,
      thesisId: input.thesisId,
    }));
  });
  const out: WaitingTest[] = queued.map((row) => {
    const fromClock = nyCalendarDaysSince(row.tested_at, input.nowMs);
    const days = fromClock ?? waitsByTest.get(row.id) ?? null;
    const lessons = input.lessons
      .filter((lesson) => lessonDependsOn(lesson, {
        id: row.id,
        cycleId: row.cycle_id,
        thesisId: input.thesisId,
      }))
      .map((lesson) => ({ id: lesson.id, phrase: lessonPhrase(lesson.summary) }))
      .filter((lesson) => lesson.phrase);
    const phrases = lessons.map((lesson) => lesson.phrase);
    return {
      id: row.id,
      check: testCheckLine(cycleById.get(row.cycle_id)?.hypothesis),
      days,
      daysLine: waitingDaysLine(days),
      why: stuckReason(row.failure_reason),
      lessons,
      lessonsLine: lessonsWaitingLine(phrases),
    };
  });
  out.sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || a.id - b.id);
  return out;
}
