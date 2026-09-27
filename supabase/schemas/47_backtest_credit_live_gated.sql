-- Court ruling 2026-09-27 (follow-up to migration 46): backtest evidence counts pass or fail, but only as a
-- small correction to live results (docs/rules/backtest-evidence-credit.md).
-- court-ruling: docs/rules/backtest-evidence-credit.md
-- court-ruling: docs/rules/outcome-rescore-confidence.md
-- court-ruling: docs/rules/edge-max-stake.md
-- court-ruling: docs/rules/quantanamo-80-gate.md
--
-- Migration 46 let every completed preregistered test count, pass or fail, but at up to 20 effective trades
-- (more than most theses have live) and from before the first live trade. Now:
-- 1. No backtest credit until the thesis has 3 live trades; a thesis is scored only with >= 3 live trades
--    (unscored stays unscored, so backtests alone can never open the QUANTANAMO 80 gate).
-- 2. Pooled weight = min(sum of 0.5 x n, 5, live trades / 2) x the pooled survivor factor, where a
--    survivors-only test has factor 1 - missing share (0.5 if the share is unknown). Backtests are at most a
--    third of the effective trades and never more than 5.
-- 3. Credited mean = deflated Sharpe (the ledger's strategy_tests.deflated_sharpe, at the thesis's trial
--    count) x the test's spread. No extra shrink, same either sign. The backtest spread never shrinks the
--    live spread: sd is the live sd (floored at 0.25 in the score).
-- 4. Unverified tests earn nothing: the linked test must be survived or killed (placeholder, lookahead_invalid,
--    queued and unverified tests are out), carry a price source and a date window, have its rules locked
--    before its results, a stored deflated Sharpe, and a trial count >= the tests the thesis had run by then.
--    The verdict is stored on the evidence row (verified, ineligible_reason) and re-derived when the test row
--    changes, so the evidence views no longer read strategy_tests.
-- 5. No row at all for a test whose point-in-time inputs are unverified (a *point_in_time param not 'true')
--    or that filters another test's events on the same thesis (parent_test_id): the insert is refused and
--    v_backtest_tests_unlogged leaves it out. Such a test counts as a trial (it deflates later tests), never as
--    more evidence. Test 32 (trial 18, beat-streak filter on test 31's events, estimates unverified) is both.
-- 6. Keeps 46's strategy_tests read grant to oddsborne_worker / bandit_worker (v_backtest_tests_unlogged reads
--    strategy_tests as the invoker).
-- 7. Re-derives test 31's row, logs test 30 (the other completed preregistered earnings_gap_structure test),
--    and runs the re-score job.

-- ---------------------------------------------------------------- table
alter table public.thesis_backtest_evidence add column if not exists test_status text;
alter table public.thesis_backtest_evidence add column if not exists thesis_trials integer;
alter table public.thesis_backtest_evidence add column if not exists verified boolean not null default false;
alter table public.thesis_backtest_evidence add column if not exists ineligible_reason text;

comment on table public.thesis_backtest_evidence is
  'Backtest evidence per thesis, pass or fail (docs/rules/backtest-evidence-credit.md). Derived by trigger from the linked strategy_tests row: rules_locked_at (preregistered_at), results_at (tested_at), deflated_sharpe, test_status, thesis_trials, verified / ineligible_reason. weight = min(0.5 x n, 5) x survivor factor (1 - missing_share for survivors-only); mean_ret_deflated = deflated Sharpe x sd_ret. A verified row counts only once the thesis has >= 3 live trades, pooled weight <= min(5, live trades / 2). Append-only for stewards.';

-- ---------------------------------------------------------------- derive
create or replace function private.backtest_evidence_derive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  v_f numeric;
  v_other boolean;
  v_pit text;
  v_parent bigint;
