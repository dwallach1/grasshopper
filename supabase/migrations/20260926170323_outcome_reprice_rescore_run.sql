-- PR 2 data step: seed stated confidence, re-price outcomes from fills, re-score theses.
-- Re-runnable: reprice/rescore only write when numbers change.

-- 1. stated_confidence = latest numeric belief update newer than the thesis row, else current confidence.
select set_config('grasshopper.outcome_rescore', 'on', true);
update public.theses t
set stated_confidence = coalesce((
      select round(b.new_confidence)::smallint
      from public.belief_updates b
      where b.thesis_id = t.id
        and b.new_confidence >= 1
        and coalesce(b.meta->>'kind', '') <> 'outcome_rescore'
        and b.observed_at > t.updated_at
      order by b.observed_at desc
      limit 1
    ), t.confidence)
where t.stated_confidence is null;
select set_config('grasshopper.outcome_rescore', 'off', true);

-- 2. Re-price every outcome from fills where fills now cover the round trip
--    (QUANTANAMO broker_fills and BANDIT meme_fills.fee_sol backfills landed 2026-09-26).
select private.reprice_trade_outcomes(null);

-- 3. Re-score every thesis with priced outcomes.
select private.rescore_all_thesis_confidence();
