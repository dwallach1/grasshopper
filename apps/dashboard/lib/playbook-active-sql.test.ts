import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const schema = readFileSync(join(root, 'supabase/schemas/06_playbook_rules.sql'), 'utf8');
const migration = readFileSync(
  join(root, 'supabase/migrations/20261029174226_active_playbook_rules_cumulative.sql'),
  'utf8',
);
const nullFix = readFileSync(
  join(root, 'supabase/migrations/20261029174352_playbook_rule_withdrawn_not_null.sql'),
  'utf8',
);

describe('active playbook rules stay cumulative', () => {
  test('schema and migration drop distinct-on and keep withdrawn rows out', () => {
    for (const sql of [schema, migration]) {
      expect(sql).not.toContain('distinct on');
      expect(sql).toContain('playbook_rule_is_withdrawn');
      expect(sql).toContain('playbook_rule_supersedes');
      expect(sql).toContain("meta->>'supersedes'");
      expect(sql).toContain('withdrawn');
      expect(sql).toContain('security_invoker = true');
      expect(sql).toContain('security invoker');
      expect(sql).toContain("set search_path = ''");
      expect(sql).toContain('order by r.observed_at desc');
      expect(sql).not.toContain('security definer');
    }
    // 174226 is the exact applied text (no coalesce); 174352 adds it.
    expect(schema).toContain('coalesce(pg_catalog.jsonb_typeof');
    expect(nullFix).toContain('false OR null');
    expect(nullFix).toContain('coalesce(pg_catalog.jsonb_typeof');
  });
});
