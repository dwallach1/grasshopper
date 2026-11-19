import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const schema = join(root, 'supabase/schemas/103_ontology_proposer_compound.sql');
const migration = join(root, 'supabase/migrations/20261119193000_ontology_proposer_compound.sql');

describe('ontology proposer compounds existing keys', () => {
  test('schema file is the migration, and retired workers get no grant', () => {
    const sql = readFileSync(schema, 'utf8');
    expect(readFileSync(migration, 'utf8')).toBe(sql);
    expect(sql).toContain('having count(distinct i.source_type || \':\' || i.source_key) >= 3');
    expect(sql).toContain('and count(distinct i.source_key) >= 2');
    expect(sql).toContain('r.theme_id is distinct from \'earnings_events\'');
    expect(sql).toContain('not private.ontology_label_is_junk(oc.candidate_type, oc.proposed_label)');
    expect(sql).toContain('update public.symbol_theme_memberships m');
    expect(sql).toContain('and m.status = \'active\'');
    expect(sql).toContain("'already_promoted', v_already_promoted");
    expect(sql).toContain("'rejected_no_new_evidence', v_rejected_quiet");
    expect(sql).toContain("'junk', v_junk");
    expect(sql).toContain("'below_threshold', v_below");
    expect(sql).toContain('new evidence carried no new keys');
    expect(sql).toContain("interval '72 hours'");
    expect(sql).toContain("'learning_loop'");
    expect(sql).toContain('with (security_invoker = true)');
    expect(sql).toContain('security definer');
    expect(sql).toContain("set search_path = ''");
    expect(sql).not.toContain("where public.ontology_candidates.status in ('pending', 'rejected')");
    expect(sql).not.toContain('cron.schedule');
    const grants = [...sql.matchAll(/^grant\b[\s\S]*?;/gim)].map((match) => match[0]);
    expect(grants).toEqual([
      'grant select on public.v_ledger_watchdog\n  to authenticated, quantanamo_worker, desk_public_reader, service_role;',
    ]);
    for (const grant of grants) {
      expect(grant).not.toContain('oddsborne_worker');
      expect(grant).not.toContain('bandit_worker');
      expect(grant).not.toContain('anon');
    }
  });
});
