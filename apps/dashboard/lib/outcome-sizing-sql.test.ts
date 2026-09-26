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

describe('confidence gate scope SQL (PR 5)', () => {
  const gatePath = join(root, 'supabase/schemas/15_sizing_gate_scope.sql');

  test('migration is the schema file at the prod version', async () => {
    expect(await readFile(join(root, 'supabase/migrations/20260926172826_sizing_gate_scope.sql'), 'utf8'))
      .toBe(await readFile(gatePath, 'utf8'));
  });

  test('>= 80 gate applies only to quantanamo; rejected thesis blocks entries for all stewards', async () => {
    const sql = await readFile(gatePath, 'utf8');
    expect(sql).toContain("v_gate_applies boolean := p_steward = 'quantanamo';");
    expect(sql).toContain("v_rejected := coalesce(th.status = 'rejected', false);");
    expect(sql).toContain("th.status = 'hardening' and coalesce(th.confidence, 0) >= 80");
    expect(sql).toMatch(/else\s+v_gate := not v_rejected;\s+v_allowed := not v_rejected;/);
    expect(sql).toContain('when v_rejected then 0::numeric');
    for (const field of ['gate_applies boolean', 'thesis_rejected boolean', 'entry_allowed boolean', 'entry_blocked_reason text']) {
      expect(sql).toContain(field);
    }
    expect(sql).not.toMatch(/\* 0\.20|cap_notional|add_headroom/);
  });

  test('security: search_path pinned, workers only', async () => {
    const sql = await readFile(gatePath, 'utf8');
    expect(sql).toContain("security definer\nset search_path = ''");
    expect(sql).toContain('revoke all on function public.steward_sizing_guidance(text, text, text, numeric) from public, anon, authenticated');
    expect(sql).toMatch(/grant execute on function public\.steward_sizing_guidance\(text, text, text, numeric\)\s+to quantanamo_worker, oddsborne_worker, bandit_worker, service_role/);
    expect(sql).not.toMatch(/grant[^;]*to (anon|authenticated)/);
  });

  test('docs scope the gate to QUANTANAMO', async () => {
    const doc = await readFile(join(root, 'docs/sizing.md'), 'utf8');
    expect(doc).toContain('**QUANTANAMO equity entries only**');
    expect(doc).toContain('`entry_allowed`');
  });
});

