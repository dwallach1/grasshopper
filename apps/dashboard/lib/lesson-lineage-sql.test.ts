import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '../../..');
const schema = join(root, 'supabase/schemas/97_research_lesson_lineage.sql');
const migration = join(root, 'supabase/migrations/20261110190000_research_lesson_lineage.sql');

describe('research lesson lineage', () => {
  test('schema file is the migration, and links stay off the lesson write', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(readFileSync(migration, 'utf8')).toBe(sql);
    expect(sql).toContain('create table if not exists public.research_lesson_repeats');
    expect(sql).toContain('after insert or update of summary on public.research_lessons');
    expect(sql).toContain('private.link_research_lesson_repeats');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = \'\'');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('\\mlessons?\\s+');
    expect(sql).toContain('(earlier.created_at, earlier.id) < (l.created_at, l.id)');
    expect(sql).toContain('(earlier.created_at, earlier.id) < (new.created_at, new.id)');
    expect(sql).toContain('on conflict do nothing');
    expect(sql).toContain('cardinality(s.lesson_ids) >= 3');
    expect(sql).toContain('root.incorporated');
    expect(sql).toContain('as rules_not_taking');
    expect(sql).toContain('as lesson_came_back');
    expect(sql).toContain('does not make /api/health not-ok');
    expect(sql).toContain('grant select on table public.research_lesson_repeats');
    expect(sql).toContain('to authenticated, quantanamo_worker, desk_public_reader, service_role');
    expect(sql).toContain('revoke all on function private.link_research_lesson_repeats() from public, anon, authenticated, desk_public_reader');
    expect(sql).toContain('revoke execute on function private.cited_lesson_ids(text) from oddsborne_worker, bandit_worker;');
    expect(sql).toContain('revoke execute on function private.link_research_lesson_repeats() from oddsborne_worker, bandit_worker;');
    const executeGrants = [...sql.matchAll(/^grant execute on function private\.(?:cited_lesson_ids\(text\)|link_research_lesson_repeats\(\))[^;]*;/gim)].map((match) => match[0]);
    expect(executeGrants).toHaveLength(2);
    for (const grant of executeGrants) {
      expect(grant).not.toContain('oddsborne_worker');
      expect(grant).not.toContain('bandit_worker');
    }
    expect(sql).not.toMatch(/update\s+public\.belief_updates/i);
    expect(sql).not.toMatch(/update\s+public\.research_lessons/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.belief_updates/i);
    expect(sql).not.toContain('playbook_rule');
    const grants = [...sql.matchAll(/^grant\b[^;]*;/gim)].map((match) => match[0]);
    for (const grant of grants) {
      if (/research_lesson_repeats/.test(grant) && /desk_public_reader/.test(grant)) {
        expect(grant).toMatch(/\bselect\b/i);
        expect(grant).not.toMatch(/\binsert\b/i);
      }
    }
  });
});
