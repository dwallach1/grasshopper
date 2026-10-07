-- Read-only checks for migration 63 (steward Brier vs the market, same rows, same side terms).
-- Raises on the first failure; writes nothing.
do $$
declare
  v_brier numeric;
  v_market numeric;
  v_null_brier numeric;
  v_n int;
  v_excluded int;
  v_direct_n int;
  v_direct_excluded int;
  v_direct_brier numeric;
  v_direct_market numeric;
  v_no_raw numeric;
begin
  -- NO side logged in YES terms: both prices flip before the square. y = 1 because outcome = side.
  -- Raw (0.80 - 1)^2 = 0.04 is the wrong event. Side terms: (0.20 - 1)^2 = 0.64.
  select b.brier, b.market_brier into v_brier, v_market
  from public.decision_side_briers('no', 0.80, 0.70, 'no', '{"price_terms":"yes"}'::jsonb) b;
  v_no_raw := power(0.80 - 1, 2);
  assert v_brier = power(0.20 - 1, 2), format('NO yes-terms steward brier %s', v_brier);
  assert v_market = power(0.30 - 1, 2), format('NO yes-terms market brier %s', v_market);
  assert v_brier is distinct from v_no_raw, 'NO yes-terms row was scored as a raw side probability';

  -- NO side already in side terms: no flip. Outcome yes means y = 0.
  select b.brier, b.market_brier into v_brier, v_market
  from public.decision_side_briers('no', 0.25, 0.20, 'yes', '{"price_terms":"side"}'::jsonb) b;
  assert v_brier = power(0.25 - 0, 2), format('NO side-terms steward brier %s', v_brier);
  assert v_market = power(0.20 - 0, 2), format('NO side-terms market brier %s', v_market);

  -- YES side, YES terms: identity. Same square the stored column uses for this row.
  select b.brier, b.market_brier into v_brier, v_market
  from public.decision_side_briers('yes', 0.25, 0.20, 'no', '{"price_terms":"yes"}'::jsonb) b;
  assert v_brier = power(0.25 - 0, 2) and v_market = power(0.20 - 0, 2), 'YES row drifted';

  -- A missing book is not a price. Both scores stay null.
  select b.brier into v_null_brier
  from public.decision_side_briers('yes', 0.40, null, 'yes', '{"price_terms":"yes"}'::jsonb) b;
  assert v_null_brier is null, 'null book_price invented a market brier';

  -- The rollup matches a direct recompute, and rows with no book are counted outside n.
  select v.n, v.excluded_no_book, v.brier, v.market_brier
    into v_n, v_excluded, v_brier, v_market
  from public.v_decision_brier_vs_market v
  where v.steward = 'oddsborne' and v.decision = 'all' and v.all_theses;

  select count(*) filter (where c.book_price is not null),
         count(*) filter (where c.book_price is null),
         avg(s.brier),
         avg(s.market_brier)
    into v_direct_n, v_direct_excluded, v_direct_brier, v_direct_market
  from public.decision_candidates c
  left join lateral public.decision_side_briers(
    c.side, c.my_probability, c.book_price, c.resolved_outcome, c.meta
  ) s on true
  where c.steward = 'oddsborne'
    and c.venue = 'prediction'
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
    );

  assert v_n = v_direct_n, format('n %s <> direct %s', v_n, v_direct_n);
  assert v_excluded = v_direct_excluded, format('excluded %s <> direct %s', v_excluded, v_direct_excluded);
  assert v_brier is not distinct from v_direct_brier, 'rollup brier drifted from the row function';
  assert v_market is not distinct from v_direct_market, 'rollup market brier drifted from the row function';
  assert v_excluded >= 0, 'excluded count went negative';

  -- Enter and skip use the same terms, and a thin enter sample stays under the scorecard threshold.
  assert exists (
    select 1 from public.v_decision_brier_vs_market v
    where v.steward = 'oddsborne' and v.decision = 'enter' and v.all_theses
      and v.thin = (v.n < 10)
  ), 'enter thin flag is not n < 10';
  assert exists (
    select 1 from public.v_decision_brier_vs_market v
    where v.steward = 'oddsborne' and v.decision = 'skip' and v.all_theses
      and v.n + (
        select e.n from public.v_decision_brier_vs_market e
        where e.steward = 'oddsborne' and e.decision = 'enter' and e.all_theses
      ) = v_n
  ), 'enter + skip n is not the all-row n';
end;
$$;
