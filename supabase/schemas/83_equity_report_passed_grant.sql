-- Capture the live grant equity_report_passed_grant (20261019210442).
--
-- private.equity_report_passed is security invoker. quantanamo_worker calls it
-- from steward_record_equity_earnings_score and steward_earnings_score_pending.
-- USAGE on schema private was already granted; this repeats it. GRANT is idempotent.

grant usage on schema private to quantanamo_worker;

grant execute on function private.equity_report_passed(date, text, boolean, timestamptz)
  to quantanamo_worker;
