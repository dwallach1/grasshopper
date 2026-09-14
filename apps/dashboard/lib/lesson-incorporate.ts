import type { DeskPayload, LessonRow, ThesisRow } from './ledger-types';

export const LESSON_QUEUE_CAP = 40;

export type IncorporateRequest = {
  lesson_id: number;
};

export type IncorporateResult = {
  ok: boolean;
  action: 'incorporate';
  lesson_id: number;
  incorporated: boolean;
  replayed: boolean;
  belief_id: string;
  thesis_id: string;
  rules: string[];
};

/** Open lessons first, then newest. Drops nothing but a calm cap. */
export function rankLessonsForDesk(
  rows: readonly LessonRow[],
  cap = LESSON_QUEUE_CAP,
): LessonRow[] {
  return rows
    .slice()
    .sort((a, b) => {
      if (a.incorporated !== b.incorporated) return a.incorporated ? 1 : -1;
      return b.created_at.localeCompare(a.created_at) || b.id - a.id;
    })
    .slice(0, cap);
}

export function openLessonCount(rows: readonly LessonRow[]): number {
  return rows.filter((row) => !row.incorporated).length;
}

export function thesisNameForLesson(
  lesson: Pick<LessonRow, 'thesis_id'>,
  theses: readonly ThesisRow[],
): string {
  const named = theses.find((row) => row.id === lesson.thesis_id);
  return named?.name.trim() || lesson.thesis_id;
}

export function parseIncorporateRequest(value: unknown): IncorporateRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const lessonId = Number(row.lesson_id);
  if (!Number.isInteger(lessonId) || lessonId <= 0) return null;
  return { lesson_id: lessonId };
}

export function incorporateHttpError(message: string): { status: number; error: string } {
  if (message.includes('not_operator')) {
    return { status: 403, error: 'This account is not on the operator allowlist' };
  }
  if (message.includes('lesson_not_found')) {
    return { status: 404, error: 'Lesson not in ledger' };
  }
  if (message.includes('lesson_required')) {
    return { status: 400, error: 'Pick a lesson to incorporate' };
  }
  return { status: 400, error: 'Incorporate failed' };
}

export async function incorporateResearchLesson(
  input: IncorporateRequest,
): Promise<IncorporateResult> {
  const response = await fetch('/api/lessons/incorporate', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : 'Incorporate failed';
    throw new Error(error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Incorporate failed');
  }
  const row = parsed as Record<string, unknown>;
  if (row.ok !== true || row.action !== 'incorporate') throw new Error('Incorporate failed');
  const rules = Array.isArray(row.rules)
    ? row.rules.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  return {
    ok: true,
    action: 'incorporate',
    lesson_id: Number(row.lesson_id),
    incorporated: row.incorporated === true,
    replayed: row.replayed === true,
    belief_id: String(row.belief_id ?? ''),
    thesis_id: typeof row.thesis_id === 'string' ? row.thesis_id : '',
    rules,
  };
}

export function lessonsFromDesk(desk: Pick<DeskPayload, 'lessons'>): LessonRow[] {
  return desk.lessons ?? [];
}
