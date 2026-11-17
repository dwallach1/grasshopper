import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '../../..');
const schema = join(root, 'supabase/schemas/101_earnings_sheet_entry_session.sql');
const migration = join(root, 'supabase/migrations/20261117193000_earnings_sheet_entry_session.sql');

describe('earnings sheet staleness', () => {
  test('schema file is the migration, and retired workers get no grant', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(readFileSync(migration, 'utf8')).toBe(sql);
    expect(sql).toContain('create or replace function public.earnings_sheet_staleness(p_now timestamptz)');
    expect(sql).toContain('security invoker');
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("q.source = 'earnings_sheet'");
    expect(sql).toContain("coalesce(c.kind, '') <> 'holiday'");
    expect(sql).toContain("when c.kind = 'early_close' then c.close_et");
    expect(sql).toContain("'sessions_missed'");
    expect(sql).toContain("'last_sheet_at'");
    expect(sql).toContain("'latest_entry_session'");
    expect(sql).toContain('as earnings_sheet_stale');
    expect(sql).toContain('does not make /api/health not-ok');
    expect(sql).toMatch(/select 260, 'PR #\d+', 'tool', timestamptz '2026-11-17/);
    expect(sql).toContain('where exists (select 1 from public.research_lessons where id = 260)');
    expect(sql).toContain('on conflict (lesson_id, fix_ref) do nothing');
    expect(sql).toContain('revoke all on function public.earnings_sheet_staleness(timestamptz) from public, anon, authenticated, oddsborne_worker, bandit_worker');
    const grants = [...sql.matchAll(/^grant\b[^;]*;/gim)].map((match) => match[0]);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toMatch(/oddsborne_worker|bandit_worker/);
      if (/earnings_sheet_staleness/.test(grant)) {
        expect(grant).toMatch(/\bexecute\b/i);
        expect(grant).toContain('desk_public_reader');
        expect(grant).not.toMatch(/\b(insert|update|delete|all)\b/i);
      }
      if (/v_ledger_watchdog/.test(grant) && /desk_public_reader/.test(grant)) {
        expect(grant).toMatch(/\bselect\b/i);
      }
    }
    expect(sql).not.toMatch(/update\s+public\.belief_updates/i);
    expect(sql).not.toMatch(/update\s+public\.research_lessons/i);
    expect(sql).not.toContain('playbook_rule');
  });
});
