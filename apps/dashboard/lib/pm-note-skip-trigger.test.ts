import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '../../..');
const migrationName = '20261017162111_pm_note_skip_direct_dedup.sql';
const schemaName = '78_pm_note_skip_direct_dedup.sql';

function readSql(dir: string, name: string): string {
  return readFileSync(join(root, 'supabase', dir, name), 'utf8');
}

function latestDefining(signature: string): { file: string; sql: string; fn: string } {
  const dir = join(root, 'supabase/migrations');
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const hits = files.filter((name) => readFileSync(join(dir, name), 'utf8').includes(`create or replace function ${signature}`));
  expect(hits.length).toBeGreaterThan(0);
  const file = hits.at(-1) ?? '';
  const sql = readFileSync(join(dir, file), 'utf8');
  const start = sql.indexOf(`create or replace function ${signature}`);
  const fn = sql.slice(start, sql.indexOf('\n$', start));
  return { file, sql, fn };
}

/** Mirror of the comps side expression: side, else outcome, else token; yes only when none is set. */
function compSide(elem: { side?: unknown; outcome?: unknown; token?: unknown }): string {
  for (const key of ['side', 'outcome', 'token'] as const) {
    const raw = elem[key];
    if (raw == null) continue;
    const text = String(raw).trim().toLowerCase();
    if (text) return text;
  }
  return 'yes';
}

describe('pm_notes skip scoring trigger (migration 78)', () => {
  const migration = readSql('migrations', migrationName);
  const schema = readSql('schemas', schemaName);
  const parser = latestDefining('private.pm_note_scoreable_decisions(p_note public.pm_notes)');
  const trigger = latestDefining('private.decision_candidate_from_pm_note()');
  const covered = latestDefining('private.pm_note_skip_covered_by_direct(');

  test('schema file is the migration file', () => {
    expect(migration).toBe(schema);
    expect(parser.file).toBe(migrationName);
    expect(trigger.file).toBe(migrationName);
    expect(covered.file).toBe(migrationName);
  });

  test('a note-derived skip is withheld when a direct row covers the same steward, instrument, and side within 24h', () => {
    expect(covered.fn).toContain("direct.source_table = 'direct'");
    expect(covered.fn).toContain('direct.steward = p_steward');
    expect(covered.fn).toContain('direct.instrument = p_instrument');
    expect(covered.fn).toContain('direct.side = p_side');
    expect(covered.fn).toContain("direct.decided_at >= p_at - interval '24 hours'");
    expect(covered.fn).toContain("direct.decided_at <= p_at + interval '24 hours'");
    expect(covered.fn).toContain('security invoker');
    expect(covered.fn).toContain("set search_path = ''");
    expect(trigger.fn).toContain("new.decision not in ('enter', 'skip')");
    expect(trigger.fn).toContain('from private.pm_note_scoreable_decisions(new) scored');
    expect(trigger.fn).toContain(
      "scored.decision = 'skip'\n        and private.pm_note_skip_covered_by_direct('oddsborne', scored.instrument, scored.side, new.created_at)",
    );
    expect(trigger.fn).toContain("'price_terms', d.price_terms");
    expect(trigger.fn).toContain('62: a rollup note naming no market');
    expect(trigger.fn).toContain(
      "held.decision = 'skip'\n          and private.pm_note_skip_covered_by_direct('oddsborne', held.instrument, held.side, new.created_at)",
    );
    expect(trigger.fn).toContain('security definer');
    expect(trigger.fn).toContain("set search_path to ''");
    expect(migration).not.toContain('create or replace function public.steward_log_decision');
  });

  test('comps read side, then outcome, then token, and do not invert prices', () => {
    const compsAt = parser.fn.indexOf('-- comps / comps_top.');
    const comps = compsAt === -1 ? '' : parser.fn.slice(compsAt).split('union all')[0] ?? '';
    expect(comps).toContain("coalesce(elem->>'market_slug', elem->>'market')");
    expect(comps).toContain("nullif(lower(btrim(elem->>'side')), '')");
    expect(comps).toContain("nullif(lower(btrim(elem->>'outcome')), '')");
    expect(comps).toContain("nullif(lower(btrim(elem->>'token')), '')");
    expect(comps).toContain("'yes'");
    expect(comps).toContain("private.try_numeric(elem->>'bid')");
    expect(comps).toContain("private.try_numeric(elem->>'fair')");
    expect(comps).toContain("lower(coalesce(elem->>'decision', '')) = 'skip'");
    expect(comps).toContain("p_note.meta->'comps_top'");
    expect(comps).toContain("'side'::text");
    expect(comps).not.toContain('1 -');
    expect(parser.fn).toContain('distinct on (r.instrument, r.side)');
    expect(parser.fn).toContain("and r.side in ('yes', 'no')");
    expect(parser.fn.match(/'yes'::text as side/g)?.length).toBe(1);
    const skipAt = parser.fn.indexOf('"SKIP <team> YES|NO');
    const bodySkip = skipAt === -1 ? '' : parser.fn.slice(skipAt);
    expect(bodySkip).toContain("case when lower(m[1]) = 'no' then 1 - private.try_numeric(m[3])");
    expect(bodySkip).toContain("'yes'::text");
  });

  test('cleanup deletes an unreferenced duplicate and supersedes one a mark or outcome references', () => {
    expect(migration).toContain('delete from public.decision_candidates n');
    expect(migration).toContain("n.source_table = 'pm_notes'");
    expect(migration).toContain("n.decision = 'skip'");
    expect(migration).toContain("coalesce(n.meta->>'superseded', '') <> 'true'");
    expect(migration).toContain('private.pm_note_skip_covered_by_direct(n.steward, n.instrument, n.side, n.decided_at)');
    expect(migration).toContain('n.resolved_outcome is null');
    expect(migration).toContain('n.counterfactual_pnl is null');
    expect(migration).toContain('n.brier is null');
    expect(migration).toContain('select 1 from public.decision_marks m where m.decision_id = n.id');
    expect(migration).toContain("'superseded', 'true'");
    expect(migration).toContain('kept because a mark or outcome references it');
    expect(migration).toContain('n.resolved_outcome is not null');
    expect(migration).toContain('n.counterfactual_pnl is not null');
    expect(migration).toContain('n.brier is not null');
    expect(migration).toContain('on delete cascade');
    const deleteAt = migration.indexOf('delete from public.decision_candidates n');
    const deleteSql = deleteAt === -1
      ? ''
      : migration.slice(deleteAt, migration.indexOf('get diagnostics v_deleted', deleteAt));
    expect(deleteSql).toContain('not exists');
    expect(deleteSql).not.toContain("'superseded', 'true'");
  });

  test('side coercion matches the comps expression', () => {
    expect(compSide({ outcome: 'no' })).toBe('no');
    expect(compSide({ outcome: ' NO ' })).toBe('no');
    expect(compSide({ outcome: 'YES' })).toBe('yes');
    expect(compSide({ side: 'yes', outcome: 'no' })).toBe('yes');
    expect(compSide({ side: 'YES', outcome: 'no' })).toBe('yes');
    expect(compSide({ side: '  ', outcome: 'no' })).toBe('no');
    expect(compSide({ token: 'no' })).toBe('no');
    expect(compSide({ token: 'NO' })).toBe('no');
    expect(compSide({})).toBe('yes');
    expect(compSide({ side: '', outcome: '', token: '' })).toBe('yes');
    expect(compSide({ outcome: 'maybe' })).toBe('maybe');
    expect(['yes', 'no'].includes(compSide({ outcome: 'maybe' }))).toBe(false);
  });
});
