-- Read-only checks for migration 80 (equity implied-move risk). Run against a database with 80 applied, e.g.
-- `psql "$DATABASE_URL" -f supabase/tests/80_equity_implied_move_risk.sql`.
-- Raises on the first failure; writes nothing.
do $$
declare
  r record;
begin
  -- Pre-report, implied move wins. qty 10, mark 50, invalidation 45 -> line 50.
  -- Straddle 6 / underlying 50 -> implied (6/50) x 500 = 60. Risk is the max.
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, date '2026-10-20', 'am', false, 6, 50, date '2026-11-20', true, null,
    timestamptz '2026-10-19 16:00:00+00');
  assert r.line_risk = 50 and r.implied_move = 60 and r.risk = 60 and r.risk_flag is null,
    format('pre-report implied wins: %s', row_to_json(r));

  -- Pre-report, the line wins. Invalidation 40 -> line 100, implied still 60.
  select * into r from private.equity_lot_open_risk(
    10, 50, 40, date '2026-10-20', 'am', false, 6, 50, date '2026-11-20', true, null,
    timestamptz '2026-10-19 16:00:00+00');
  assert r.line_risk = 100 and r.implied_move = 60 and r.risk = 100 and r.risk_flag is null,
    format('pre-report line wins: %s', row_to_json(r));

  -- Post-report (actual EPS, or the clock): line only, even when a straddle is stored.
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, date '2026-10-20', 'am', true, 6, 50, date '2026-11-20', true, null,
    timestamptz '2026-10-19 16:00:00+00');
  assert r.risk = 50 and r.implied_move is null and r.risk_flag is null,
    format('reported: %s', row_to_json(r));
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, date '2026-10-20', 'am', false, 6, 50, date '2026-11-20', true, null,
    timestamptz '2026-10-20 13:30:00+00');
  assert r.risk = 50 and r.implied_move is null and r.risk_flag is null,
    format('am clock passed: %s', row_to_json(r));

  -- A passed report with no straddle is the line, and it is not flagged.
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, date '2026-10-20', 'am', false, null, null, null, true, null,
    timestamptz '2026-10-20 13:30:00+00');
  assert r.risk = 50 and r.implied_move is null and r.risk_flag is null,
    format('passed, no straddle: %s', row_to_json(r));

  -- Missing option data before the report: line distance, flagged.
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, date '2026-10-20', 'am', false, null, null, null, true, 'implied_move_missing',
    timestamptz '2026-10-20 13:00:00+00');
  assert r.risk = 50 and r.implied_move is null and r.risk_flag = 'implied_move_missing',
    format('missing quotes: %s', row_to_json(r));
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, null, null, false, null, null, null, false, null,
    timestamptz '2026-10-19 16:00:00+00');
  assert r.risk = 50 and r.risk_flag = 'implied_move_missing',
    format('no observation: %s', row_to_json(r));

  -- A checked calendar with no pending report is the line and is not flagged.
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, null, null, false, null, null, null, true, null,
    timestamptz '2026-10-19 16:00:00+00');
  assert r.risk = 50 and r.implied_move is null and r.risk_flag is null,
    format('no pending report: %s', row_to_json(r));

  -- Release clock, America/New_York (EDT in October 2026).
  assert not private.equity_report_passed(date '2026-10-20', 'am', false, timestamptz '2026-10-20 13:00:00+00'),
    '09:00 ET am is still pending';
  assert private.equity_report_passed(date '2026-10-20', 'am', false, timestamptz '2026-10-20 13:30:00+00'),
    '09:30 ET am is out';
  assert not private.equity_report_passed(date '2026-10-21', 'pm', false, timestamptz '2026-10-21 23:59:00+00'),
    '19:59 ET pm is still pending';
  assert private.equity_report_passed(date '2026-10-21', 'pm', false, timestamptz '2026-10-22 00:00:00+00'),
    '20:00 ET pm is out';
  assert private.equity_report_passed(date '2026-10-20', null, false, timestamptz '2026-10-21 03:59:00+00') = false,
    'no timing is pending until the next midnight ET';
  assert private.equity_report_passed(date '2026-10-20', null, false, timestamptz '2026-10-21 04:00:00+00') = true,
    'no timing is out at the next midnight ET';
  -- A null return here used to read as "not pending", so a real straddle was ignored.
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, date '2026-10-20', null, false, 6, 50, date '2026-11-20', true, null,
    timestamptz '2026-10-21 03:59:00+00');
  assert r.risk = 60 and r.implied_move = 60 and r.risk_flag is null,
    format('untimed still pending uses the max: %s', row_to_json(r));
  select * into r from private.equity_lot_open_risk(
    10, 50, 45, date '2026-10-20', null, false, 6, 50, date '2026-11-20', true, null,
    timestamptz '2026-10-21 04:00:00+00');
  assert r.risk = 50 and r.implied_move is null and r.risk_flag is null,
    format('untimed after midnight is the line: %s', row_to_json(r));
end $$;
