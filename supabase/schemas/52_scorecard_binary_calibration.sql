-- Desk scorecard: price-aware calibration for prediction-market binaries.
--
-- Measurement only. v_thesis_scorecard feeds no sizing, gate or order path: sizing and the QUANTANAMO 80
-- gate read theses.results_confidence (private.thesis_results_score / private.edge_max_stake), which this
-- migration does not touch. Not a trading rule, so no court ruling.
--
-- The bug: the scorecard compared a thesis's stated confidence (0-100) with its realized hit rate and
-- flagged |stated - hit rate| > 15 as miscalibrated, on any sample size. Stated confidence is the
-- steward's confidence that the edge is real, not a per-trade win rate. For a binary bought at long odds
-- that yardstick is wrong: ODDSBORNE's sports_devig_maker_edge bought YES at 14.6c and 15.8c (its --p fair
-- values 0.1658 and 0.1818), so even with a real edge it expects to lose ~83% of the time, and 0 for 2 has
-- a 68% chance (0.8182 x 0.8342). It was flagged miscalibrated at stated 38 vs hit rate 0 on 2 trades.
--
-- The fix, for theses whose priced trades are all prediction-market binaries:
-- 1. trade_outcomes gains price_at_entry (average price paid per contract, 0-1) and probability_at_entry
--    (the steward's --p fair value on the entry order, pm_orders.my_probability), derived by trigger from
--    pm_fills / pm_positions / pm_orders and backfilled here. A trade's expected win probability is its
--    fair value when recorded, else its entry price.
-- 2. expected_wins = sum of those probabilities; expected_win_rate = 100 x expected_wins / trades.
--    confidence_gap = expected_win_rate - realized hit rate (positive = won less often than the entry odds
--    said). outcome_implied_confidence stays the realized hit rate.
-- 3. calibration_p = exact two-sided Poisson-binomial p-value of the realized wins given each trade's
--    expected probability (public.poisson_binomial_two_sided_p). miscalibrated only with >= 10 trades that
--    carry a probability (the scorecard's thin threshold, so a thin binary thesis is never flagged) and
--    calibration_p < 0.05.
-- Equity, meme and mixed theses keep the old rule (stated - hit rate, |gap| > 15): there is no entry-implied
-- win probability to replace it with. calibration_basis says which yardstick a row uses.
-- A trade closed before resolution counts as a win when realized_pnl > 0, as before; its expected
-- probability is still the probability of resolving in its favour at entry (an approximation).

-- ---------------------------------------------------------------- per-trade entry odds
alter table public.trade_outcomes add column if not exists price_at_entry numeric;
alter table public.trade_outcomes add column if not exists probability_at_entry numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'trade_outcomes_price_at_entry_check') then
    alter table public.trade_outcomes add constraint trade_outcomes_price_at_entry_check
      check (price_at_entry is null or (price_at_entry >= 0 and price_at_entry <= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'trade_outcomes_probability_at_entry_check') then
    alter table public.trade_outcomes add constraint trade_outcomes_probability_at_entry_check
      check (probability_at_entry is null or (probability_at_entry >= 0 and probability_at_entry <= 1));
  end if;
end;
$$;

comment on column public.trade_outcomes.price_at_entry is
  'Prediction-market binaries only: average price paid per contract (0-1) for the outcome held. Derived by trigger: buy-fill VWAP on the position, else pm_positions.average_cost, else the filled buy orders'' size-weighted price.';
comment on column public.trade_outcomes.probability_at_entry is
  'Prediction-market binaries only: the steward''s fair probability (pm_enter --p, pm_orders.my_probability) for the outcome held, size-weighted over the buy orders behind the position. Null when none was recorded.';

create or replace function private.binary_entry_odds(p_position_id uuid)
returns table (price numeric, probability numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with pos as (
    select p.id, p.market_id, lower(p.outcome) as outcome, p.thesis_id, p.average_cost, p.closed_at
    from public.pm_positions p
    where p.id = p_position_id
  ), bf as (
    -- Buy fills on this position.
    select f.order_id, f.quantity as q, f.price as px
    from public.pm_fills f
    join pos on f.position_id = pos.id
    where f.side = 'buy' and f.quantity > 0 and f.price > 0 and f.price < 1
  ), bo as (
    -- Live buy orders behind the position: the ones its fills point at, else filled buys on the same
    -- market and outcome (same thesis or untagged) placed before it closed.
    select o.size, o.price, o.my_probability,
           exists (select 1 from bf where bf.order_id = o.id) as linked
    from public.pm_orders o
    join pos on o.market_id = pos.market_id and lower(o.outcome) = pos.outcome
    where o.side = 'buy' and o.mode = 'live'
      and (exists (select 1 from bf where bf.order_id = o.id)
           or (o.status in ('filled', 'partial')
               and (o.thesis_id is null or pos.thesis_id is null or o.thesis_id = pos.thesis_id)
               and (pos.closed_at is null or o.created_at <= pos.closed_at)))
  )
  select
    round(coalesce(
      (select sum(bf.q * bf.px) / nullif(sum(bf.q), 0) from bf),
      (select pos.average_cost from pos where pos.average_cost > 0 and pos.average_cost < 1),
      (select sum(bo.size * bo.price) / nullif(sum(bo.size), 0) from bo where bo.price > 0 and bo.price < 1)
    ), 6),
    round(coalesce(
      (select sum(bo.size * bo.my_probability) / nullif(sum(bo.size), 0) from bo
        where bo.linked and bo.my_probability is not null),
      (select sum(bo.size * bo.my_probability) / nullif(sum(bo.size), 0) from bo
        where bo.my_probability is not null)
    ), 6)
  from pos;
$$;

comment on function private.binary_entry_odds(uuid) is
  'Entry price per contract and the steward''s fair probability for a prediction-market position (feeds trade_outcomes.price_at_entry / probability_at_entry for the scorecard''s binary calibration).';

create or replace function private.trade_outcome_entry_odds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  if new.venue = 'prediction' and new.source_table = 'pm_positions'
     and new.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v from private.binary_entry_odds(new.source_id::uuid);
    new.price_at_entry := coalesce(v.price, new.price_at_entry);
    new.probability_at_entry := coalesce(v.probability, new.probability_at_entry);
  end if;
  return new;
end;
$$;

drop trigger if exists trade_outcome_entry_odds on public.trade_outcomes;
create trigger trade_outcome_entry_odds
  before insert or update on public.trade_outcomes
  for each row execute function private.trade_outcome_entry_odds();

revoke all on function private.binary_entry_odds(uuid) from public, anon, authenticated;
revoke all on function private.trade_outcome_entry_odds() from public, anon, authenticated;

-- Backfill. Only the new columns are set, so the re-score trigger (realized_pnl / thesis_id / is_paper) does
-- not fire and no score moves.
update public.trade_outcomes set price_at_entry = price_at_entry
where venue = 'prediction' and source_table = 'pm_positions';

-- ---------------------------------------------------------------- exact binomial-style test
-- Two-sided p-value of k wins out of independent trades with win probabilities p[1..n] (Poisson-binomial):
-- min(1, 2 x min(P(W <= k), P(W >= k))). Pure math; the security_invoker scorecard view calls it as the reader.
create or replace function public.poisson_binomial_two_sided_p(p_probs double precision[], p_wins integer)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  n integer := coalesce(array_length(p_probs, 1), 0);
  d double precision[];
  p double precision;
  lo double precision := 0;
  hi double precision := 0;
  i integer;
  j integer;
begin
  if n = 0 or p_wins is null or p_wins < 0 or p_wins > n then
    return null;
  end if;
  -- d[j + 1] = P(W = j) after the trades seen so far.
  d := array_fill(0::double precision, array[n + 1]);
  d[1] := 1;
  for i in 1..n loop
    p := least(greatest(coalesce(p_probs[i], 0), 0), 1);
    for j in reverse i..1 loop
      d[j + 1] := d[j + 1] * (1 - p) + d[j] * p;
    end loop;
    d[1] := d[1] * (1 - p);
  end loop;
  for j in 0..p_wins loop
    lo := lo + d[j + 1];
  end loop;
  for j in p_wins..n loop
    hi := hi + d[j + 1];
  end loop;
  return round(least(1, 2 * least(lo, hi))::numeric, 6);
end;
$$;

comment on function public.poisson_binomial_two_sided_p(double precision[], integer) is
  'Exact two-sided p-value of p_wins wins over independent trades with win probabilities p_probs (Poisson-binomial): min(1, 2 x min(P(W <= k), P(W >= k))). Used by v_thesis_scorecard for binary calibration.';

revoke all on function public.poisson_binomial_two_sided_p(double precision[], integer) from public, anon;
grant execute on function public.poisson_binomial_two_sided_p(double precision[], integer)
  to authenticated, service_role, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker;

-- ---------------------------------------------------------------- scorecard
-- Same columns as 47 in the same order (values change only for binary theses), plus five at the end.
create or replace view public.v_thesis_scorecard
with (security_invoker = true)
as
with o as (
  select t.thesis_id, t.steward, t.unit, t.venue, t.realized_pnl, t.confidence_at_entry,
         coalesce(t.probability_at_entry, t.price_at_entry) as win_p
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
         avg(o.confidence_at_entry) as avg_confidence_at_entry,
         bool_and(o.venue = 'prediction') filter (where o.realized_pnl is not null) as binary_only,
         count(*) filter (where o.realized_pnl is not null and o.win_p is not null)::integer as cal_trades,
         count(*) filter (where o.realized_pnl > 0::numeric and o.win_p is not null)::integer as cal_wins,
         sum(o.win_p) filter (where o.realized_pnl is not null) as expected_wins,
         array_agg(o.win_p::double precision) filter (where o.realized_pnl is not null and o.win_p is not null) as win_ps
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
         ev.backtest_mean_ret, ev.backtest_mean_deflated,
         coalesce(a.binary_only, false) as is_binary,
         coalesce(a.cal_trades, 0) as cal_trades,
         a.cal_wins,
         a.expected_wins,
         a.win_ps
  from ids i
  left join agg a on a.thesis_id = i.thesis_id
  left join ev on ev.thesis_id = i.thesis_id
  left join public.theses th on th.id = i.thesis_id
), c as (
  select s.*,
         case when s.is_binary then round(100.0 * s.cal_wins::numeric / nullif(s.cal_trades, 0)::numeric, 1) end as cal_hit_rate,
         case when s.is_binary then round(100.0 * s.expected_wins / nullif(s.cal_trades, 0)::numeric, 1) end as expected_win_rate,
         case when s.is_binary and s.cal_trades > 0 then public.poisson_binomial_two_sided_p(s.win_ps, s.cal_wins) end as calibration_p
  from s
)
select c.thesis_id,
       c.name,
       c.status,
       c.steward,
       c.unit,
       c.stated as stated_confidence,
       c.avg_confidence_at_entry,
       c.trades,
       c.priced_trades,
       c.wins,
       c.realized_pnl,
       c.implied as outcome_implied_confidence,
       case when c.is_binary then c.expected_win_rate - c.cal_hit_rate
            else c.stated - c.implied end as confidence_gap,
       case when c.is_binary then coalesce(c.cal_trades >= 10 and c.calibration_p < 0.05, false)
            else coalesce(abs(c.stated - c.implied) > 15::numeric, false) end as miscalibrated,
       c.priced_trades < 10 as thin,
       c.results as results_confidence,
       coalesce(c.backtest_tests, 0) as backtest_tests,
       coalesce(c.backtest_trades, 0) as backtest_trades,
       coalesce(c.backtest_weight, 0) as backtest_weight,
       c.backtest_mean_ret,
       c.backtest_mean_deflated,
       case when c.backtest_mean_deflated > 0 then 'for' when c.backtest_mean_deflated < 0 then 'against' end as backtest_effect,
       case when c.is_binary then 'entry_probability' else 'stated_vs_hit_rate' end as calibration_basis,
       case when c.is_binary then round(c.expected_wins, 4) end as expected_wins,
       c.expected_win_rate,
       case when c.is_binary then c.cal_trades end as calibration_trades,
       c.calibration_p
from c;

comment on view public.v_thesis_scorecard is
  'Per-thesis calibration (measurement only; feeds no sizing or gate). outcome_implied_confidence = realized hit rate x 100. calibration_basis stated_vs_hit_rate (equity, meme, mixed): confidence_gap = stated - hit rate, miscalibrated when |gap| > 15. calibration_basis entry_probability (every priced trade a prediction-market binary): expected_wins = sum of each trade''s fair probability (pm_enter --p) or else its entry price; confidence_gap = expected_win_rate - hit rate over those trades; calibration_p = exact two-sided Poisson-binomial p-value of the wins; miscalibrated only with calibration_trades >= 10 and calibration_p < 0.05. thin when priced_trades < 10.';
