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

  test('historical #84 file: 20% cap (superseded by 14), no DB guard rejects steward order writes', async () => {
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

describe('ODDSBORNE fills re-price SQL (PR 3)', () => {
  test('migrations are the schema files', async () => {
    for (const [schema, migration] of [
      ['12_pm_fills_reprice.sql', '20260926171206_pm_fills_reprice.sql'],
      ['13_scorecard_fill_backed.sql', '20260926171322_scorecard_fill_backed.sql'],
    ]) {
      expect(await readFile(join(root, 'supabase/migrations', migration!), 'utf8'))
        .toBe(await readFile(join(root, 'supabase/schemas', schema!), 'utf8'));
    }
  });

  test('backfill rows price from fills or fills + settlement; placeholders block pricing', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/12_pm_fills_reprice.sql'), 'utf8');
    expect(sql).toContain("return 'fills_suspect';");
    expect(sql).toContain("f.venue_fill_id like '%-partial-%'");
    expect(sql).toContain("v_source := 'settlement';");
    expect(sql).toContain('realized_pnl = round(v_proceeds - pm.bc - pm.fe, 6)');
    expect(sql).toContain("case when n_fills > 0 then fee_sum else private.try_numeric(pos.meta->>'fees') end");
    expect(sql).toContain('return private.reprice_pm_backfill_outcome(o.id);');
    for (const body of sql.split(/create or replace function /).slice(1)) {
      expect(body.slice(0, 400)).toContain("set search_path = ''");
    }
  });

  test('data run verifies the placeholder before deleting it and keeps a copy; heartbeat untouched', async () => {
    const run = await readFile(join(root, 'supabase/migrations/20260926171239_oddsborne_fills_reprice_run.sql'), 'utf8');
    expect(run).toContain("raise exception 'placeholder check failed");
    expect(run).toContain("'removed_placeholder_fill', to_jsonb(v_ph)");
    expect(run.indexOf("'removed_placeholder_fill'")).toBeLessThan(run.indexOf('delete from public.pm_fills'));
    expect(run).toContain('disable trigger pm_positions_touch_oddsborne');
    expect(run).toContain('enable trigger pm_positions_touch_oddsborne');
    expect(run).not.toMatch(/update public\.pm_positions\s+set[^;]*(status|closed_at)\s*=/);
    expect(run.indexOf("reprice_trade_outcomes('oddsborne')")).toBeLessThan(run.indexOf('rescore_all_thesis_confidence'));
  });
});

describe('no hard cap per position SQL (PR 4)', () => {
  const noCapPath = join(root, 'supabase/schemas/14_no_position_cap.sql');

  test('migration is the schema file at the prod version', async () => {
    expect(await readFile(join(root, 'supabase/migrations/20260926172239_no_position_cap.sql'), 'utf8'))
      .toBe(await readFile(noCapPath, 'utf8'));
  });

  test('guidance is requested x multiplier limited by spendable cash; no cap fields', async () => {
    const sql = await readFile(noCapPath, 'utf8');
    expect(sql).toContain('drop function if exists public.steward_sizing_guidance(text, text, text);');
    expect(sql).toContain('least(p_requested * v_mult, greatest(coalesce(ca.cash, 0), 0))');
    expect(sql).toContain("th.status = 'hardening' and coalesce(th.confidence, 0) >= 80");
    expect(sql).not.toMatch(/\* 0\.20|cap_notional|\bcap_pct|add_headroom|v_cap\b/);
    expect(sql).toContain('drop view if exists public.v_sizing_cap_breaches;');
    expect(sql).not.toContain('create or replace view');
  });

  test('risk_controls drop the % rails and retire thesis-notional', async () => {
    const sql = await readFile(noCapPath, 'utf8');
    expect(sql).toContain("set status = 'retired'");
    expect(sql).toContain("where control_key = 'thesis-notional'");
    expect(sql).toContain("threshold_json - 'max_single_trade_percent' - 'max_daily_notional_percent'");
    expect(sql).toContain("threshold_json - 'max_total_position_percent'");
  });

  test('security: search_path pinned, workers only on the 4-arg guidance', async () => {
    const sql = await readFile(noCapPath, 'utf8');
    for (const body of sql.split(/create or replace function /).slice(1)) {
      expect(body.slice(0, 900)).toContain("set search_path = ''");
    }
    expect(sql).toContain('revoke all on function public.steward_sizing_guidance(text, text, text, numeric) from public, anon, authenticated');
    expect(sql).toContain('revoke all on function private.steward_spendable_cash(text) from public, anon, authenticated');
    expect(sql).toMatch(/grant execute on function public\.steward_sizing_guidance\(text, text, text, numeric\)\s+to quantanamo_worker, oddsborne_worker, bandit_worker, service_role/);
    expect(sql).not.toMatch(/grant[^;]*to (anon|authenticated)/);
  });

  test('trade policy and docs carry no per-position cap', async () => {
    const policy = JSON.parse(await readFile(join(root, 'config/trade_policy.json'), 'utf8'));
    const text = JSON.stringify(policy);
    expect(text).not.toMatch(/max_single_trade_percent|max_percent_per_position|max_total_position_percent|max_daily_notional_percent|single_position_cap/);
    expect(await readFile(join(root, 'supabase/functions/dashboard-publication/trade-policy.json'), 'utf8'))
      .toBe(await readFile(join(root, 'config/trade_policy.json'), 'utf8'));
    const doc = await readFile(join(root, 'docs/sizing.md'), 'utf8');
    expect(doc).toContain('| Per-position cap | **None** |');
    expect(doc).not.toContain('20% of book is the hard cap');
  });
});
