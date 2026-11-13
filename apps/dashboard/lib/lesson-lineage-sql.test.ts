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

describe('research lesson fixes', () => {
  const schema = join(root, 'supabase/schemas/99_research_lesson_fixes.sql');
  const migration = join(root, 'supabase/migrations/20261112190000_research_lesson_fixes.sql');

  test('schema file is the migration, and a shipped fix has three statuses', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(readFileSync(migration, 'utf8')).toBe(sql);
    expect(sql).toContain('create table if not exists public.research_lesson_fixes');
    expect(sql).toContain('lesson_id bigint not null references public.research_lessons(id) on delete cascade');
    expect(sql).toContain("fix_kind text not null check (fix_kind in ('tool', 'rule', 'belief'))");
    expect(sql).toContain('shipped_at timestamptz not null');
    expect(sql).toContain('created_at timestamptz not null default now()');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain("select 245, 'PR #204', 'tool', timestamptz '2026-11-11 18:45:33+00'");
    expect(sql).toContain('where exists (select 1 from public.research_lessons where id = 245)');
    expect(sql).toContain('cardinality(s.lesson_ids) >= 3');
    expect(sql).toContain('root.incorporated');
    expect(sql).toContain("when fx.shipped_at is null then 'not_taking'");
    expect(sql).toContain("when fail.lesson_id is not null then 'fix_failed'");
    expect(sql).toContain("'fix_shipped_watching'");
    expect(sql).toContain('e.earlier_lesson_id = any (k.lesson_ids)');
    expect(sql).toContain('l.created_at > fx.shipped_at');
    expect(sql).toContain("'failed_lesson_id', fail.lesson_id");
    expect(sql).toContain("'fix_ref', fx.fix_ref");
    expect(sql).toContain("'shipped_at', fx.shipped_at");
    expect(sql).toContain('does not make /api/health not-ok');
    expect(sql).not.toMatch(/update\s+public\.belief_updates/i);
    expect(sql).not.toMatch(/update\s+public\.research_lessons/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.belief_updates/i);
    expect(sql).not.toContain('playbook_rule');
    expect(sql).not.toContain('grant execute');
  });

  test('writes are service_role only; retired workers and anon get nothing', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(sql).toContain('revoke all on table public.research_lesson_fixes from public, anon, authenticated, desk_public_reader, oddsborne_worker, bandit_worker, quantanamo_worker');
    expect(sql).toContain('grant select on table public.research_lesson_fixes');
    expect(sql).toContain('to authenticated, quantanamo_worker, desk_public_reader, service_role');
    expect(sql).toContain('grant all on table public.research_lesson_fixes to service_role');
    expect(sql).toContain('revoke all on sequence public.research_lesson_fixes_id_seq from public, anon, authenticated, desk_public_reader, oddsborne_worker, bandit_worker, quantanamo_worker');
    expect(sql).toContain('grant usage, select on sequence public.research_lesson_fixes_id_seq to service_role');
    expect(sql).toContain('for all to service_role');
    expect(sql).toContain('for select to authenticated using (true)');
    expect(sql).toContain('for select to quantanamo_worker using (true)');
    expect(sql).toContain('for select to desk_public_reader using (true)');
    const grants = [...sql.matchAll(/^grant\b[^;]*;/gim)].map((match) => match[0]);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toMatch(/oddsborne_worker|bandit_worker/);
      if (/research_lesson_fixes/.test(grant) && /\banon\b/.test(grant)) {
        throw new Error(`anon grant: ${grant}`);
      }
      if (/research_lesson_fixes/.test(grant) && /\bauthenticated\b/.test(grant)) {
        expect(grant).toMatch(/\bselect\b/i);
        expect(grant).not.toMatch(/\b(insert|update|delete|all)\b/i);
      }
      if (/research_lesson_fixes/.test(grant) && /quantanamo_worker/.test(grant)) {
        expect(grant).toMatch(/\bselect\b/i);
        expect(grant).not.toMatch(/\b(insert|update|delete|all)\b/i);
      }
    }
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete|all) to (anon|authenticated|quantanamo_worker|oddsborne_worker|bandit_worker|desk_public_reader)/i);
  });
});

