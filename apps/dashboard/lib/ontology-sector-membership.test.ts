import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const schema = join(root, 'supabase/schemas/105_ontology_sector_membership.sql');
const migration = join(root, 'supabase/migrations/20261123190000_ontology_sector_membership.sql');

describe('sector membership proposer', () => {
  test('schema file is the migration, and retired workers get no grant', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(readFileSync(migration, 'utf8')).toBe(sql);
    expect(sql).toContain("kind in ('theme', 'concept', 'sector')");
    expect(sql).toContain("'traded_lot'");
    expect(sql).toContain("'earnings_sheet'");
    expect(sql).toContain("r.theme_id is distinct from 'earnings_events'");
    expect(sql).toContain("having count(distinct i.source_type || ':' || i.source_key) >= 3");
    expect(sql).toContain('and count(distinct i.source_key) >= 2');
    expect(sql).toContain("'no_sector', v_no_sector");
    expect(sql).toContain("'lot_keys', v_lot_keys");
    expect(sql).toContain("'sheet_keys', v_sheet_keys");
    expect(sql).toContain("when bool_or(source_type in ('traded_lot', 'earnings_sheet')) then now()");
    expect(sql).toContain('private.ontology_label_is_junk');
    expect(sql).toContain("set search_path = ''");
    expect(sql).not.toContain('cron.schedule');
    const grants = [...sql.matchAll(/^grant\b[\s\S]*?;/gim)].map((match) => match[0]);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toContain('oddsborne_worker');
      expect(grant).not.toContain('bandit_worker');
      expect(grant).not.toContain(' anon');
      expect(grant).not.toContain('desk_public_reader');
    }
    const policies = [...sql.matchAll(/^create policy\b[\s\S]*?;/gim)].map((match) => match[0]);
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(policy).not.toContain('desk_public_reader');
    }
  });
});
