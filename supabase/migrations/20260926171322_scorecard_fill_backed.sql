-- PR 3: scorecard from_fills counts prediction outcomes held to settlement whose cost
-- and fees come from venue-keyed pm_fills (pnl_source = 'settlement', meta.fills > 0).
-- Same columns as before; grants are preserved by create or replace.

create or replace view public.v_steward_scorecard
with (security_invoker = true)
as
with stewards(steward, venue, unit, sort_order) as (
  values ('quantanamo', 'equity', 'USD', 1), ('oddsborne', 'prediction', 'USD', 2), ('bandit', 'meme', 'SOL', 3)
),
o as (
  select * from public.trade_outcomes where not is_paper
),
agg as (
  select o.steward,
    count(*)::int as trades,
    count(o.realized_pnl)::int as priced_trades,
    count(*) filter (where o.realized_pnl > 0)::int as wins,
    count(*) filter (where o.realized_pnl < 0)::int as losses,
    sum(o.realized_pnl) as realized_pnl,
    avg(o.realized_pnl) filter (where o.realized_pnl > 0) as avg_win,
    avg(o.realized_pnl) filter (where o.realized_pnl < 0) as avg_loss,
    avg(o.realized_pnl) as expectancy,
    sum(o.fees) as fees_recorded,
    count(*) filter (where o.fees is null)::int as fees_missing,
    -- Fill-backed: priced from fills, or held to settlement with cost from venue fills.
    count(*) filter (where o.realized_pnl is not null and (o.pnl_source = 'fills'
      or (o.pnl_source = 'settlement' and coalesce(o.meta->>'fills', '') ~ '^[1-9][0-9]*$')))::int as from_fills,
    count(*) filter (where o.pnl_source = 'cash_delta')::int as from_cash_delta,
    count(*) filter (where o.pnl_source = 'settlement')::int as from_settlement,
    count(*) filter (where o.pnl_source = 'manual')::int as from_manual,
    count(*) filter (where o.realized_pnl is null)::int as unpriced,
    min(o.closed_at) as first_closed_at,
    max(o.closed_at) as last_closed_at
  from o
  group by o.steward
),
qnt_marks as (
  select e.quantity, e.average_buy_price, e.last_price, e.observed_at
  from public.portfolio_exposure e
  where e.account_last4 = '7638'
    and e.observed_at = (select max(x.observed_at) from public.portfolio_exposure x where x.account_last4 = '7638')
    and e.quantity > 0
),
unreal as (
  select 'quantanamo'::text as steward,
    count(*)::int as open_positions,
    sum(q.quantity * (q.last_price - q.average_buy_price)) as unrealized_pnl,
    max(q.observed_at) as marked_at
  from qnt_marks q
  union all
  select 'oddsborne', count(*)::int, sum(p.quantity * (p.mark - p.average_cost)), max(p.mark_at)
  from public.pm_positions p where p.status = 'open'
  union all
  select 'bandit', count(*)::int, sum(p.quantity * (p.mark_sol - p.average_cost_sol)), max(p.mark_at)
  from public.meme_positions p where p.status = 'open'
),
dec as (
  select c.steward,
    count(*) filter (where c.decision = 'skip')::int as skips_logged,
    count(*) filter (where c.decision = 'skip' and c.resolved_outcome is not null)::int as skips_resolved,
    count(*) filter (where c.decision = 'skip' and c.counterfactual_pnl is not null)::int as skips_scored,
    count(*) filter (where c.decision = 'skip' and c.counterfactual_pnl > 0)::int as skips_would_have_won,
    sum(c.counterfactual_pnl) filter (where c.decision = 'skip') as skip_counterfactual_pnl,
    count(*) filter (where c.decision = 'enter')::int as enters_logged,
    avg(c.brier) as brier_mean,
    count(c.brier)::int as brier_n
  from public.decision_candidates c
  group by c.steward
),
fill_fees as (
  -- BANDIT fees line: every meme fill's fee_sol (open lots included), not meme_pnl.fees.
  select 'bandit'::text as steward,
    sum(f.fee_sol) as fees_from_fills,
    count(*) filter (where f.fee_sol is null)::int as fills_missing_fee
  from public.meme_fills f
)
select
  s.steward,
  s.venue,
  s.unit,
  s.sort_order,
  coalesce(a.trades, 0) as trades,
  coalesce(a.priced_trades, 0) as priced_trades,
  coalesce(a.wins, 0) as wins,
  coalesce(a.losses, 0) as losses,
  round(a.wins::numeric / nullif(a.priced_trades, 0), 4) as hit_rate,
  a.realized_pnl,
  a.avg_win,
  a.avg_loss,
  a.expectancy,
  coalesce(a.priced_trades, 0) < 10 as thin,
  a.fees_recorded,
  coalesce(a.fees_missing, 0) as fees_missing,
  coalesce(a.from_fills, 0) as from_fills,
  coalesce(a.from_cash_delta, 0) as from_cash_delta,
  coalesce(a.from_settlement, 0) as from_settlement,
  coalesce(a.from_manual, 0) as from_manual,
  coalesce(a.unpriced, 0) as unpriced,
  coalesce(a.trades, 0) - coalesce(a.from_fills, 0) as not_from_fills,
  a.first_closed_at,
  a.last_closed_at,
  coalesce(u.open_positions, 0) as open_positions,
  case when coalesce(u.open_positions, 0) = 0 then 0 else u.unrealized_pnl end as unrealized_pnl,
  u.marked_at as unrealized_marked_at,
  coalesce(d.skips_logged, 0) as skips_logged,
  coalesce(d.skips_resolved, 0) as skips_resolved,
  coalesce(d.skips_scored, 0) as skips_scored,
  coalesce(d.skips_would_have_won, 0) as skips_would_have_won,
  d.skip_counterfactual_pnl,
  coalesce(d.enters_logged, 0) as enters_logged,
  d.brier_mean,
  coalesce(d.brier_n, 0) as brier_n,
  ff.fees_from_fills,
  ff.fills_missing_fee
from stewards s
left join agg a on a.steward = s.steward
left join unreal u on u.steward = s.steward
left join dec d on d.steward = s.steward
left join fill_fees ff on ff.steward = s.steward;

comment on view public.v_steward_scorecard is
  'Per-steward realized scorecard from trade_outcomes (live only). thin = priced_trades < 10. from_fills = priced from fills, or settlement with cost from venue fills; not_from_fills = data-quality count. fees_from_fills = BANDIT sum(meme_fills.fee_sol).';
