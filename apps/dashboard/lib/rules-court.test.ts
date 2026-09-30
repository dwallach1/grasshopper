import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

// The rules court (docs/rules/README.md): every trading rule has a ruling file and a registry
// row, and a migration that redefines a rule function names the ruling it implements.
const root = join(import.meta.dir, '../../..');
const rulesDir = join(root, 'docs/rules');
const NON_RULES = new Set(['README.md', 'TEMPLATE.md', 'SIMULATION.md']);

async function ruleIds(): Promise<string[]> {
  const src = await readFile(join(root, 'tools/court/rules_data.py'), 'utf8');
  return [...src.matchAll(/^\s*id="([a-z0-9-]+)"/gm)].map((m) => m[1]);
}

async function schemaFiles(minNumber: number): Promise<string[]> {
  const files = await readdir(join(root, 'supabase/schemas'));
  return files.filter((f) => /^\d+_.*\.sql$/.test(f) && Number.parseInt(f, 10) >= minNumber).sort();
}

describe('rules court', () => {
  test('every rule in rules_data has a ruling file with the four opinions, and vice versa', async () => {
    const ids = await ruleIds();
    expect(ids.length).toBeGreaterThanOrEqual(18);
    expect(new Set(ids).size).toBe(ids.length);
    const files = (await readdir(rulesDir)).filter((f) => f.endsWith('.md') && !NON_RULES.has(f));
    expect(files.map((f) => f.replace(/\.md$/, '')).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const md = await readFile(join(rulesDir, `${id}.md`), 'utf8');
      expect(md).toContain(`rule_id: ${id}`);
      for (const section of ['## Purpose', '## Mechanism', '**GROWTH.**', '**RUIN.**', '**STATISTICS.**',
        '**INCENTIVES / GAMING.**', '## Evidence', '## Ruling', 'Amendment:', '## Interactions']) {
        expect(md).toContain(section);
      }
      expect(md).toMatch(/verdict: \*\*(uphold|amend|strike)\*\*/);
    }
  });

  test('the README rulebook lists every rule', async () => {
    const readme = await readFile(join(rulesDir, 'README.md'), 'utf8');
    for (const id of await ruleIds()) expect(readme).toContain(`[${id}](${id}.md)`);
  });

  test('the desk_rules seed has exactly one row per rule', async () => {
    const seed = await readFile(join(root, 'supabase/schemas/36_desk_rules_seed.sql'), 'utf8');
    const ids = await ruleIds();
    const rows = [...seed.matchAll(/^  \('([a-z0-9-]+)', /gm)].map((m) => m[1]);
    expect(rows.sort()).toEqual([...ids].sort());
  });

  test('a migration >= 35 that defines a rule function carries a court-ruling marker naming an existing ruling', async () => {
    const fns = (await readFile(join(root, 'tools/court/rule_functions.txt'), 'utf8'))
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(fns).toContain('private.edge_max_stake');
    let checked = 0;
    for (const f of await schemaFiles(35)) {
      const sql = await readFile(join(root, 'supabase/schemas', f), 'utf8');
      const defines = fns.filter((fn) => new RegExp(`create (or replace )?function ${fn.replace('.', '\\.')}\\(`, 'i').test(sql));
      if (defines.length === 0) continue;
      checked++;
      const markers = [...sql.matchAll(/^-- court-ruling: (docs\/rules\/[a-z0-9-]+\.md)$/gm)].map((m) => m[1]);
      expect({ file: f, markers: markers.length > 0 }).toEqual({ file: f, markers: true });
      for (const m of markers) expect(existsSync(join(root, m))).toBe(true);
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  test('court migrations: repo copies equal the schema files', async () => {
    const pairs: [string, string][] = [
      ['35_desk_rules.sql', '20260926214632_desk_rules.sql'],
      ['36_desk_rules_seed.sql', '20260926214704_desk_rules_seed.sql'],
      ['37_court_rulings.sql', '20260926214819_court_rulings.sql'],
      ['38_edge_max_stake_null_thesis.sql', '20260926214848_edge_max_stake_null_thesis.sql'],
      ['39_desk_rules_paths_sync.sql', '20260926214953_desk_rules_paths_sync.sql'],
      ['41_court_decisions.sql', '20260926220243_court_decisions.sql'],
      ['42_court_decisions_registry.sql', '20260926220333_court_decisions_registry.sql'],
      ['43_thesis_scorecard_results.sql', '20260926221039_thesis_scorecard_results.sql'],
      ['44_exposure_gap_full_notional.sql', '20260926221414_exposure_gap_full_notional.sql'],
      ['45_exposure_gap_registry.sql', '20260926221455_exposure_gap_registry.sql'],
      ['46_backtest_evidence_symmetric.sql', '20260927232545_backtest_evidence_symmetric.sql'],
      ['47_backtest_credit_live_gated.sql', '20260927233853_backtest_credit_live_gated.sql'],
      ['48_quantanamo_gate_small_sample.sql', '20260930192137_quantanamo_gate_small_sample.sql'],
    ];
    for (const [schema, migration] of pairs) {
      expect(await readFile(join(root, 'supabase/migrations', migration), 'utf8'))
        .toBe(await readFile(join(root, 'supabase/schemas', schema), 'utf8'));
    }
  });

  test('rulings: halving and the sizing multiplier are gone; drawdown scale and backtest credit are in', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/37_court_rulings.sql'), 'utf8');
    const fix = await readFile(join(root, 'supabase/schemas/38_edge_max_stake_null_thesis.sql'), 'utf8');
    const body = fix.slice(fix.indexOf('create or replace function private.edge_max_stake'));
    expect(body).not.toContain('loss_streak');
    expect(body).toContain('private.steward_drawdown(p_steward)');
    expect(body).toContain('v_w * 0.5 * coalesce(bt.mean_ret, 0)');
    // The evidence lookup runs for a null thesis too (38 fixed "record bt is not assigned yet").
    expect(body).not.toContain('if p_thesis_id is not null then');
    expect(sql).toContain('least(0.5 * b.n_trades, 20)');
    expect(sql).toContain("t.status = 'survived' and t.deflated_sharpe > 0");
    expect(sql).toContain('round(least(p_requested, ms.max_stake, greatest(coalesce(ca.cash, 0), 0)), 6)');
    expect(sql).not.toContain('p_requested * v_mult');
    expect(sql).toContain("when dd.x >= 0.40 then 0.5");
    // 37 left the 80 gate on stated confidence; 41 moved it to the results score.
    expect(sql).toContain("th.status = 'hardening' and coalesce(th.confidence, 0) >= 80");
    const seed = await readFile(join(root, 'supabase/schemas/36_desk_rules_seed.sql'), 'utf8');
    expect(seed).toContain("('quantanamo-80-gate', ");
  });

  test('40: guidance no longer returns the struck multiplier, and steward scripts do not read it', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/40_guidance_drop_multiplier.sql'), 'utf8');
    expect(await readFile(join(root, 'supabase/migrations/20260926215608_guidance_drop_multiplier.sql'), 'utf8')).toBe(sql);
    expect(sql).toContain('-- court-ruling: docs/rules/confidence-multiplier.md');
    const ret = sql.slice(sql.indexOf('returns table ('), sql.indexOf('language plpgsql'));
    for (const col of ['multiplier', 'multiplier_basis', 'half_kelly_fraction']) expect(ret).not.toMatch(new RegExp(`\\b${col}\\b`));
    for (const f of ['stewards/oddsborne/pm_enter.py', 'stewards/bandit/live_trade_clip.py', 'stewards/bandit/paper_bank20.py']) {
      const src = await readFile(join(root, f), 'utf8');
      expect(src).not.toMatch(/\[["']multiplier(_basis)?["']\]|get\(["']multiplier/);
    }
  });

  test('41: v=3% starter, results-score gate, expectancy re-score, 10% exposure cap', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/41_court_decisions.sql'), 'utf8');
    for (const id of ['starter-stake', 'quantanamo-80-gate', 'outcome-rescore-confidence', 'portfolio-exposure', 'new-thesis-escape']) {
      expect(sql).toContain(`-- court-ruling: docs/rules/${id}.md`);
    }
    expect(sql).toContain('round(0.03 / private.steward_bet_vol(p_steward), 5)');
    expect(sql).toContain("th.status = 'hardening' and coalesce(th.results_confidence, 0) >= 80");
    expect(sql).not.toContain('coalesce(th.confidence, 0) >= 80');
    expect(sql).toContain("'quantanamo_unscored'");
    expect(sql).toContain("'exposure_cap'");
    expect(sql).toContain('create or replace function private.risk_budget_share()');
    expect(sql).toContain('create trigger theses_results_guard');
    const registry = await readFile(join(root, 'supabase/schemas/42_court_decisions_registry.sql'), 'utf8');
    expect(registry).toContain("('portfolio-exposure', ");
    expect(registry).not.toMatch(/, true, 'docs\/rules\//);
  });

  test('44: gap-prone lots count at full notional; equities keep to-invalidation; risk_basis is reported', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/44_exposure_gap_full_notional.sql'), 'utf8');
    expect(sql).toContain('-- court-ruling: docs/rules/portfolio-exposure.md');
    expect(sql).toContain("when m.lot_table = 'pm_positions' then m.quantity * coalesce(m.mark, c.average_cost, 0)");
    expect(sql).toContain("when m.lot_table = 'meme_positions' then m.quantity * coalesce(c.average_cost, m.mark, 0)");
    expect(sql).toContain('else m.quantity * greatest(m.mark - m.invalidation_price, 0)');
    expect(sql).toContain("when p_steward in ('oddsborne', 'bandit') then 'full_notional' else 'to_invalidation'");
    expect(sql).toContain("when ex.risk_basis = 'full_notional' then 1");
    expect(sql).toContain("'risk_basis', x.risk_basis");
    const ret = sql.slice(sql.indexOf('create function public.steward_sizing_guidance('), sql.indexOf('language plpgsql'));
    expect(ret).toMatch(/entry_risk_fraction numeric,\s+risk_basis text\s*\)/);
    const registry = await readFile(join(root, 'supabase/schemas/45_exposure_gap_registry.sql'), 'utf8');
    expect(registry).toContain('gap-prone lots at full notional');
  });

  test('46: backtest evidence counts pass or fail, preregistered, trial-deflated, survivors discounted', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/46_backtest_evidence_symmetric.sql'), 'utf8');
    expect(sql).toContain('-- court-ruling: docs/rules/backtest-evidence-credit.md');
    expect(sql).toContain('-- court-ruling: docs/rules/outcome-rescore-confidence.md');
    expect(sql).toContain('check (rules_locked_at < results_at)');
    expect(sql).toContain('check (trials >= 1)');
    // No pass requirement: a killed test counts, and the old survivors-only filter is gone.
    expect(sql).not.toContain("t.status = 'survived' and t.deflated_sharpe > 0");
    expect(sql).toContain("t.status in ('survived', 'killed')");
    expect(sql).toContain('case when new.survivors_only then 0.5 else 1 end');
    expect(sql).toContain('private.expected_max_normal(new.trials) * new.sd_ret / sqrt(new.n_trades::numeric)');
    expect(sql).toContain("new.rules_locked_at := (t.params_json ->> 'preregistered_at')::timestamptz");
    // Append-only for stewards, one row per test.
    expect(sql).toContain('revoke update on public.thesis_backtest_evidence from quantanamo_worker, oddsborne_worker, bandit_worker');
    expect(sql).toContain('with check (active)');
    expect(sql).toContain('on public.thesis_backtest_evidence (thesis_id, strategy_test_id)');
    expect(sql).toContain('create or replace view public.v_backtest_tests_unlogged');
    // Test 31 is logged against its own thesis and the re-score job runs; no hand-set score.
    expect(sql).toContain("select 'earnings_gap_structure', t.id, 714, -0.003457, 0.062007");
    expect(sql).toContain('select private.rescore_all_thesis_confidence();');
    expect(sql).not.toMatch(/update public\.theses/);
    expect(sql).toContain("('backtest-evidence-credit', ");
  });

  test('47: backtest credit is live-gated, capped, deflated-Sharpe mean, verified tests only', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/47_backtest_credit_live_gated.sql'), 'utf8');
    expect(sql).toContain('-- court-ruling: docs/rules/backtest-evidence-credit.md');
    expect(sql).toContain('-- court-ruling: docs/rules/outcome-rescore-confidence.md');
    // No credit below 3 live trades; pooled weight <= min(5, live / 2); a thesis is scored only at >= 3 live trades.
    expect(sql).toContain('where coalesce(p_n_live, 0) >= 3');
    expect(sql).toContain('least(sum(r.base), 5, p_n_live / 2.0)');
    expect(sql).toContain('if v_n >= 3 then');
    // Per-test weight min(0.5n, 5) x (1 - missing share) for survivors-only; credited mean = deflated Sharpe x spread.
    expect(sql).toContain('least(0.5 * new.n_trades, 5) * v_f');
    expect(sql).toContain('t.deflated_sharpe::numeric * new.sd_ret');
    expect(sql).not.toContain('0.5 * e.mean_ret_deflated');
    // Unverified tests earn nothing.
    expect(sql).toContain('ineligible_reason');
    expect(sql).toContain('rules_locked_at < results_at');
    // No row for unverified point-in-time inputs or a filtered subset of another test (test 32), in the
    // derive trigger and in the unlogged-tests view.
    expect(sql).toContain("has unverified point-in-time inputs (%): no evidence row");
    expect(sql).toContain('is a subset of test % on the same thesis');
    expect(sql.match(/e\.key ~ '\(\^\|_\)point_in_time\$'/g)?.length).toBe(2);
    expect(sql).toContain("where p.id = case when t.params_json ->> 'parent_test_id' ~ '^[0-9]+$'");
    // 46's strategy_tests read grant to ODDSBORNE / BANDIT stays.
    expect(sql).not.toMatch(/revoke select on public\.strategy_tests/);
    expect(sql).not.toMatch(/drop policy if exists steward_select/);
    expect(sql).not.toMatch(/strategy_test_id = 32/);
    // Test 30 logged once, test 31 re-derived, then the re-score job; no hand-set score.
    expect(sql).toContain('and not exists (select 1 from public.thesis_backtest_evidence b where b.strategy_test_id = 30)');
    expect(sql).toContain('select private.rescore_all_thesis_confidence();');
    expect(sql).not.toMatch(/update public\.theses/);
    expect(sql).toContain("('backtest-evidence-credit', ");
  });

  test('48: the 80 gate reads a small-sample shrunk score; the shown score is unchanged', async () => {
    const sql = await readFile(join(root, 'supabase/schemas/48_quantanamo_gate_small_sample.sql'), 'utf8');
    expect(sql).toContain('-- court-ruling: docs/rules/quantanamo-80-gate.md');
    // Prior of 16 zero-mean trades, fading with live trades, gate only.
    expect(sql).toContain('v_gate_z := v_z * sqrt(v_n / (v_n + 16))');
    expect(sql).toContain("round(100 * private.normal_cdf(v_gate_z))");
    expect(sql).toContain("'gate_score', sc.gate_score, 'gate_prior', 16");
    expect(sql).toContain("coalesce((th.results_basis ->> 'gate_score')::int, 0) >= 80");
    // The shown score is still the unshrunk one, and only the re-score writes it.
    expect(sql).toContain('round(100 * private.normal_cdf(v_z))');
    expect(sql).toContain('results_confidence = sc.score');
    expect(sql).not.toMatch(/results_confidence = \d/);
    expect(sql).toContain('select private.rescore_all_thesis_confidence();');
    expect(sql).toContain("('quantanamo-80-gate', ");
  });
});