begin
  -- The linked strategy test (and its research cycle) is the record of what was tested, for which thesis,
  -- when the rules were locked and when results came in. Stewards can't back-date a lock or move a test.
  select st.status, st.tested_at, st.params_json, st.price_source, st.window_start, st.window_end,
         st.deflated_sharpe, rc.thesis_id as rc_thesis, rc.preregistered_at as rc_prereg,
         case when st.params_json ->> 'parent_test_id' ~ '^[0-9]+$' then (st.params_json ->> 'parent_test_id')::bigint end as parent_id
    into t
  from public.strategy_tests st
  left join public.research_cycles rc on rc.id = st.cycle_id
  where st.id = new.strategy_test_id;
  if not found then
    raise exception 'backtest evidence needs a strategy_tests row (strategy_test_id %)', new.strategy_test_id;
  end if;
  if tg_op = 'INSERT' and t.status not in ('survived', 'killed') then
    raise exception 'strategy test % is %, not completed', new.strategy_test_id, t.status;
  end if;
  v_other := coalesce(t.params_json ->> 'thesis_id', t.rc_thesis) is distinct from new.thesis_id;
  if tg_op = 'INSERT' and v_other then
    raise exception 'strategy test % belongs to thesis %, not %', new.strategy_test_id,
      coalesce(t.params_json ->> 'thesis_id', t.rc_thesis), new.thesis_id;
  end if;
  -- Point-in-time inputs marked unverified (e.g. estimate_point_in_time = unverified).
  select string_agg(e.key, ', ' order by e.key) into v_pit
  from jsonb_each_text(coalesce(t.params_json, '{}'::jsonb)) e
  where e.key ~ '(^|_)point_in_time$' and lower(coalesce(e.value, '')) <> 'true';
  -- A filtered subset of another test on the same thesis re-uses that test's events.
  select p.id into v_parent
  from public.strategy_tests p
  left join public.research_cycles pr on pr.id = p.cycle_id
  where p.id = t.parent_id and p.id <> new.strategy_test_id
    and coalesce(p.params_json ->> 'thesis_id', pr.thesis_id) = new.thesis_id;
  if tg_op = 'INSERT' and v_pit is not null then
    raise exception 'strategy test % has unverified point-in-time inputs (%): no evidence row', new.strategy_test_id, v_pit;
  end if;
  if tg_op = 'INSERT' and v_parent is not null then
    raise exception 'strategy test % is a subset of test % on the same thesis (events already counted there): no evidence row',
      new.strategy_test_id, v_parent;
  end if;
  if tg_op = 'INSERT' then
    new.rules_locked_at := coalesce((t.params_json ->> 'preregistered_at')::timestamptz, t.rc_prereg, new.rules_locked_at);
    new.results_at := coalesce(t.tested_at, new.results_at);
  end if;
  if t.params_json ? 'trial_number' then
    new.trials := greatest(coalesce(new.trials, 1), (t.params_json ->> 'trial_number')::int);
  end if;
  -- The thesis's trial count when the results came in: every non-placeholder test on its research cycles.
  new.thesis_trials := (
    select count(*)::int
    from public.strategy_tests s2
    join public.research_cycles r2 on r2.id = s2.cycle_id
    where r2.thesis_id = new.thesis_id and s2.status <> 'placeholder' and s2.tested_at <= new.results_at);
  new.deflated_sharpe := t.deflated_sharpe;
  new.test_status := t.status;
  new.passed := t.status = 'survived';
  new.ineligible_reason := case
    when v_other then 'test belongs to another thesis'
    when t.status not in ('survived', 'killed') then 'test ' || t.status
    when v_pit is not null then 'unverified: point-in-time inputs not verified (' || v_pit || ')'
    when v_parent is not null then format('subset of test %s (events already counted there)', v_parent)
    when t.price_source is null or t.window_start is null or t.window_end is null
      then 'unverified: no price source or date window'
    when new.rules_locked_at is null or new.results_at is null or new.rules_locked_at >= new.results_at
      then 'unverified: rules not locked before results'
    when t.deflated_sharpe is null then 'unverified: no deflated Sharpe'
    when new.trials < coalesce(new.thesis_trials, 1)
      then format('unverified: deflated at %s trials, thesis had run %s', new.trials, new.thesis_trials)
    when not new.out_of_sample then 'not out of sample'
    when not new.costs_included then 'costs not included'
    when not new.active then 'inactive'
  end;
  new.verified := new.ineligible_reason is null;
  v_f := case when new.survivors_only then 1 - coalesce(new.missing_share, 0.5) else 1 end;
  new.weight := round(least(0.5 * new.n_trades, 5) * v_f, 4);
  new.mean_ret_deflated := round(t.deflated_sharpe::numeric * new.sd_ret, 8);
  new.trial_deflation := round(new.mean_ret - new.mean_ret_deflated, 8);
  return new;
end;
$$;

-- A change to the test record (status voided, results re-run, source, window or params corrected) re-derives its
-- evidence rows; the evidence update trigger then re-scores the thesis.
create or replace function private.backtest_evidence_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.thesis_backtest_evidence set recorded_at = recorded_at where strategy_test_id = new.id;
  return null;
end;
$$;

drop trigger if exists strategy_tests_evidence_sync on public.strategy_tests;
create trigger strategy_tests_evidence_sync
  after update of status, tested_at, deflated_sharpe, price_source, window_start, window_end, cycle_id, params_json
  on public.strategy_tests
  for each row execute function private.backtest_evidence_sync();

-- ---------------------------------------------------------------- rule math
drop function if exists private.thesis_edge_evidence(text);

create or replace function private.thesis_edge_evidence(p_thesis_id text, p_n_live integer)
returns table (n_backtest integer, weight numeric, mean_ret numeric, sd_ret numeric, evidence_id bigint, tests integer)
language sql
stable
set search_path = ''
as $$
  -- Verified rows only, and only once the thesis has 3 live trades. Weight min(sum 0.5 n, 5, n_live / 2)
  -- x the pooled survivor factor; mean = deflated Sharpe x spread, pooled by 0.5 n x factor.
  with r as (
    select b.id, b.n_trades, 0.5 * b.n_trades as base,
           case when b.survivors_only then 1 - coalesce(b.missing_share, 0.5) else 1 end as f,
           b.mean_ret_deflated as m, b.sd_ret as sd
    from public.thesis_backtest_evidence b
    join public.strategy_tests t on t.id = b.strategy_test_id
    where b.thesis_id = p_thesis_id and b.verified and b.active and b.out_of_sample and b.costs_included
      and b.rules_locked_at < b.results_at and b.mean_ret_deflated is not null
      and t.status in ('survived', 'killed') and t.price_source is not null
      and t.window_start is not null and t.window_end is not null
  )
  select sum(r.n_trades)::int,
         round(least(sum(r.base), 5, p_n_live / 2.0) * sum(r.base * r.f) / sum(r.base), 4),
         sum(r.base * r.f * r.m) / sum(r.base * r.f),
         sqrt(sum(r.base * r.f * r.sd ^ 2) / sum(r.base * r.f)),
         max(r.id),
         count(*)::int
  from r
  where coalesce(p_n_live, 0) >= 3
  having count(*) > 0;
