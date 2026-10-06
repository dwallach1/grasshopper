-- Read-only checks for migration 52 (scorecard binary calibration). Run against a database with 52 and 53
-- applied, e.g. `psql "$DATABASE_URL" -f supabase/tests/52_scorecard_binary_calibration.sql` or paste into the
-- Supabase SQL editor. Raises on the first failure; writes nothing.
do $$
declare
  r record;
begin
  -- Exact Poisson-binomial two-sided p-values against hand-checked values.
  assert public.poisson_binomial_two_sided_p(array[0.1818, 0.1658]::float8[], 0) = 1,
    '0 for 2 at ~17c fair value is the most likely outcome (P = 0.68), p must be 1';
  assert public.poisson_binomial_two_sided_p(array_fill(0.5::float8, array[10]), 10) = 0.001953, '10/10 at 0.5';
  assert public.poisson_binomial_two_sided_p(array_fill(0.5::float8, array[10]), 5) = 1, '5/10 at 0.5';
  assert public.poisson_binomial_two_sided_p(array_fill(0.15::float8, array[20]), 0) = 0.077519, '0/20 at 0.15 (2 x 0.85^20)';
  assert public.poisson_binomial_two_sided_p(array[0.9, 0.9]::float8[], 0) = 0.02, '0/2 at 0.9';
  assert public.poisson_binomial_two_sided_p('{}'::float8[], 0) is null, 'no trades -> null';
  assert public.poisson_binomial_two_sided_p(array[0.5]::float8[], 2) is null, 'more wins than trades -> null';

  -- No binary thesis is flagged below the minimum sample, or without p < 0.05.
  for r in select * from public.v_thesis_scorecard where calibration_basis = 'entry_probability' loop
    assert not r.miscalibrated or (r.calibration_trades >= 10 and r.calibration_p < 0.05),
      format('binary thesis %s flagged on %s trades (p=%s)', r.thesis_id, r.calibration_trades, r.calibration_p);
    assert r.confidence_gap is not distinct from
      (r.expected_win_rate - round(100.0 * r.wins / nullif(r.calibration_trades, 0), 1))
      or r.calibration_trades <> r.priced_trades,
      format('binary gap for %s is not expected - hit rate', r.thesis_id);
  end loop;

  -- Equity / meme / mixed theses keep the old rule exactly.
  for r in select * from public.v_thesis_scorecard where calibration_basis = 'stated_vs_hit_rate' loop
    assert r.confidence_gap is not distinct from (r.stated_confidence - r.outcome_implied_confidence),
      format('gap for %s changed', r.thesis_id);
    assert r.miscalibrated = coalesce(abs(r.stated_confidence - r.outcome_implied_confidence) > 15, false),
      format('flag for %s changed', r.thesis_id);
    assert r.expected_wins is null and r.calibration_p is null, format('%s carries binary fields', r.thesis_id);
  end loop;

  -- Every settled prediction trade on a thesis has an entry price.
  assert not exists (
    select 1 from public.trade_outcomes
    where venue = 'prediction' and source_table = 'pm_positions' and not is_paper
      and thesis_id is not null and realized_pnl is not null and price_at_entry is null
  ), 'a priced prediction trade has no price_at_entry';
end;
$$;
