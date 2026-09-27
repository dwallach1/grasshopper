-- Court ruling 2026-09-27: backtest evidence counts both ways (docs/rules/backtest-evidence-credit.md).
-- court-ruling: docs/rules/backtest-evidence-credit.md
-- court-ruling: docs/rules/outcome-rescore-confidence.md
--
-- Before: only a surviving test (deflated Sharpe > 0) could be logged, one active row per thesis, and
-- workers could update or deactivate rows. That only ever added credit: run many tests, log the winner.
-- Now:
-- 1. Every completed (survived or killed), preregistered, out-of-sample, cost-inclusive test is evidence,
--    pass or fail, and all of a thesis's rows pool. Each row keeps the existing weight
--    min(0.5 x n, 20) and the callers' 50% mean shrinkage, so a negative mean pulls the score down
--    exactly as hard as the same positive mean would push it up. The pooled backtest weight is capped at 20.
-- 2. A row needs rules_locked_at < results_at (rules frozen before any result was seen) and a trial
--    count. Its mean is deflated by trials: mean - E[max of N standard normals] x sd / sqrt(n)
--    (the deflated-Sharpe benchmark, N = trials; zero for N = 1).
-- 3. Survivors-only tests (dead names had no data) count at half weight.
-- 4. Rows are append-only for the stewards (no update, no inactive inserts); one row per test.
-- 5. Test 31 (earnings_gap_structure as traded, trial 17) is logged as negative evidence and the thesis
--    is re-scored by the re-score job.