$$;

comment on function private.thesis_edge_evidence(text, integer) is
  'Pooled backtest credit for a thesis with p_n_live live trades: none below 3 live trades; weight = min(sum 0.5 x n, 5, n_live / 2) x pooled survivor factor; mean = pooled deflated Sharpe x spread (either sign). Verified rows only. docs/rules/backtest-evidence-credit.md';

create or replace function private.edge_max_stake(p_steward text, p_thesis_id text, p_book_equity numeric)
returns table (max_stake numeric, reason text, trades integer, lcb numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  st record;
  bt record;
  dd record;
  v_starter numeric;
  v_n numeric;
  v_w numeric := 0;
  v_neff numeric;
  v_mean numeric;
  v_var numeric;
  v_sd numeric;
  v_lcb numeric;
  v_kelly numeric;
  v_growth numeric;
  v_stake numeric;
  v_reason text;
  v_ev text := '';
  v_digits int := case when p_steward = 'bandit' then 4 else 2 end;
begin
  v_starter := case when p_book_equity > 0
    then round(private.steward_starter_share(p_steward) * p_book_equity, v_digits)
    else private.steward_starter_stake(p_steward) end;
  select * into st from private.stake_edge_stats(p_steward, p_thesis_id);
  v_n := coalesce(st.n, 0);
  -- Always assign bt (a null thesis, or one with < 3 live trades, gets no evidence row).
  select * into bt from private.thesis_edge_evidence(p_thesis_id, v_n::int);
  v_w := coalesce(bt.weight, 0);
  v_neff := v_n + v_w;
  if v_neff > 0 then
    v_mean := (v_n * coalesce(st.mean_ret, 0) + v_w * coalesce(bt.mean_ret, 0)) / v_neff;
  end if;
  -- The spread is the live spread; backtest credit never narrows it.
  v_var := case when v_n >= 2 and st.sd_ret is not null then st.sd_ret ^ 2 end;
  v_sd := sqrt(v_var);
  if v_neff >= 2 and v_sd is not null then
    v_lcb := v_mean - v_sd / sqrt(v_neff);
  end if;
  if v_w > 0 then
    v_ev := format(' (%s live + %s backtest-weighted, deflated backtest mean %s%%)',
      v_n, trim_scale(round(v_w, 2)), round(bt.mean_ret * 100, 2));
  end if;

  if v_neff >= 10 and v_lcb > 0 then
    v_growth := v_starter * power(2::numeric, 1 + (v_neff - 10) / 5.0);
    v_kelly := case when v_sd > 0 and p_book_equity > 0
      then p_book_equity * 0.5 * v_lcb / (v_sd * v_sd) end;
    v_stake := greatest(v_starter, least(coalesce(v_kelly, v_growth), v_growth));
    v_reason := format('proven edge: n_eff=%s%s, LCB %s%% per trade; min(half-Kelly on LCB x book, starter x 2^(1+(n-10)/5))',
      trim_scale(round(v_neff, 2)), v_ev, round(v_lcb * 100, 2));
  else
    v_stake := v_starter;
    v_reason := case
      when v_neff < 10 then format('unproven: %s effective trades (< 10)%s; starter %s (%s%% of book)',
        trim_scale(round(v_neff, 2)), v_ev, v_starter, round(private.steward_starter_share(p_steward) * 100, 2))
      else format('no measured edge: LCB %s%% <= 0 over %s effective trades%s; starter %s (%s%% of book)',
        round(v_lcb * 100, 2), trim_scale(round(v_neff, 2)), v_ev, v_starter, round(private.steward_starter_share(p_steward) * 100, 2))
    end;
  end if;

  select * into dd from private.steward_drawdown(p_steward);
  if dd.scale is not null and dd.scale < 1 then
    v_stake := v_stake * dd.scale;
    v_reason := v_reason || format('; x%s steward drawdown scale (book %s%% below its closing high %s)',
      trim_scale(dd.scale), round(dd.drawdown * 100, 1), trim_scale(round(dd.hwm, v_digits)));
  end if;
  return query select round(v_stake, v_digits), v_reason, v_n::int, round(v_lcb, 6);
end;
$$;

create or replace function private.thesis_results_score(p_thesis_id text)
returns table (score smallint, n_live integer, bt_weight numeric, n_eff numeric, mean_eff numeric,
               sd_eff numeric, z numeric, ucb numeric, demote boolean, kill boolean)
language plpgsql
stable
set search_path = ''
as $$
declare
  st record;
  bt record;
  v_n numeric;
  v_w numeric;
  v_neff numeric;
  v_mean numeric;
  v_sd numeric;
  v_z numeric;
  v_ucb numeric;
begin
  select * into st from private.stake_edge_stats(null, p_thesis_id);
  v_n := coalesce(st.n, 0);
  select * into bt from private.thesis_edge_evidence(p_thesis_id, v_n::int);
  v_w := coalesce(bt.weight, 0);
  v_neff := v_n + v_w;
  if v_neff > 0 then
    v_mean := (v_n * coalesce(st.mean_ret, 0) + v_w * coalesce(bt.mean_ret, 0)) / v_neff;
  end if;
  v_sd := greatest(coalesce(st.sd_ret, 0), 0.25);
  -- Scored only with >= 3 live trades; backtest credit can't score a thesis on its own.
  if v_n >= 3 then
    v_z := v_mean / (v_sd / sqrt(v_neff));
  end if;
  if v_n >= 2 then
    v_ucb := st.mean_ret + v_sd / sqrt(v_n);
  end if;
  return query select
    case when v_z is not null then round(100 * private.normal_cdf(v_z))::smallint end,
    v_n::int, v_w, v_neff, round(v_mean, 6), round(v_sd, 6), round(v_z, 4), round(v_ucb, 6),
    coalesce(v_ucb < 0, false) or (v_n >= 10 and coalesce(st.mean_ret, 0) < 0),
    v_n >= 10 and coalesce(v_ucb < 0, false);
end;
$$;

comment on function private.thesis_results_score(text) is
  'Results score: scored only with >= 3 live trades. n_eff = live trades + backtest weight (private.thesis_edge_evidence: min(sum 0.5 x n, 5, live / 2) x survivor factor, verified tests only, pass or fail); mean_eff pools the live mean with the deflated-Sharpe x spread backtest mean; sd_eff = max(live sd, 0.25); score = round(100 x Phi(mean_eff / (sd_eff / sqrt(n_eff)))). demote: live UCB < 0 or (n >= 10 and mean < 0); kill: n >= 10 and UCB < 0 (live only).';

revoke all on function private.backtest_evidence_derive() from public, anon, authenticated;
revoke all on function private.backtest_evidence_sync() from public, anon, authenticated;
revoke all on function private.thesis_edge_evidence(text, integer) from public, anon, authenticated;
revoke all on function private.edge_max_stake(text, text, numeric) from public, anon, authenticated;
revoke all on function private.thesis_results_score(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- views (no strategy_tests read)
create or replace view public.v_thesis_backtest_evidence
with (security_invoker = true)
as
select b.id, b.thesis_id, b.strategy_test_id, b.test_status, b.n_trades, b.hit_rate, b.mean_ret, b.sd_ret,
       b.deflated_sharpe, b.trials, b.survivors_only, b.missing_share, b.weight, b.trial_deflation, b.mean_ret_deflated,
       b.rules_locked_at, b.results_at, b.window_start, b.window_end, b.method, b.recorded_by, b.recorded_at,
       (b.verified and b.active and b.mean_ret_deflated is not null) as counted,
       case when b.mean_ret_deflated > 0 then 'for' when b.mean_ret_deflated < 0 then 'against' else 'neutral' end as effect,
       b.thesis_trials, b.verified, b.ineligible_reason
from public.thesis_backtest_evidence b;

comment on view public.v_thesis_backtest_evidence is
  'Every logged backtest per thesis: derived weight (max, before the live-trade cap), deflated-Sharpe x spread mean, whether it is verified and counts, why not, and whether it pulls the score up (for) or down (against). Credit applies only once the thesis has >= 3 live trades.';

create or replace view public.v_backtest_tests_unlogged
with (security_invoker = true)
as
-- Reads strategy_tests only (ODDSBORNE / BANDIT can read it, not research_cycles). A test with no preregistered_at
-- param still shows (test 30 locked its rules on its research cycle), so nothing completed slips through.
select t.id as strategy_test_id, t.params_json ->> 'thesis_id' as thesis_id, t.status, t.tested_at,
       t.params_json ->> 'preregistered_at' as preregistered_at,
       t.params_json ->> 'trial_number' as trial_number,
       t.deflated_sharpe
from public.strategy_tests t
where t.status in ('survived', 'killed')
  and t.params_json ->> 'thesis_id' is not null
  and not exists (select 1 from public.thesis_backtest_evidence b where b.strategy_test_id = t.id)
  -- No row by rule: unverified point-in-time inputs, or a filtered subset of another test on the same thesis.
  and not exists (select 1 from jsonb_each_text(t.params_json) e
                  where e.key ~ '(^|_)point_in_time$' and lower(coalesce(e.value, '')) <> 'true')
  and not exists (select 1 from public.strategy_tests p
                  where p.id = case when t.params_json ->> 'parent_test_id' ~ '^[0-9]+$'
                                    then (t.params_json ->> 'parent_test_id')::bigint end
                    and p.id <> t.id
                    and p.params_json ->> 'thesis_id' = t.params_json ->> 'thesis_id');

comment on view public.v_backtest_tests_unlogged is
  'Completed thesis tests (thesis named in the test params) with no backtest evidence row. Should be empty: pass or fail, every one is logged, except tests with unverified point-in-time inputs and filtered subsets of another test on the same thesis, which by rule get no row (docs/rules/backtest-evidence-credit.md).';

-- 46's strategy_tests read grant to oddsborne_worker / bandit_worker stays: the unlogged view reads
-- strategy_tests as the invoker.

-- Scorecard (same columns as 46): backtest_weight is the weight the re-score applied (0 until 3 live trades).
create or replace view public.v_thesis_scorecard
with (security_invoker = true)
as
with o as (
  select t.thesis_id, t.steward, t.unit, t.realized_pnl, t.confidence_at_entry
  from public.trade_outcomes t
  where not t.is_paper and t.thesis_id is not null
), agg as (
  select o.thesis_id,
         min(o.steward) as steward,
         min(o.unit) as unit,
         count(*)::integer as trades,
         count(o.realized_pnl)::integer as priced_trades,
         count(*) filter (where o.realized_pnl > 0::numeric)::integer as wins,
         sum(o.realized_pnl) as realized_pnl,
         avg(o.confidence_at_entry) as avg_confidence_at_entry
  from o
  group by o.thesis_id
), ev as (
  -- Pooled as in private.thesis_edge_evidence (0.5 x n x survivor factor). The weight actually applied
  -- depends on live trades, so it is read from the re-score's results_basis below.
  select e.thesis_id,
         min(e.recorded_by) as steward,
         count(*)::integer as backtest_tests,
         sum(e.n_trades)::integer as backtest_trades,
         round(sum(e.n_trades * (case when e.survivors_only then 1 - coalesce(e.missing_share, 0.5) else 1 end) * e.mean_ret)
               / nullif(sum(e.n_trades * (case when e.survivors_only then 1 - coalesce(e.missing_share, 0.5) else 1 end)), 0), 6) as backtest_mean_ret,
         round(sum(e.n_trades * (case when e.survivors_only then 1 - coalesce(e.missing_share, 0.5) else 1 end) * e.mean_ret_deflated)
               / nullif(sum(e.n_trades * (case when e.survivors_only then 1 - coalesce(e.missing_share, 0.5) else 1 end)), 0), 6) as backtest_mean_deflated
  from public.v_thesis_backtest_evidence e
  where e.counted
  group by e.thesis_id
), ids as (
  select agg.thesis_id from agg union select ev.thesis_id from ev
), s as (
  select i.thesis_id,
         coalesce(a.steward, ev.steward) as steward,
         a.unit,
         coalesce(a.trades, 0) as trades,
         coalesce(a.priced_trades, 0) as priced_trades,
         coalesce(a.wins, 0) as wins,
         a.realized_pnl,
         a.avg_confidence_at_entry,
         th.name, th.status,
         coalesce(th.stated_confidence, th.confidence)::numeric as stated,
         round(100.0 * a.wins::numeric / nullif(a.priced_trades, 0)::numeric, 1) as implied,
         th.results_confidence::numeric as results,
         ev.backtest_tests, ev.backtest_trades, (th.results_basis ->> 'backtest_weight')::numeric as backtest_weight,
         ev.backtest_mean_ret, ev.backtest_mean_deflated
  from ids i
  left join agg a on a.thesis_id = i.thesis_id
  left join ev on ev.thesis_id = i.thesis_id
  left join public.theses th on th.id = i.thesis_id
)
select s.thesis_id,
       s.name,
       s.status,
       s.steward,
       s.unit,
       s.stated as stated_confidence,
       s.avg_confidence_at_entry,
       s.trades,
       s.priced_trades,
       s.wins,
       s.realized_pnl,
       s.implied as outcome_implied_confidence,
       s.stated - s.implied as confidence_gap,
       coalesce(abs(s.stated - s.implied) > 15::numeric, false) as miscalibrated,
       s.priced_trades < 10 as thin,
       s.results as results_confidence,
       coalesce(s.backtest_tests, 0) as backtest_tests,
       coalesce(s.backtest_trades, 0) as backtest_trades,
       coalesce(s.backtest_weight, 0) as backtest_weight,
       s.backtest_mean_ret,
       s.backtest_mean_deflated,
       case when s.backtest_mean_deflated > 0 then 'for' when s.backtest_mean_deflated < 0 then 'against' end as backtest_effect
from s;


-- ---------------------------------------------------------------- evidence rows
-- Test 31 (cycle 52, trial 17): re-derive under the new rule (weight, deflated-Sharpe mean, verification).
update public.thesis_backtest_evidence set recorded_at = recorded_at
where strategy_test_id = 31 and thesis_id = 'earnings_gap_structure';

-- Test 30 (cycle 50, trial 16): quality drawdown into print, DJIA 2022-01-03 universe, walk-forward 2022-2024,
-- 10 bps costs, preregistered 2026-09-27 16:10:16 UTC (research cycle) before results at 16:13:39 UTC. Killed.
-- Numbers from the stored test row: 13 trades, hit 53.8% (7 of 13), mean +1.78%, sd 9.64%, deflated Sharpe
-- -0.329 at 16 trials. Missing data: 38 of 336 universe events dropped (WBA no bars 12, DOW/TRV no
-- financials 24, 2 revenue unavailable) = 0.1131, logged as survivors-only (WBA went private).
insert into public.thesis_backtest_evidence
  (thesis_id, strategy_test_id, n_trades, mean_ret, sd_ret, hit_rate, out_of_sample, costs_included,
   window_start, window_end, rules_locked_at, results_at, trials, survivors_only, missing_share,
   method, notes, recorded_by, active)
select 'earnings_gap_structure', t.id, 13, 0.0178, 0.0964, 0.538462, true, true,
       t.window_start, t.window_end, rc.preregistered_at, t.tested_at, 16, true, 0.1131,
       'Preregistered trial 16 (cycle 50): quality drawdown into print. DJIA constituents as of 2022-01-03 minus design names; buy the close before a dated am/pm print when the close is <= 70% of the 252-session high and trailing revenue is rising; exit the 5th session close or a close below the 252-session low; 10 bps round-trip costs; 2022-01-01 to 2024-12-31.',
       'Killed: 13 trades, hit 53.8%, mean +1.78%, sd 9.64%, deflated Sharpe -0.33 at 16 trials (the positive raw mean does not clear what the best of 16 tries shows by luck). Survivors only: 38 of 336 universe events dropped for missing data (11.3%).',
       'quantanamo', true
from public.strategy_tests t
join public.research_cycles rc on rc.id = t.cycle_id
where t.id = 30 and t.status = 'killed' and rc.thesis_id = 'earnings_gap_structure'
  and not exists (select 1 from public.thesis_backtest_evidence b where b.strategy_test_id = 30);

-- The re-score job (never a hand-written score).
select private.rescore_all_thesis_confidence();

-- ---------------------------------------------------------------- registry
insert into public.desk_rules (rule_id, title, purpose, mechanism, owner_paths, status, verdict, ruling_summary, growth_cost, ruin_risk_reduction, statistics_note, gaming_analysis, interactions, needs_david, ruling_file, ruling_date, next_review_date) values
  ('edge-max-stake', 'Edge-scaled max stake (proven-edge growth)', 'Stops an unbounded requested size (the $200 Miami bet on a $490 book) while letting a proven edge compound.', '`private.edge_max_stake`: unproven (n < 10 or LCB <= 0) gets the starter; proven gets max(starter, min(book x 0.5 x LCB / sd^2, starter x 2^(1 + (n - 10) / 5))). LCB = mean - sd/sqrt(n) of return on stake. `sized_notional = min(requested, max_stake, cash)`.', array['supabase/schemas/22_edge_scaled_stake.sql', 'supabase/schemas/23_edge_stake_reason.sql', 'supabase/schemas/37_court_rulings.sql', 'supabase/schemas/38_edge_max_stake_null_thesis.sql', 'supabase/schemas/47_backtest_credit_live_gated.sql']::text[], 'in_force', 'amend', 'Uphold the proven-edge formula at 1 sigma. Amend so n and the moments include discounted backtest evidence (backtest-evidence-credit) and so the cap is multiplied by the steward drawdown scale instead of per-thesis loss halving. Amendment: n_eff = n_live + backtest weight (backtest-evidence-credit: none below 3 live trades, then min(sum 0.5 x n_backtest, 5, n_live / 2) x survivor factor), with the backtest mean = deflated Sharpe x spread; the spread is the live spread (migration 47). The cap is multiplied by the scale from `private.steward_drawdown`. The starter is a share of current book.', 'None vs current; raises growth (loss halving removed).', 'Bounds every entry; half-Kelly on LCB.', 'The 1-sigma LCB with continuous monitoring falsely marks a zero-edge thesis proven in 47-69% of MC paths within a year. A 2-sigma bound cuts that to 9-23%, but it delays real proof (QUANTANAMO at Sharpe 0.2: 14 -> 38 trades) and cuts BANDIT''s median growth at Sharpe 0.2 from 28.4x to 9.8x. With drawdown scaling as the backstop, false proofs cost little: P(DD50) at zero edge is 9.3% at 1 sigma vs 4.7% at 2 sigma.', 'A steward could inflate `requested` to get more size. That no longer helps: the cap binds, and the multiplier that rewarded inflation is struck (see confidence-multiplier). Only closed, priced, non-paper trades count, so the n gate can''t be padded with paper trades.', 'starter-stake, drawdown-scaling, backtest-evidence-credit, confidence-multiplier, entry-cap-snapshot.', false, 'docs/rules/edge-max-stake.md', '2026-09-26'::date, '2026-10-26'::date),
  ('outcome-rescore-confidence', 'Results re-score of thesis confidence (expected return per trade)', 'Tempers a steward''s stated confidence with realized outcomes. Feeds the QUANTANAMO >= 80 gate and hardening/forming status.', '`private.thesis_results_score`: scored only with >= 3 live trades (else null, unscored). n_eff = live trades + the backtest weight (backtest-evidence-credit: verified tests, pass or fail, none below 3 live trades, then min(sum 0.5 x n, 5, live / 2) x survivor factor); mean_eff pools the live mean return on stake with the backtest deflated Sharpe x spread; sd_eff = max(live sd, 0.25); results_confidence = round(100 x Phi(mean_eff / (sd_eff / sqrt(n_eff)))). Demote hardening -> forming only when the live upper bound mean + max(sd, 0.25)/sqrt(n) < 0, or n >= 10 with mean < 0; kill only when n >= 10 and the upper bound < 0 (live only). theses.confidence (display) = results_confidence when scored, else the stated number. Only the re-score writes the results columns (guard trigger). Was: Beta on hit rate, cap 60 and demote at n >= 5 with negative P/L.', array['supabase/schemas/11_outcome_rescore_sizing.sql', 'supabase/schemas/41_court_decisions.sql', 'supabase/schemas/47_backtest_credit_live_gated.sql']::text[], 'in_force', 'amend', 'Amend (shipped in migration 41; decided 2026-09-26 by the parent agent under David''s delegation). Status changes on the 2026-09-26 re-run: none (no thesis has a negative upper bound or n >= 10). Amendment: Score on expected return per trade (above). Stated confidence is display only.', 'Removes the permanent block on asymmetric theses.', 'Demotion/kill now needs real evidence of negative edge.', 'Five trades can''t tell a Sharpe-0.1 thesis from zero: P(sum < 0) = Phi(-0.1 sqrt 5) = 41%. A hit-rate Beta prior ignores payoff asymmetry.', 'Pushes a steward toward high-hit-rate, low-payoff trades (take profits early, let losers run) just to keep confidence high: the opposite of what compounds.', 'quantanamo-80-gate, edge-max-stake, backtest-evidence-credit.', false, 'docs/rules/outcome-rescore-confidence.md', '2026-09-26'::date, '2026-10-26'::date),
  ('quantanamo-80-gate', 'QUANTANAMO autonomous-entry gate: hardening thesis with results score >= 80', 'David approves anything below 80; autonomy only for strong theses.', '`steward_sizing_guidance`: QUANTANAMO entry_allowed needs status = hardening and theses.results_confidence >= 80 (reason `quantanamo_unscored` when unscored, else `quantanamo_confidence_gate`). Backtests alone can never open it: a thesis is unscored until it has 3 live trades, and backtest credit is then at most min(5, live / 2) effective trades (migration 47, backtest-evidence-credit).', array['supabase/schemas/22_edge_scaled_stake.sql', 'supabase/schemas/41_court_decisions.sql', 'docs/scheduled-run-prompt.md']::text[], 'in_force', 'amend', 'Amend (shipped in migration 41; decided 2026-09-26 by the parent agent under David''s delegation): the 80 threshold stays, but it reads the results score only. On 2026-09-26 no thesis passes: neocloud_compute (1 trade) and semis_photonics (0) are unscored, earnings_gap_structure scores 56; every QUANTANAMO entry needs David until a thesis earns >= 80 or gets qualifying backtest credit. Amendment: Gate on results_confidence >= 80; unscored (< 3 live trades) fails and asks David; stated confidence is display only.', 'Autonomy now waits for evidence (David approves meanwhile).', 'Closes the self-stated-85 path to autonomy.', 'Before 41, at n = 0 the gate read the steward''s self-stated number (80 was a claim, not a measurement). Now 80 means P(expected return per trade > 0) >= 0.8 on at least 3 effective trades (z >= 0.84, close to the 1-sigma LCB > 0 that proves an edge for sizing).', 'Before 41 a steward could state 85 on a brand-new thesis and pass, and couldn''t earn 80 with an asymmetric winner. Now stated numbers can''t open the gate, the results columns are write-protected (only the re-score writes them), and an asymmetric winner earns its score from expectancy.', 'outcome-rescore-confidence, new-thesis-escape, backtest-evidence-credit.', false, 'docs/rules/quantanamo-80-gate.md', '2026-09-26'::date, '2026-10-26'::date),
  ('backtest-evidence-credit', 'Out-of-sample backtest evidence counts both ways, as a small correction to live results', 'Lets real out-of-sample evidence move a thesis''s score and proof a little either way, pass or fail, without letting backtests stand in for live trades or rewarding a steward for logging only winners.', '`public.thesis_backtest_evidence`, append-only for stewards, one row per (thesis, test). A trigger copies from the linked `strategy_tests` row and its research cycle: rules_locked_at (preregistered_at), results_at (tested_at), deflated_sharpe, test_status, thesis_trials (non-placeholder tests the thesis had run by then), and sets verified / ineligible_reason. A row is verified when its test is survived or killed (placeholder, lookahead_invalid, queued and unverified earn nothing), has a price source and a date window, rules_locked_at < results_at, a stored deflated Sharpe, trials >= thesis_trials, out_of_sample and costs_included. A change to the test row re-derives it. A test whose params mark point-in-time data unverified (any `*point_in_time` key not ''true'', e.g. test 32''s estimate_point_in_time = unverified), or that is a filtered subset of another test on the same thesis (`parent_test_id`, e.g. test 32 of test 31), gets no row at all: the insert is refused. `private.thesis_edge_evidence(thesis, n_live)` gives no credit below 3 live trades; otherwise weight = min(sum 0.5 x n, 5, n_live / 2) x the pooled survivor factor (1 - missing_share for a survivors-only test, 0.5 if unknown) and credited mean = deflated Sharpe x spread, pooled by 0.5 x n x factor, pass or fail. `private.edge_max_stake` and `private.thesis_results_score` add it to the live trades with no further shrink; the spread stays the live spread. `v_thesis_backtest_evidence` lists every row (verified, why not, for/against); `v_backtest_tests_unlogged` lists completed thesis tests (thesis named in the test params) with no row, leaving out the point-in-time-unverified and subset tests; `v_thesis_scorecard` shows the weight the re-score applied.', array['supabase/schemas/37_court_rulings.sql', 'supabase/schemas/46_backtest_evidence_symmetric.sql', 'supabase/schemas/47_backtest_credit_live_gated.sql']::text[], 'in_force', 'amend', 'Amend (2026-09-27, migration 47, following 46): pass or fail still counts, but backtest credit is live-gated and small. No credit or score below 3 live trades; weight min(5, live / 2) x (1 - missing share) for survivors-only; credited mean = deflated Sharpe x spread; unverified tests earn nothing. 47 re-derives test 31, logs test 30, leaves test 32 out (point-in-time unverified, and a subset of test 31), and re-scores: earnings_gap_structure 52 -> 54 (56 before 46); no other score moves. Was (46): up to 20 effective trades from before the first live trade, emax-deflated mean shrunk 50%; (37): survivors only. Amendment: thesis_backtest_evidence gains test_status, thesis_trials, verified, ineligible_reason (trigger-derived); weight = min(0.5 x n, 5) x survivor factor; mean_ret_deflated = deflated Sharpe x sd. private.thesis_edge_evidence(text) is replaced by (text, integer) with the live gate and cap; edge_max_stake and thesis_results_score drop the 50% shrink and use the live spread; the score needs >= 3 live trades. A strategy_tests update (including params_json) re-derives its evidence. Point-in-time-unverified tests and filtered subsets of another test on the same thesis get no row (the insert is refused; v_backtest_tests_unlogged leaves them out). v_thesis_backtest_evidence stops reading strategy_tests; 46''s strategy_tests read grant to oddsborne_worker / bandit_worker stays (v_backtest_tests_unlogged still reads strategy_tests as the invoker).', 'Close to none: QUANTANAMO Sharpe-0.2 P(2x) 53.7% vs 55.0% with no backtests (46: 48.5%); with a real live edge and a no-edge backtest, 51.2% vs 46''s 41.5%.', 'Neutral: ruin 0 in every cell; gives back part of 46''s cut in zero-edge false proofs (QUANTANAMO 29.6% -> 41.2%, no backtests 47.5%) in exchange for not letting backtests outweigh live trades.', 'Every completed, preregistered test counts whichever way it came out, so logging only winners buys nothing. The credited mean is the deflated Sharpe times the spread: the mean left after subtracting what the best of the thesis''s N tries would show by luck (test 31: -0.1228 x 6.20% = -0.76% per trade, vs its raw -0.35%). Deflation already corrects selection, so there''s no extra 50% shrink, and it treats a pass and a fail the same way. The weight is capped because a backtest of a mechanical rule isn''t the thesis as traded (test 31 skips the discretionary selection the live book does), survivors-only samples are biased, and correlated same-night events overstate n: 714 trades count as at most 5 effective trades, and never more than half the live count. The backtest spread (6.2%) never narrows the live spread (floored at 0.25). Subsets aren''t new evidence: test 32 re-used test 31''s 714 events filtered to 249 serial EPS beaters, so logging it would count those 249 trades twice and would let a steward pile up weight by slicing one sample. A test with a parent_test_id on the same thesis counts as a trial (it raises the thesis''s trial count, which deflates later tests), never as another row. Overlap that isn''t declared (a DJIA name can sit in both test 30 and test 31, under different exit rules) is bounded by the pooled cap of 5. Found in passing: the results score with 3-9 live trades opens the 80 gate at some point on 31% of zero-edge QUANTANAMO paths with no backtests at all (earnings_gap_structure itself scored 92 after 3 trades). Backtest credit isn''t the fix for that (46''s big weight cut it to 3% by letting backtests outweigh live trades). It''s flagged for David''s review of the quantanamo-80-gate and not changed here.', 'Can''t be gamed for more than a nudge. With a fake +0.2 Sharpe backtest on a zero-edge thesis, false proofs are 47.7% vs 47.5% with no backtest (QUANTANAMO) and 62.3% vs 61.3% (BANDIT), and the 80 gate opens less often, not more (26.6% vs 31.2%), because every test is deflated by the thesis''s trial count. Backtests alone can''t score a thesis or open the gate: no credit and no score below 3 live trades. Lock time, results time, deflated Sharpe, test status and the thesis''s trial count come from the test record, not the steward. Under-counting trials, skipping preregistration, a missing source or window, or a voided test (lookahead_invalid, placeholder) all make a row unverified and worth zero. A disputed point-in-time input gets no row at all (test 32''s EPS estimates have no as-of timestamp), and slicing one sample into filtered subsets buys nothing (a parent_test_id on the same thesis is refused). Logging many tests doesn''t add up: the pooled weight is capped at 5. Rows are append-only for stewards, and `v_backtest_tests_unlogged` shows any completed thesis test that should have been logged and wasn''t.', 'edge-max-stake, outcome-rescore-confidence, quantanamo-80-gate.', false, 'docs/rules/backtest-evidence-credit.md', '2026-09-27'::date, '2026-11-27'::date)
on conflict (rule_id) do update set title = excluded.title, purpose = excluded.purpose, mechanism = excluded.mechanism, owner_paths = excluded.owner_paths, status = excluded.status, verdict = excluded.verdict, ruling_summary = excluded.ruling_summary, growth_cost = excluded.growth_cost, ruin_risk_reduction = excluded.ruin_risk_reduction, statistics_note = excluded.statistics_note, gaming_analysis = excluded.gaming_analysis, interactions = excluded.interactions, needs_david = excluded.needs_david, ruling_file = excluded.ruling_file, ruling_date = excluded.ruling_date, next_review_date = excluded.next_review_date, updated_at = now();
