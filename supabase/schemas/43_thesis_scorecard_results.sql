-- Thesis scorecard after migration 41: theses.confidence is now the display number (results score when
-- scored, else stated), so the scorecard's "stated" column reads theses.stated_confidence, and the
-- results score is exposed next to it. Read-only view change; no rule function changes.
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
), s as (
  select a.*, th.name, th.status,
         coalesce(th.stated_confidence, th.confidence)::numeric as stated,
         round(100.0 * a.wins::numeric / nullif(a.priced_trades, 0)::numeric, 1) as implied,
         th.results_confidence::numeric as results
  from agg a
  left join public.theses th on th.id = a.thesis_id
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
       s.results as results_confidence
from s;