-- ---------------------------------------------------------------- helpers
create or replace function private.normal_quantile(p_p numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- Acklam's rational approximation of the standard normal quantile (relative error < 1.2e-9).
  a double precision[] := array[-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
                                1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  b double precision[] := array[-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
                                6.680131188771972e+01, -1.328068155288572e+01];
  c double precision[] := array[-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
                                -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  d double precision[] := array[7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
                                3.754408661907416e+00];
  p double precision := least(greatest(p_p::double precision, 1e-12), 1 - 1e-12);
  q double precision;
  r double precision;
begin
  if p < 0.02425 then
    q := sqrt(-2 * ln(p));
    return ((((((c[1] * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) * q + c[6]) /
            ((((d[1] * q + d[2]) * q + d[3]) * q + d[4]) * q + 1))::numeric;
  elsif p > 1 - 0.02425 then
    q := sqrt(-2 * ln(1 - p));
    return (-(((((c[1] * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) * q + c[6]) /
             ((((d[1] * q + d[2]) * q + d[3]) * q + d[4]) * q + 1))::numeric;
  end if;
  q := p - 0.5;
  r := q * q;
  return ((((((a[1] * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * r + a[6]) * q /
          (((((b[1] * r + b[2]) * r + b[3]) * r + b[4]) * r + b[5]) * r + 1))::numeric;
end;
$$;

comment on function private.normal_quantile(numeric) is
  'Standard normal quantile (Acklam approximation). Used for the trial deflation of backtest evidence.';

create or replace function private.expected_max_normal(p_trials integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  -- E[max of N iid standard normals] as in the deflated Sharpe ratio (Bailey & Lopez de Prado):
  -- (1 - g) z(1 - 1/N) + g z(1 - 1/(N e)), g = Euler-Mascheroni. Zero for a single trial.
  select case when coalesce(p_trials, 1) <= 1 then 0::numeric else
    round((1 - 0.5772156649) * private.normal_quantile(1 - 1.0 / p_trials)
          + 0.5772156649 * private.normal_quantile(1 - 1.0 / (p_trials * exp(1::numeric))), 6) end;
$$;

comment on function private.expected_max_normal(integer) is
  'Expected maximum of N standard normals (deflated-Sharpe benchmark); 0 for N <= 1. docs/rules/backtest-evidence-credit.md';

-- ---------------------------------------------------------------- table
alter table public.thesis_backtest_evidence add column if not exists rules_locked_at timestamptz;
alter table public.thesis_backtest_evidence add column if not exists results_at timestamptz;
alter table public.thesis_backtest_evidence add column if not exists trials integer;
alter table public.thesis_backtest_evidence add column if not exists survivors_only boolean not null default false;
alter table public.thesis_backtest_evidence add column if not exists missing_share numeric;
alter table public.thesis_backtest_evidence add column if not exists hit_rate numeric;
alter table public.thesis_backtest_evidence add column if not exists deflated_sharpe numeric;
alter table public.thesis_backtest_evidence add column if not exists passed boolean;
alter table public.thesis_backtest_evidence add column if not exists weight numeric;
alter table public.thesis_backtest_evidence add column if not exists trial_deflation numeric;
alter table public.thesis_backtest_evidence add column if not exists mean_ret_deflated numeric;

-- No row predates this migration without the preregistration fields (the table was empty on 2026-09-27).
alter table public.thesis_backtest_evidence alter column rules_locked_at set not null;
alter table public.thesis_backtest_evidence alter column results_at set not null;
alter table public.thesis_backtest_evidence alter column trials set not null;
alter table public.thesis_backtest_evidence drop constraint if exists thesis_backtest_evidence_locked_before_results;
alter table public.thesis_backtest_evidence add constraint thesis_backtest_evidence_locked_before_results
  check (rules_locked_at < results_at);
alter table public.thesis_backtest_evidence drop constraint if exists thesis_backtest_evidence_trials;
alter table public.thesis_backtest_evidence add constraint thesis_backtest_evidence_trials check (trials >= 1);
alter table public.thesis_backtest_evidence drop constraint if exists thesis_backtest_evidence_missing_share;
alter table public.thesis_backtest_evidence add constraint thesis_backtest_evidence_missing_share
  check (missing_share is null or (missing_share >= 0 and missing_share < 1));

-- Every test pools; one row per (thesis, test) so a winner can't be logged twice.
drop index if exists public.thesis_backtest_evidence_one_active;
create unique index if not exists thesis_backtest_evidence_one_per_test
  on public.thesis_backtest_evidence (thesis_id, strategy_test_id);

comment on table public.thesis_backtest_evidence is
  'Backtest evidence per thesis, pass or fail (docs/rules/backtest-evidence-credit.md). A row counts when active, out_of_sample, costs_included, rules_locked_at < results_at, and its strategy_tests row completed (survived or killed). weight = min(0.5 x n, 20), x0.5 when survivors_only; mean_ret_deflated = mean_ret - E[max of trials normals] x sd_ret / sqrt(n). All counted rows pool (weight capped at 20) and the mean is shrunk 50% toward zero by the callers, the same for a negative mean as a positive one. Append-only for stewards.';

create or replace function private.backtest_evidence_derive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
begin
  -- The linked strategy test is the record of when rules were locked and results came in; a steward
  -- can't back-date the lock, move a test onto another thesis, or log a test that hasn't finished.
  -- (The status check is on insert only, so the service role can still deactivate a row whose test is later voided.)
  select st.status, st.tested_at, st.params_json into t from public.strategy_tests st where st.id = new.strategy_test_id;
  if not found then
    raise exception 'backtest evidence needs a strategy_tests row (strategy_test_id %)', new.strategy_test_id;
  end if;
  if tg_op = 'INSERT' and t.status not in ('survived', 'killed') then
    raise exception 'strategy test % is %, not completed', new.strategy_test_id, t.status;
  end if;
  if t.params_json ? 'thesis_id' and t.params_json ->> 'thesis_id' is distinct from new.thesis_id then
    raise exception 'strategy test % belongs to thesis %, not %', new.strategy_test_id, t.params_json ->> 'thesis_id', new.thesis_id;
  end if;
  if t.params_json ? 'preregistered_at' then
    new.rules_locked_at := (t.params_json ->> 'preregistered_at')::timestamptz;
  end if;
  if t.tested_at is not null then
    new.results_at := t.tested_at;
  end if;
  if t.params_json ? 'trial_number' then
    new.trials := greatest(coalesce(new.trials, 1), (t.params_json ->> 'trial_number')::int);
  end if;
  new.weight := round(least(0.5 * new.n_trades, 20) * case when new.survivors_only then 0.5 else 1 end, 4);
  new.trial_deflation := round(private.expected_max_normal(new.trials) * new.sd_ret / sqrt(new.n_trades::numeric), 8);
  new.mean_ret_deflated := round(new.mean_ret - new.trial_deflation, 8);
  return new;
end;
$$;

drop trigger if exists thesis_backtest_evidence_derive on public.thesis_backtest_evidence;
create trigger thesis_backtest_evidence_derive
  before insert or update on public.thesis_backtest_evidence
  for each row execute function private.backtest_evidence_derive();

-- Append-only for the stewards: no updates, and a row can't be logged as inactive (a hidden failure).
revoke update on public.thesis_backtest_evidence from quantanamo_worker, oddsborne_worker, bandit_worker;
drop policy if exists evidence_worker_update on public.thesis_backtest_evidence;
drop policy if exists evidence_worker_insert on public.thesis_backtest_evidence;
create policy evidence_worker_insert on public.thesis_backtest_evidence
  for insert to quantanamo_worker, oddsborne_worker, bandit_worker with check (active);
grant select, insert, update, delete on public.thesis_backtest_evidence to service_role;

-- ---------------------------------------------------------------- rule math
create or replace function private.thesis_edge_evidence(p_thesis_id text)
returns table (n_backtest integer, weight numeric, mean_ret numeric, sd_ret numeric, evidence_id bigint)
language sql
stable
set search_path = ''
as $$
  -- Pools every counted row, pass or fail. mean_ret is the weight-pooled trial-deflated mean; the callers
  -- (edge_max_stake, thesis_results_score) shrink it 50% toward zero, symmetric in sign.
  with r as (
    select b.id, b.n_trades, b.weight, b.mean_ret_deflated, b.sd_ret
    from public.thesis_backtest_evidence b
    join public.strategy_tests t on t.id = b.strategy_test_id
    where b.thesis_id = p_thesis_id and b.active and b.out_of_sample and b.costs_included
      and b.rules_locked_at < b.results_at and b.trials >= 1
      and t.status in ('survived', 'killed')
      and b.weight > 0
  )
  select sum(r.n_trades)::int,
         least(sum(r.weight), 20),
         sum(r.weight * r.mean_ret_deflated) / sum(r.weight),
         sqrt(sum(r.weight * r.sd_ret ^ 2) / sum(r.weight)),
         max(r.id)
  from r
  having count(*) > 0;
$$;

comment on function private.thesis_edge_evidence(text) is
  'Pooled backtest evidence for a thesis (pass or fail): n, weight (sum of min(0.5 x n, 20) x0.5 if survivors-only, capped at 20), weight-pooled trial-deflated mean and sd. docs/rules/backtest-evidence-credit.md';

revoke all on function private.normal_quantile(numeric) from public, anon, authenticated;
revoke all on function private.expected_max_normal(integer) from public, anon, authenticated;
revoke all on function private.backtest_evidence_derive() from public, anon, authenticated;
revoke all on function private.thesis_edge_evidence(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- views
create or replace view public.v_thesis_backtest_evidence
with (security_invoker = true)
as
select b.id, b.thesis_id, b.strategy_test_id, t.status as test_status, b.n_trades, b.hit_rate, b.mean_ret, b.sd_ret,
       b.deflated_sharpe, b.trials, b.survivors_only, b.missing_share, b.weight, b.trial_deflation, b.mean_ret_deflated,
       b.rules_locked_at, b.results_at, b.window_start, b.window_end, b.method, b.recorded_by, b.recorded_at,
       (b.active and b.out_of_sample and b.costs_included and b.rules_locked_at < b.results_at and b.trials >= 1
         and t.status in ('survived', 'killed') and b.weight > 0) as counted,
       case when b.mean_ret_deflated > 0 then 'for' when b.mean_ret_deflated < 0 then 'against' else 'neutral' end as effect
from public.thesis_backtest_evidence b
join public.strategy_tests t on t.id = b.strategy_test_id;

comment on view public.v_thesis_backtest_evidence is
  'Every logged backtest per thesis with its derived weight, trial-deflated mean, whether it counts, and whether it pulls the score up (for) or down (against).';

grant select on public.v_thesis_backtest_evidence
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- The evidence views join strategy_tests (security invoker). Test records are already public on the desk
-- (desk_public_reader reads them); the other stewards get read access so their scorecard reads keep working.
grant select on public.strategy_tests to oddsborne_worker, bandit_worker;
drop policy if exists steward_select on public.strategy_tests;
create policy steward_select on public.strategy_tests for select to oddsborne_worker, bandit_worker using (true);

-- Completed preregistered thesis tests with no evidence row: the ruling says every one gets logged.
create or replace view public.v_backtest_tests_unlogged
with (security_invoker = true)
as
select t.id as strategy_test_id, t.params_json ->> 'thesis_id' as thesis_id, t.status, t.tested_at,
       t.params_json ->> 'preregistered_at' as preregistered_at, t.params_json ->> 'trial_number' as trial_number,
       t.deflated_sharpe
from public.strategy_tests t
where t.status in ('survived', 'killed')
  and t.params_json ? 'thesis_id'
  and t.params_json ? 'preregistered_at'
  and not exists (select 1 from public.thesis_backtest_evidence b where b.strategy_test_id = t.id);

comment on view public.v_backtest_tests_unlogged is
  'Completed, preregistered thesis tests that are not logged as backtest evidence (should be empty: pass or fail, every one is logged).';

grant select on public.v_backtest_tests_unlogged
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- Scorecard: theses with live trades or logged backtests; backtest columns appended.
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
  select e.thesis_id,
         min(e.recorded_by) as steward,
         count(*)::integer as backtest_tests,
         sum(e.n_trades)::integer as backtest_trades,
         least(sum(e.weight), 20) as backtest_weight,
         round(sum(e.weight * e.mean_ret) / nullif(sum(e.weight), 0), 6) as backtest_mean_ret,
         round(sum(e.weight * e.mean_ret_deflated) / nullif(sum(e.weight), 0), 6) as backtest_mean_deflated
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
         ev.backtest_tests, ev.backtest_trades, ev.backtest_weight, ev.backtest_mean_ret, ev.backtest_mean_deflated
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

comment on function private.thesis_results_score(text) is
  'Results score for a thesis: n_eff = live trades + pooled backtest weight (every logged test, pass or fail; see private.thesis_edge_evidence); mean_eff pools the live mean with the trial-deflated backtest mean shrunk 50% toward zero, either sign; sd_eff = max(pooled sd, 0.25); score = round(100 x Phi(mean_eff / (sd_eff / sqrt(n_eff)))) when n_eff >= 3, else null (unscored). demote: live UCB < 0 or (n >= 10 and mean < 0); kill: n >= 10 and UCB < 0.';

-- ---------------------------------------------------------------- test 31
-- Cycle 52, trial 17 (run 243): earnings_gap_structure as traded, 2022-2024, 30 bps costs. Killed. The rules
-- lock time and results time come from the strategy_tests row via the derive trigger.
insert into public.thesis_backtest_evidence
  (thesis_id, strategy_test_id, n_trades, mean_ret, sd_ret, hit_rate, out_of_sample, costs_included,
   window_start, window_end, rules_locked_at, results_at, trials, survivors_only, missing_share,
   deflated_sharpe, passed, method, notes, recorded_by, active)
select 'earnings_gap_structure', t.id, 714, -0.003457, 0.062007, 0.490196, true, true,
       date '2022-01-01', date '2024-12-31',
       (t.params_json ->> 'preregistered_at')::timestamptz, t.tested_at, 17, true, 0.3456,
       -0.122844, false,
       'Preregistered trial 17 (cycle 52, run 243): buy the regular close before the print, sell the day-0 open; price $9.82-$320, 20-day dollar volume $0.5M-$1.3B; 30 bps round-trip costs; 2022-01-01 to 2024-12-31, out of sample to the rules. Net per trade on stake.',
       'Killed: 714 trades, hit 49.0%, mean -0.35%, sd 6.2%, deflated Sharpe -0.12 (60 bps costs: -0.17). Survivors only: 35% of events had no bars. A hypothetical -50% on the missing events gives deflated Sharpe -0.77; that stress is not used here. Artifacts 88-94, scenarios 153-156, lesson 79.',
       'quantanamo', true
from public.strategy_tests t
where t.id = 31
  and t.params_json ? 'preregistered_at'
  and not exists (select 1 from public.thesis_backtest_evidence b where b.strategy_test_id = 31
                  and b.thesis_id = 'earnings_gap_structure');

-- The re-score job (the insert trigger re-scored the thesis already; this is idempotent).
select private.rescore_all_thesis_confidence();

-- ---------------------------------------------------------------- registry
insert into public.desk_rules (rule_id, title, purpose, mechanism, owner_paths, status, verdict, ruling_summary, growth_cost, ruin_risk_reduction, statistics_note, gaming_analysis, interactions, needs_david, ruling_file, ruling_date, next_review_date) values
  ('outcome-rescore-confidence', 'Results re-score of thesis confidence (expected return per trade)', 'Tempers a steward''s stated confidence with realized outcomes. Feeds the QUANTANAMO >= 80 gate and hardening/forming status.', '`private.thesis_results_score`: n_eff = live trades + the pooled backtest weight (every logged test, pass or fail: min(0.5 x n, 20) each, x0.5 survivors-only, capped at 20; see backtest-evidence-credit); mean_eff pools the live mean return on stake with the trial-deflated backtest mean shrunk 50% toward zero, either sign; sd_eff = max(pooled sd, 0.25); results_confidence = round(100 x Phi(mean_eff / (sd_eff / sqrt(n_eff)))) when n_eff >= 3, else null (unscored). Demote hardening -> forming only when the live upper bound mean + max(sd, 0.25)/sqrt(n) < 0, or n >= 10 with mean < 0; kill only when n >= 10 and the upper bound < 0. theses.confidence (display) = results_confidence when scored, else the stated number. Only the re-score writes the results columns (guard trigger). Was: Beta on hit rate, cap 60 and demote at n >= 5 with negative P/L.', array['supabase/schemas/11_outcome_rescore_sizing.sql', 'supabase/schemas/41_court_decisions.sql']::text[], 'in_force', 'amend', 'Amend (shipped in migration 41; decided 2026-09-26 by the parent agent under David''s delegation). Status changes on the 2026-09-26 re-run: none (no thesis has a negative upper bound or n >= 10). Amendment: Score on expected return per trade (above). Stated confidence is display only.', 'Removes the permanent block on asymmetric theses.', 'Demotion/kill now needs real evidence of negative edge.', 'Five trades can''t tell a Sharpe-0.1 thesis from zero: P(sum < 0) = Phi(-0.1 sqrt 5) = 41%. A hit-rate Beta prior ignores payoff asymmetry.', 'Pushes a steward toward high-hit-rate, low-payoff trades (take profits early, let losers run) just to keep confidence high: the opposite of what compounds.', 'quantanamo-80-gate, edge-max-stake, backtest-evidence-credit.', false, 'docs/rules/outcome-rescore-confidence.md', '2026-09-26'::date, '2026-10-26'::date),
  ('backtest-evidence-credit', 'Out-of-sample backtest evidence counts both ways (pass or fail)', 'Lets real out-of-sample evidence speed up (or slow down) proof of an edge, without rewarding a steward for running many tests and logging only the winners.', '`public.thesis_backtest_evidence`, append-only for stewards (no update; no inactive insert; one row per thesis and test). A row counts when it is out_of_sample, costs_included, rules_locked_at < results_at, has a trial count, and its `strategy_tests` row completed (survived or killed): pass or fail. Per row: weight = min(0.5 x n, 20), x0.5 when survivors_only; mean_ret_deflated = mean_ret - E[max of `trials` standard normals] x sd / sqrt(n) (the deflated-Sharpe benchmark; 0 for one trial). `private.thesis_edge_evidence` pools every counted row (weight capped at 20, weight-pooled deflated mean and sd); `private.edge_max_stake` and `private.thesis_results_score` add that weight to the live trades and shrink its mean 50% toward zero, the same for a negative mean as a positive one. `public.v_thesis_backtest_evidence` lists every row (weight, deflated mean, counted, for/against); `public.v_backtest_tests_unlogged` lists completed preregistered thesis tests with no row; `v_thesis_scorecard` carries the pooled backtest columns.', array['supabase/schemas/37_court_rulings.sql', 'supabase/schemas/38_edge_max_stake_null_thesis.sql', 'supabase/schemas/41_court_decisions.sql', 'supabase/schemas/46_backtest_evidence_symmetric.sql']::text[], 'in_force', 'amend', 'Amend (2026-09-27): every completed, preregistered, out-of-sample, cost-inclusive test is logged and counts, pass or fail, with the same weighting either way; rules must be locked before results; means are deflated by trials; survivors-only tests count at half weight; rows are append-only for stewards. Enacted in migration 46, which logs test 31 against earnings_gap_structure and re-scores it (56 -> 52). Was (migration 37): one active row per thesis, only a surviving test with deflated Sharpe > 0. Amendment: thesis_backtest_evidence gains rules_locked_at, results_at (check rules_locked_at < results_at), trials (>= 1), survivors_only, missing_share, hit_rate, deflated_sharpe, passed and trigger-derived weight, trial_deflation, mean_ret_deflated; the one-active index becomes one row per (thesis, test); stewards lose update and can''t insert inactive rows. private.thesis_edge_evidence pools all counted rows (weight capped at 20) with no pass requirement.', 'Positive but bounded: a real Sharpe-0.2 edge is proven 4-7 trades later than with honest credit-only (P(2x) QUANTANAMO 39.5% -> 35.0%), mostly from trial deflation of every pooled test.', 'False proofs of a zero-edge thesis within a year 43% -> 27% (QUANTANAMO) and 63% -> 50% (BANDIT); no path opens the 80 gate from backtests alone.', 'Logging only survivors is selection on the outcome: the logged mean is biased up by about E[max of M] standard errors (1.19 SE for M = 5, 1.83 SE for 17 trials). Counting failures removes the selection; deflating by trials removes what remains of it for tests chosen from many variants. Weight min(0.5 x n, 20) and the 50% shrink are unchanged and apply to either sign, so a negative mean moves the score exactly as much as the same positive mean (earnings_gap_structure: 52 with test 31 as logged vs 55 with the sign flipped, around 54 for a zero-mean test). Survivors-only tests count at half weight because the missing names are not missing at random (test 31: 35% of events had no bars; booking them at -50% gives deflated Sharpe -0.77), but the sign is kept. The 0.25 sd floor in the results score (outcome-rescore-confidence) still caps how much any backtest can move a score: 714 trades at sd 6.2% count like 10 live trades at sd 25%.', 'The old rule only added credit: run many tests, log the winner, and a failure costs nothing. Now a completed preregistered test is evidence either way, rows are append-only for stewards (no update, no inactive insert, one row per test), and `v_backtest_tests_unlogged` shows any completed preregistered thesis test without a row. The rules-lock time, results time and trial count are copied from the linked `strategy_tests` row by the insert trigger (preregistered_at, tested_at, trial_number), so a steward can''t back-date a lock; a test can only be logged against its own thesis and only once it has finished. Remaining lever: a steward can skip preregistration (then the test doesn''t count either way, and the steward loses the credit too). Deflation by trials means an honest steward who logs a long search is not rewarded for its best trial.', 'edge-max-stake, outcome-rescore-confidence, quantanamo-80-gate.', false, 'docs/rules/backtest-evidence-credit.md', '2026-09-27'::date, '2026-11-27'::date)
on conflict (rule_id) do update set title = excluded.title, purpose = excluded.purpose, mechanism = excluded.mechanism, owner_paths = excluded.owner_paths, status = excluded.status, verdict = excluded.verdict, ruling_summary = excluded.ruling_summary, growth_cost = excluded.growth_cost, ruin_risk_reduction = excluded.ruin_risk_reduction, statistics_note = excluded.statistics_note, gaming_analysis = excluded.gaming_analysis, interactions = excluded.interactions, needs_david = excluded.needs_david, ruling_file = excluded.ruling_file, ruling_date = excluded.ruling_date, next_review_date = excluded.next_review_date, updated_at = now();