describe('research lesson lineage role', () => {
  const schema = join(root, 'supabase/schemas/100_research_lesson_lineage_role.sql');
  const migration = join(root, 'supabase/migrations/20261113203000_research_lesson_lineage_role.sql');

  test('a repeat is a violation, a confirmation, or a refinement, and only a break alarms', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(readFileSync(migration, 'utf8')).toBe(sql);
    expect(sql).toContain('add column if not exists lineage_role text');
    expect(sql).toContain("lineage_role in ('violation', 'confirmation', 'refinement')");
    expect(sql).toContain('private.lesson_lineage_role');
    expect(sql).toContain('private.lesson_continues_uncited');
    expect(sql).toContain('private.assign_lesson_lineage_role');
    expect(sql).toContain("when coalesce(p_summary, '') ~* 'chase already ruled out' then 'violation'");
    expect(sql).toContain("when coalesce(p_summary, '') ~* 'rule stands' then 'confirmation'");
    expect(sql).toContain("when coalesce(p_summary, '') ~* 'sector-specific' then 'refinement'");
    expect(sql).toContain("when coalesce(p_summary, '') ~* 'below-gate'");
    expect(sql.indexOf("~* 'below-gate'")).toBeLessThan(sql.indexOf("~* 'rule stands'"));
    expect(sql).toContain("when l.lineage_role in ('violation', 'confirmation', 'refinement') then l.lineage_role");
    expect(sql).toMatch(/coalesce\(\s*case\s*when l\.lineage_role in \('violation', 'confirmation', 'refinement'\) then l\.lineage_role\s*end,\s*'violation'\s*\) as role/);
    expect(sql).toContain('if new.lineage_role is null then');
    expect(sql).toContain('private.lesson_continues_uncited(new.summary)');
    expect(sql).toContain('set lineage_role = private.lesson_lineage_role(l.summary)');
    expect(sql).toContain('on conflict do nothing');
    expect(sql).toContain("'violations'");
    expect(sql).toContain("then 'holding'");
    expect(sql).toContain("then 'refining'");
    expect(sql).toContain("when fx.shipped_at is null then 'not_taking'");
    expect(sql).toContain("'fix_shipped_watching'");
    expect(sql).toContain("else 'fix_failed'");
    expect(sql).toContain('v.created_at > fx.shipped_at');
    expect(sql).toContain("v_lineage_role text := nullif(btrim(p->>'lineage_role'), '');");
    expect(sql).toContain('lineage_role, incorporated, created_at');
    expect(sql).toContain('does not make /api/health not-ok');
    expect(sql).toContain('Only not_taking and fix_failed are the alarm');
    expect(sql).not.toMatch(/update\s+public\.belief_updates/i);
    expect(sql).not.toMatch(/set\s+incorporated/i);
    const helpers = [
      'lesson_lineage_role(text)',
      'lesson_continues_uncited(text)',
      'assign_lesson_lineage_role()',
    ];
    for (const helper of helpers) {
      expect(sql).toContain(`revoke execute on function private.${helper} from oddsborne_worker, bandit_worker;`);
      const signature = helper.replace(/[()]/g, '\\$&');
      const grant = sql.match(new RegExp(`grant execute on function private\\.${signature}[\\s\\S]*?;`, 'i'));
      expect(grant?.[0]).toBeTruthy();
      expect(grant?.[0]).toContain('quantanamo_worker');
      expect(grant?.[0]).toContain('service_role');
      expect(grant?.[0]).not.toContain('oddsborne_worker');
      expect(grant?.[0]).not.toContain('bandit_worker');
      expect(grant?.[0]).not.toContain('anon');
    }
    expect(sql).toContain('grant execute on function public.steward_close_lesson(jsonb) to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;');
  });
});
