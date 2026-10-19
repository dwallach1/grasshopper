-- Read-only checks for the implied-move gap predicate (schema 81).
-- `psql "$DATABASE_URL" -f supabase/tests/81_equity_implied_move_gaps.sql` after 81 is applied.
-- Raises on the first failure; writes nothing. The count is the watchdog number for these rows.
do $$
declare
  n integer;
begin
  -- No row: a report still ahead would be silent. This is a gap.
  assert public.equity_implied_move_is_gap(false, null, null, false, null, null, timestamptz '2026-10-19 16:00:00+00'),
    'unwritten lot is a gap';

  -- Report still ahead, straddle stored: current. Not a gap.
  assert not public.equity_implied_move_is_gap(
    true, date '2026-10-20', 'am', false, 6, null, timestamptz '2026-10-19 16:00:00+00'),
    'priced straddle is current';

  -- Report still ahead, missing flag written: the lot is flagged, the write happened.
  assert not public.equity_implied_move_is_gap(
    true, date '2026-10-20', 'am', false, null, 'implied_move_missing', timestamptz '2026-10-19 16:00:00+00'),
    'missing flag is current';

  -- Passed report (actual EPS): the line only. Not a gap.
  assert not public.equity_implied_move_is_gap(
    true, date '2026-10-20', 'am', true, null, null, timestamptz '2026-10-19 16:00:00+00'),
    'reported is current';

  -- Checked calendar, nothing pending. Not a gap.
  assert not public.equity_implied_move_is_gap(
    true, null, null, false, null, null, timestamptz '2026-10-19 16:00:00+00'),
    'no pending report is current';

  -- Report still ahead, no straddle, no flag: the implied move was never written.
  assert public.equity_implied_move_is_gap(
    true, date '2026-10-20', 'am', false, null, null, timestamptz '2026-10-19 16:00:00+00'),
    'ahead with no straddle is a gap';

  -- am clock: 09:00 ET still ahead, 09:30 ET has passed.
  assert public.equity_implied_move_is_gap(
    true, date '2026-10-20', 'am', false, null, null, timestamptz '2026-10-20 13:00:00+00'),
    '09:00 ET is still a gap';
  assert not public.equity_implied_move_is_gap(
    true, date '2026-10-20', 'am', false, null, null, timestamptz '2026-10-20 13:30:00+00'),
    '09:30 ET has passed';

  select count(*)::integer into n
  from (values
    (false, null::date, null::text, false, null::numeric, null::text),
    (true, date '2026-10-20', 'am', false, 6::numeric, null::text),
    (true, date '2026-10-20', 'am', false, null::numeric, 'implied_move_missing'),
    (true, date '2026-10-20', 'am', true, null::numeric, null::text),
    (true, null::date, null::text, false, null::numeric, null::text),
    (true, date '2026-10-20', 'am', false, null::numeric, null::text)
  ) as v(has_row, report_date, report_timing, reported, straddle, missing)
  where public.equity_implied_move_is_gap(
    v.has_row, v.report_date, v.report_timing, v.reported, v.straddle, v.missing,
    timestamptz '2026-10-19 16:00:00+00');
  assert n = 2, format('watchdog gap count: %s', n);
end $$;
