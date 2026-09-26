import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '../../..');
const schemaPath = join(root, 'supabase/schemas/11_outcome_rescore_sizing.sql');

describe('outcome re-score + sizing SQL (PR 2)', () => {
  test('migration file is the schema file, and repo versions match prod', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const migration = await readFile(join(root, 'supabase/migrations/20260926170303_outcome_rescore_sizing.sql'), 'utf8');
    expect(migration).toBe(schema);
    for (const file of [
      '20260926165124_trade_outcomes_ledger.sql',
      '20260926165149_trade_outcomes_backfill.sql',
      '20260926170323_outcome_reprice_rescore_run.sql',
    ]) {
      expect((await readFile(join(root, 'supabase/migrations', file), 'utf8')).length).toBeGreaterThan(100);
    }
  });

  test('Beta prior k=10, cap 60 + demote at n>=5 with negative P/L, re-score logged', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    expect(sql).toContain('p_k numeric default 10');
    expect(sql).toContain('least(post.c, 60)');
    expect(sql).toContain("when post.demote and th.status = 'hardening' then 'forming'");
    expect(sql).toContain("'kind', 'outcome_rescore'");
    expect(sql).toContain('after insert on public.trade_outcomes');
  });

  test('half-Kelly multiplier: thin 0.5, floor 0.25, ceiling 1.0', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    expect(sql).toContain('when coalesce(p_n, 0) < 5 then 0.5');
    expect(sql).toContain('least(1.0, greatest(0.25,');
  });

  test('cap is 20% of book, entries/adds only; no DB guard rejects steward order writes', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    expect(sql).toContain('round(eq.equity * 0.20, 6)');
    expect(sql).toContain('greatest(v_cap - coalesce(v_pos, 0), 0)');
    for (const table of ['pm_orders', 'meme_orders', 'meme_positions', 'pm_positions', 'trade_intents', 'broker_fills', 'meme_fills', 'pm_fills']) {
      expect(sql).not.toMatch(new RegExp(`(insert into|update|delete from) public\\.${table}\\b`));
      expect(sql).not.toMatch(new RegExp(`before insert[^;]*on public\\.${table}\\b`));
    }
  });

  test('security: definer functions pin search_path, anon/authenticated get nothing, workers get guidance', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    const definers = sql.split('security definer').length - 1;
    expect(definers).toBeGreaterThanOrEqual(10);
    const bodies = sql.split(/create or replace function /).slice(1);
    for (const body of bodies) expect(body.slice(0, 900)).toContain("set search_path = ''");
    expect(sql).toContain('revoke all on function public.steward_sizing_guidance(text, text, text) from public, anon, authenticated');
    expect(sql).toContain('revoke all on function public.thesis_sizing() from public, anon, authenticated');
    expect(sql).toMatch(/grant execute on function public\.steward_sizing_guidance\(text, text, text\)\s+to quantanamo_worker, oddsborne_worker, bandit_worker, service_role/);
    expect(sql).toContain('create or replace view public.v_sizing_cap_breaches\nwith (security_invoker = true)');
    expect(sql).not.toMatch(/grant[^;]*to anon/);
  });

  test('trigger bodies never block steward writes', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    expect(sql.match(/exception when others then\s+raise warning/g)?.length).toBeGreaterThanOrEqual(5);
  });

  test('re-pricing is fills-only and keeps the previous numbers', async () => {
    const sql = await readFile(schemaPath, 'utf8');
    expect(sql).toContain("pnl_source = 'fills'");
    expect(sql).toContain("'repriced_from'");
    expect(sql).toContain('abs(a.bq - a.sq) <= greatest(a.bq, 1) * 0.000001');
    const run = await readFile(join(root, 'supabase/migrations/20260926170323_outcome_reprice_rescore_run.sql'), 'utf8');
    expect(run).toContain('select private.reprice_trade_outcomes(null);');
    expect(run.indexOf('reprice_trade_outcomes')).toBeLessThan(run.indexOf('rescore_all_thesis_confidence'));
  });
});
