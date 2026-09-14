import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LessonRow, ThesisRow } from './ledger-types';
import {
  incorporateHttpError,
  LESSON_QUEUE_CAP,
  openLessonCount,
  parseIncorporateRequest,
  rankLessonsForDesk,
  thesisNameForLesson,
} from './lesson-incorporate';

const AT = '2026-09-11T21:03:51.745Z';

function lesson(id: number, extra: Partial<LessonRow> = {}): LessonRow {
  return {
    id,
    cycle_id: extra.cycle_id ?? 1,
    test_id: extra.test_id ?? null,
    thesis_id: extra.thesis_id ?? 'earnings_gap_structure',
    lesson_type: extra.lesson_type ?? 'structure',
    summary: extra.summary ?? `lesson ${id}`,
    market_regime: extra.market_regime ?? null,
    incorporated: extra.incorporated ?? false,
    created_at: extra.created_at ?? AT,
  };
}

function thesis(id: string, name: string): ThesisRow {
  return {
    id,
    name,
    summary: name,
    status: 'hardening',
    confidence: 70,
    time_horizon: 'days_to_weeks',
    stance: 'bullish',
    variant_perception: null,
    falsifier: null,
    created_at: AT,
    updated_at: AT,
    symbols: [],
    lots: [],
  };
}

describe('lesson incorporate queue', () => {
  test('ranks open lessons first, then newest created_at', () => {
    const rows = [
      lesson(9, { incorporated: true, created_at: '2026-09-12T00:00:00.000Z', summary: 'old in playbook' }),
      lesson(37, { incorporated: false, created_at: '2026-09-11T21:03:51.000Z', lesson_type: 'structure' }),
      lesson(36, { incorporated: false, created_at: '2026-09-10T20:28:50.000Z', lesson_type: 'structure' }),
      lesson(3, { incorporated: false, created_at: '2026-08-23T19:26:24.000Z', lesson_type: 'regime_dependency' }),
      lesson(12, { incorporated: true, created_at: '2026-09-01T00:00:00.000Z' }),
    ];
    const ranked = rankLessonsForDesk(rows);
    expect(ranked.map((row) => row.id)).toEqual([37, 36, 3, 9, 12]);
    expect(ranked.slice(0, 3).every((row) => !row.incorporated)).toBe(true);
    expect(ranked.slice(3).every((row) => row.incorporated)).toBe(true);
    expect(openLessonCount(ranked)).toBe(3);
    expect(LESSON_QUEUE_CAP).toBe(40);
  });

  test('caps the parchment list without inventing rows', () => {
    const rows = Array.from({ length: 45 }, (_, index) => lesson(index + 1, {
      incorporated: index >= 22,
      created_at: `2026-09-${String(14 - (index % 10)).padStart(2, '0')}T12:00:00.000Z`,
    }));
    const ranked = rankLessonsForDesk(rows, 40);
    expect(ranked).toHaveLength(40);
    expect(ranked.filter((row) => !row.incorporated).length).toBe(22);
    expect(ranked[0]?.incorporated).toBe(false);
    expect(ranked[22]?.incorporated).toBe(true);
  });

  test('uses the ledger thesis name, never a made-up label', () => {
    expect(thesisNameForLesson(
      lesson(37),
      [thesis('earnings_gap_structure', 'Earnings gap structure')],
    )).toBe('Earnings gap structure');
    expect(thesisNameForLesson(lesson(3, { thesis_id: 'quantum' }), [])).toBe('quantum');
  });

  test('parses operator incorporate bodies and rejects junk', () => {
    expect(parseIncorporateRequest({ lesson_id: 37 })).toEqual({ lesson_id: 37 });
    expect(parseIncorporateRequest({ lesson_id: '36' })).toEqual({ lesson_id: 36 });
    expect(parseIncorporateRequest({ lesson_id: 0 })).toBeNull();
    expect(parseIncorporateRequest({ lesson_id: 1.5 })).toBeNull();
    expect(parseIncorporateRequest({ action: 'incorporate' })).toBeNull();
    expect(incorporateHttpError('not_operator').status).toBe(403);
    expect(incorporateHttpError('lesson_not_found')).toMatchObject({ status: 404 });
    expect(incorporateHttpError('lesson_required').status).toBe(400);
  });

  test('SQL writes playbook_rule beliefs, not a parallel table', async () => {
    const sql = await readFile(
      join(import.meta.dir, '../../../supabase/schemas/09_lesson_incorporate.sql'),
      'utf8',
    );
    expect(sql).toContain('private.incorporate_research_lesson');
    expect(sql).toContain('public.incorporate_research_lesson');
    expect(sql).toContain('security invoker');
    expect(sql).toContain('security definer');
    expect(sql).toContain("meta->>'kind', '') = 'playbook_rule'");
    expect(sql).toContain("'source', 'operator_incorporate'");
    expect(sql).toContain("incorporated = true");
    expect(sql).toContain('belief_updates_playbook_lesson_idx');
    expect(sql).not.toMatch(/grant execute on function public\.incorporate_research_lesson[\s\S]*to anon/);
    expect(sql).not.toContain('create table');
  });
});
