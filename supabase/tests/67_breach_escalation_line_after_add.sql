-- Read-only checks for migration 67. Run against a database with 67 applied.
-- Raises on the first failure. The replay reads the 10/8 prints when they are in this database
-- and always checks the same fixture.
do $$
declare
  v jsonb;
  r record;
begin
  assert public.breach_age_label(0) = '0m', '0m';
  assert public.breach_age_label(14) = '14m', '14m';
  assert public.breach_age_label(120) = '2h', '2h';
  assert public.breach_age_label(171) = '2h 51m', '2h 51m';
  assert public.escalated_breach_sentence('NBIS', 120) = 'NBIS has been under its exit line for 2h — sell now',
    'two hour sentence';

  assert not public.line_at_or_below_blended(227.90, 227.6137), '10/6 NBIS line still above the new cost';
  assert public.line_at_or_below_blended(227.6137, 227.6137), 'line equal to blended cost';
  assert public.line_at_or_below_blended(220.80, 227.6137), 'line under blended cost';
  assert not public.line_at_or_below_blended(null, 227.6137), 'null line is not a flag';
  assert public.lot_accepts_scratch('{"accepted_scratch":"true"}'::jsonb), 'lot scratch';
  assert not public.lot_accepts_scratch('{}'::jsonb), 'no scratch';
  assert (public.line_vs_cost_meta('{"untagged":"historical"}'::jsonb, 227.90, 227.6137, true, false, now()) ->> 'line_at_or_below_cost') is null,
    '10/6 NBIS numbers do not write the flag';
  assert (public.line_vs_cost_meta('{}'::jsonb, 227.6137, 227.6137, true, false, now()) ->> 'line_at_or_below_cost') = 'true',
    'line at cost writes the flag';
  assert (public.line_vs_cost_meta('{"line_at_or_below_cost":true}'::jsonb, 227.00, 227.6137, true, true, now()) ->> 'line_at_or_below_cost') is null,
    'an accepted scratch clears the flag';

  -- Fixture of the 10/8 prints. 13:49 was above both lines. 13:53 is check 1. 16:44 is check 2.
  v := public.replay_actionable_breach_checks(jsonb_build_object(
    'instrument', 'NBIS', 'line', 227.90, 'equity', true,
    'marks', jsonb_build_array(
      jsonb_build_object('at', '2026-10-08 13:49:09.625052+00', 'price', 229.145),
      jsonb_build_object('at', '2026-10-08 13:53:02.278126+00', 'price', 227.72))));
  assert (v->>'checks')::int = 1, v::text;
  assert (v->>'escalated')::boolean = false, v::text;
  assert (v->>'first_seen_at')::timestamptz = '2026-10-08 13:53:02.278126+00'::timestamptz, v::text;

  v := public.replay_actionable_breach_checks(jsonb_build_object(
    'instrument', 'NBIS', 'line', 227.90, 'equity', true,
    'marks', jsonb_build_array(
      jsonb_build_object('at', '2026-10-08 13:49:09.625052+00', 'price', 229.145),
      jsonb_build_object('at', '2026-10-08 13:53:02.278126+00', 'price', 227.72),
      jsonb_build_object('at', '2026-10-08 16:44:06.973851+00', 'price', 226.59))));
  assert (v->>'checks')::int = 2, v::text;
  assert (v->>'escalated')::boolean, v::text;
  assert v->>'escalation' = 'next_check', v::text;
  assert (v->>'breach_age_minutes')::int = 171, v::text;
  assert v->>'sentence' = 'NBIS has been under its exit line for 2h 51m — sell now', v::text;

  v := public.replay_actionable_breach_checks(jsonb_build_object(
    'instrument', 'CODA', 'line', 10.35, 'equity', true,
    'marks', jsonb_build_array(
      jsonb_build_object('at', '2026-10-08 13:49:09.625052+00', 'price', 10.52),
      jsonb_build_object('at', '2026-10-08 13:53:02.278126+00', 'price', 10.32),
      jsonb_build_object('at', '2026-10-08 16:44:06.973851+00', 'price', 10.29))));
  assert (v->>'checks')::int = 2 and v->>'escalation' = 'next_check', v::text;
  assert v->>'sentence' = 'CODA has been under its exit line for 2h 51m — sell now', v::text;

  v := public.replay_actionable_breach_checks(jsonb_build_object(
    'instrument', 'CODA', 'line', 10.35, 'equity', true,
    'marks', jsonb_build_array(jsonb_build_object('at', '2026-10-06 13:05:32.751992+00', 'price', 10.31))));
  assert (v->>'checks')::int = 0 and (v->>'escalated')::boolean = false, 'premarket is not a check: ' || v::text;

  -- The same two symbols, from the rows in this database when they are present.
  for r in
    select * from (values ('NBIS', 227.90), ('CODA', 10.35)) as lots(symbol, line)
  loop
    if exists (
      select 1 from public.portfolio_exposure
      where symbol = r.symbol and observed_at = '2026-10-08 13:53:02.278126+00' and last_price is not null
    ) then
      v := public.replay_actionable_breach_checks(jsonb_build_object(
        'instrument', r.symbol, 'line', r.line, 'equity', true,
        'marks', (
          select jsonb_agg(jsonb_build_object('at', observed_at, 'price', last_price) order by observed_at)
          from public.portfolio_exposure
          where symbol = r.symbol
            and observed_at >= '2026-10-08' and observed_at < '2026-10-09'
            and last_price is not null)));
      assert (v->>'checks')::int = 2, r.symbol || ' live replay checks: ' || v::text;
      assert v->>'escalation' = 'next_check', r.symbol || ' live replay: ' || v::text;
      assert (v->>'first_seen_at')::timestamptz = '2026-10-08 13:53:02.278126+00'::timestamptz, r.symbol || ' first seen: ' || v::text;
      assert (v->>'breach_age_minutes')::int = 171, r.symbol || ' age: ' || v::text;
    end if;
  end loop;
end;
$$;