describe('thesis sync, retro tags, killed gate, no fixed rails (PR 6)', () => {
  const syncPath = join(root, 'supabase/schemas/16_outcome_thesis_sync.sql');
  const gatePath = join(root, 'supabase/schemas/17_killed_gate_no_rails.sql');

  test('migrations are the schema files at the prod versions', async () => {
    expect(await readFile(join(root, 'supabase/migrations/20260926173030_outcome_thesis_sync.sql'), 'utf8'))
      .toBe(await readFile(syncPath, 'utf8'));
    expect(await readFile(join(root, 'supabase/migrations/20260926173458_killed_gate_no_rails.sql'), 'utf8'))
      .toBe(await readFile(gatePath, 'utf8'));
  });

  test('a thesis_id change on any source position propagates to trade_outcomes, for every origin', async () => {
    const sql = await readFile(syncPath, 'utf8');
    for (const table of ['meme_positions', 'pm_positions', 'position_episodes']) {
      expect(sql).toMatch(new RegExp(`after update of thesis_id on public\\.${table}\\s+for each row when \\(old\\.thesis_id is distinct from new\\.thesis_id\\)`));
    }
    expect(sql).toContain('where o.source_table = tg_table_name');
    expect(sql).not.toContain("meta->>'origin' = 'trigger'");
    expect(sql).toMatch(/exception when others then\s+raise warning/);
    expect(sql).toContain("security definer\nset search_path = ''");
  });

  test('backfill copies tagged source theses only, then re-scores meme_4h_momentum_clip', async () => {
    const run = await readFile(join(root, 'supabase/migrations/20260926173056_outcome_thesis_backfill.sql'), 'utf8');
    expect(run).toContain('and s.th is not null');
    expect(run).toContain('and o.thesis_id is distinct from s.th');
    expect(run).toContain("select private.rescore_thesis_confidence('meme_4h_momentum_clip');");
  });

  test('SNOW and OCC retro tags record the reason and GRASSHOPPER; IREN stays untagged', async () => {
    const run = await readFile(join(root, 'supabase/migrations/20260926173152_retro_tag_snow_occ.sql'), 'utf8');
    expect(run).toContain("'quantanamo:SNOW:2026-09-02'");
    expect(run).toContain("'quantanamo:OCC:2026-09-08'");
    expect(run).toContain("'tagged_by', 'GRASSHOPPER'");
    expect(run).not.toMatch(/'quantanamo:IREN/);
    expect(run).toContain("select private.rescore_thesis_confidence('earnings_gap_structure');");
  });

  test('killed thesis blocks entries for all stewards; rails leave risk_controls', async () => {
    const sql = await readFile(gatePath, 'utf8');
    expect(sql).toContain("v_killed := coalesce(th.status = 'killed', false);");
    expect(sql).toContain('v_blocked := v_rejected or v_killed;');
    expect(sql).toContain("when v_killed then 'thesis_killed'");
    expect(sql).toContain('when v_blocked then 0::numeric');
    expect(sql).toContain("th.status = 'hardening' and coalesce(th.confidence, 0) >= 80");
    for (const key of ['max_trades_per_day', 'max_spread_bps', 'window_start', 'max_add_percent_per_review', 'reduce_percent_min', 'allow_averaging_down', 'max_adds_per_day']) {
      expect(sql).toContain(`'${key}'`);
    }
    expect(sql).toContain("where control_key = 'event-liquidity'");
    expect(sql).not.toMatch(/grant[^;]*to (anon|authenticated)/);
  });

  test('trade policy has no fixed rails', async () => {
    const text = await readFile(join(root, 'config/trade_policy.json'), 'utf8');
    for (const key of ['max_trades_per_day', 'max_spread_bps', 'autonomous_execution_window_start', 'max_add_percent_of_portfolio_value_per_review',
      'allow_averaging_down', 'reduce_percent_min', 'reduce_percent_max', 'max_adds_per_position_per_day', 'max_new_positions_per_run']) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(await readFile(join(root, 'supabase/functions/dashboard-publication/trade-policy.json'), 'utf8')).toBe(text);
  });
});

describe('no global stop or drawdown limit (PR 7)', () => {
  const path = join(root, 'supabase/schemas/18_thesis_exits_no_stop.sql');

  test('migration is the schema file at the prod version', async () => {
    expect(await readFile(join(root, 'supabase/migrations/20260926173855_thesis_exits_no_stop.sql'), 'utf8'))
      .toBe(await readFile(path, 'utf8'));
  });

  test('portfolio-drawdown retired; hard-loss exit removed from risk_controls', async () => {
    const sql = await readFile(path, 'utf8');
    expect(sql).toContain("where control_key = 'portfolio-drawdown'");
    expect(sql).toContain("set status = 'retired'");
    expect(sql).toContain("threshold_json - 'hard_loss_exit_percent'");
  });

  test('policy, code and docs carry no global stop', async () => {
    const policy = await readFile(join(root, 'config/trade_policy.json'), 'utf8');
    expect(policy).not.toContain('hard_loss_exit_percent');
    expect(policy).toContain('theses.falsifier');
    const code = await readFile(join(root, 'workers/research/src/position-decision.ts'), 'utf8');
    expect(code).not.toMatch(/returnPercent\s*<=\s*-/);
    expect(code).not.toContain('hard_loss');
    const orchestrator = await readFile(join(root, 'workers/research/src/research-orchestrator.ts'), 'utf8');
    expect(orchestrator).not.toContain('hard_loss_limit_percent');
    expect(orchestrator).toContain("version: 'autonomous-equity-v6'");
    const doc = await readFile(join(root, 'docs/sizing.md'), 'utf8');
    expect(doc).not.toMatch(/−8%|-8%/);
  });
});
