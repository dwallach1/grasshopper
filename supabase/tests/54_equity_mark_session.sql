-- Read-only checks for migration 54 (equity mark session). Run against a database with 54 applied, e.g.
-- `psql "$DATABASE_URL" -f supabase/tests/54_equity_mark_session.sql` or paste into the Supabase SQL editor.
-- Raises on the first failure; writes nothing.
do $$
declare
  r record;
  v_ts timestamptz;
begin
  -- Session boundaries, America/New_York (EDT on these dates).
  assert private.us_equity_session(null) is null, 'null time -> null';
  assert private.us_equity_session('2026-10-06 13:05:32+00') = 'pre', '06:05 PT / 09:05 ET Tue is premarket (CODA 10/6)';
  assert private.us_equity_session('2026-10-06 13:46:45+00') = 'rth', '09:46 ET Tue is regular session';
  assert private.us_equity_session('2026-10-06 13:29:59+00') = 'pre', '09:29:59 ET is premarket';
  assert private.us_equity_session('2026-10-06 13:30:00+00') = 'rth', '09:30:00 ET opens the session';
  assert private.us_equity_session('2026-10-06 19:59:59+00') = 'rth', '15:59:59 ET is regular session';
  assert private.us_equity_session('2026-10-06 20:00:00+00') = 'post', '16:00 ET is after hours';
  assert private.us_equity_session('2026-10-05 23:21:33+00') = 'post', '19:21 ET Mon is after hours';
  assert private.us_equity_session('2026-10-07 00:00:00+00') = 'closed', '20:00 ET is closed (overnight)';
  assert private.us_equity_session('2026-10-06 07:59:59+00') = 'closed', '03:59 ET is closed (overnight)';
  assert private.us_equity_session('2026-10-06 08:00:00+00') = 'pre', '04:00 ET starts premarket';
  assert private.us_equity_session('2026-10-10 15:00:00+00') = 'closed', 'Saturday is closed';
  assert private.us_equity_session('2026-09-07 15:00:00+00') = 'closed', 'Labor Day is closed';
  -- Early close (day after Thanksgiving, EST): core ends 13:00 ET, after hours ends 17:00 ET.
  assert private.us_equity_session('2026-11-27 17:59:00+00') = 'rth', '12:59 ET early-close day is regular';
  assert private.us_equity_session('2026-11-27 18:00:00+00') = 'post', '13:00 ET early-close day is after hours';
  assert private.us_equity_session('2026-11-27 22:00:00+00') = 'closed', '17:00 ET early-close day is closed';
  assert public.us_equity_session('2026-10-06 13:05:32+00') = 'pre', 'public wrapper matches';

  -- rth is exactly is_us_regular_session, every 15 minutes for 15 days around a weekend and Thanksgiving.
  for v_ts in
    select g from generate_series('2026-10-02 00:00+00'::timestamptz, '2026-10-09 00:00+00', interval '15 minutes') g
    union all
    select g from generate_series('2026-11-24 00:00+00'::timestamptz, '2026-12-01 00:00+00', interval '15 minutes') g
  loop
    assert (private.us_equity_session(v_ts) = 'rth') = private.is_us_regular_session(v_ts),
      format('rth disagrees with is_us_regular_session at %s', v_ts);
  end loop;

  -- Live views: equities carry a session, PM and memes never do; only an rth equity mark is actionable.
  for r in select * from public.v_open_lot_marks loop
    if r.lot_table = 'position_episodes' then
      assert (r.mark_at is null) = (r.mark_session is null), format('equity lot %s session/mark_at mismatch', r.lot_id);
    else
      assert r.mark_session is null, format('%s lot %s has a session', r.lot_table, r.lot_id);
    end if;
  end loop;
  for r in select * from public.v_invalidation_breaches loop
    assert r.action_hint = case
      when r.lot_table = 'position_episodes' and r.mark_session is distinct from 'rth' then 'review_at_open'
      else 'exit_full_lot' end,
      format('breach %s %s: action_hint %s vs session %s', r.lot_table, r.lot_id, r.action_hint, r.mark_session);
  end loop;
end;
$$;
