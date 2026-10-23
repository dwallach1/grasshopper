import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const schemaPath = join(root, 'supabase/schemas/87_shadow_lesson_loop.sql');

describe('shadow lesson loop sql', () => {
  test('scores the two shadows and labels the sheet without a new gate', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    const backfillAt = sql.indexOf('-- ---------------------------------------------------------------- backfill');
    const body = sql.slice(0, backfillAt);
    expect(backfillAt).toBeGreaterThan(0);
    expect(body).toContain('paper_ah_open_hold');
    expect(body).toContain("'no_open'");
    expect(body).toContain("meta->'starter'->>'week'");
    expect(body).toContain("meta->'starter'->>'of'");
    expect(body).toContain('SCORE-ONLY');
    expect(body).toContain('ACTIONABLE');
    expect(body).toContain('v_test <> 41');
    expect(body).not.toContain('31.84');
    expect(body).not.toContain('entry_allowed');
    expect(body).not.toContain('starters >= 3');
    expect(sql).toContain('31.84');
    expect(sql).toContain('64.15');
    expect(sql).toContain('where id in (151, 152, 154)');
    expect(sql).not.toContain('incorporate_research_lesson');
    expect(sql).not.toContain('steward_sizing_guidance');
  });
});
