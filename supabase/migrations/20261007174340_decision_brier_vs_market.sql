-- Steward probability vs the market price on the same resolved rows.
--
-- decision_candidates.brier is the YES-terms score from private.score_decision_candidate
-- (P(yes) after decision_in_yes_terms, against outcome = yes). Flipping both the probability
-- and the outcome leaves that number unchanged, so a side-terms score matches the stored
-- column once NO rows logged in YES terms are flipped. Comparing the raw columns to
-- y = 1{outcome = side} does not: two ODDSBORNE skips are side 'no' with price_terms 'yes'.
-- This view does not average the stored column. It scores my_probability and book_price
-- with the same decision_in_side_terms conversion, against the same y, on the same rows.
--
-- TODO(outcome-rescore): private.rescore_thesis_confidence writes belief_updates
-- ('Results re-score: … score N') from expected return per trade and feeds the QUANTANAMO
-- gate. Market-relative skill is a different yardstick. Folding it into that score would
-- change sizing. The desk reads this view until a ruling says the score should take it.

create or replace function public.decision_side_briers(
  p_side text,
  p_my_probability numeric,
  p_book_price numeric,
  p_outcome text,
  p_meta jsonb,
  out brier numeric,
  out market_brier numeric
)
language sql
immutable
set search_path = ''
as $$
  select
    case when t.ok then pg_catalog.power(t.p_mine - t.y, 2)::numeric end,
    case when t.ok then pg_catalog.power(t.p_book - t.y, 2)::numeric end
  from (
    select
      public.decision_in_side_terms(p_side, p_my_probability, p_meta) as p_mine,
      public.decision_in_side_terms(p_side, p_book_price, p_meta) as p_book,
      (p_outcome = p_side)::integer as y,
      (
        p_outcome in ('yes', 'no')
        and p_side in ('yes', 'no')
        and p_my_probability >= 0 and p_my_probability <= 1
        and p_book_price > 0 and p_book_price <= 1
      ) as ok
  ) t;
$$;

comment on function public.decision_side_briers(text, numeric, numeric, text, jsonb) is
  'Brier of the steward probability and of the market price, both in the named side''s terms. y = 1 when p_outcome = p_side. Null when either input is missing or not a probability, so a missing book is never invented.';

revoke all on function public.decision_side_briers(text, numeric, numeric, text, jsonb) from public, anon;
grant execute on function public.decision_side_briers(text, numeric, numeric, text, jsonb)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create or replace view public.v_decision_brier_vs_market
with (security_invoker = true)
as
with settled as (
  select
    c.steward,
    c.decision,
    nullif(pg_catalog.btrim(c.thesis_id), '') as thesis_id,
    (c.book_price is null) as missing_book,
    s.brier,
    s.market_brier
  from public.decision_candidates c
  left join lateral public.decision_side_briers(
    c.side, c.my_probability, c.book_price, c.resolved_outcome, c.meta
  ) s on true
  where c.venue = 'prediction'
    and c.resolved_at is not null
    and c.resolved_outcome in ('yes', 'no')
    and c.side in ('yes', 'no')
    and c.decision in ('enter', 'skip')
    and coalesce(c.meta->>'superseded', '') <> 'true'
    and (
      c.book_price is null
      or (
        c.my_probability >= 0 and c.my_probability <= 1
        and c.book_price > 0 and c.book_price <= 1
      )
    )
)
select
  steward,
  case when grouping(decision) = 1 then 'all' else decision end as decision,
  thesis_id,
  (grouping(thesis_id) = 1) as all_theses,
  count(brier)::integer as n,
  avg(brier) as brier,
  avg(market_brier) as market_brier,
  avg(brier) - avg(market_brier) as brier_gap,
  case when avg(market_brier) > 0 then 1 - avg(brier) / avg(market_brier) end as skill,
  (count(brier) < 10) as thin,
  count(*) filter (where missing_book)::integer as excluded_no_book
from settled
group by grouping sets (
  (steward, decision, thesis_id),
  (steward, decision),
  (steward, thesis_id),
  (steward)
);

comment on view public.v_decision_brier_vs_market is
  'Per steward, per decision (enter / skip / all), and per thesis (all_theses marks the rollup). n, brier, and market_brier use the same resolved prediction rows and the same side terms. skill = 1 - brier/market_brier (positive means the steward was closer than the price). brier_gap = brier - market_brier (negative means the same). thin when n < 10, the scorecard threshold. excluded_no_book counts resolved rows with no book_price; they are not in n. Measurement only.';

revoke all on public.v_decision_brier_vs_market from public, anon;
grant select on public.v_decision_brier_vs_market
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
