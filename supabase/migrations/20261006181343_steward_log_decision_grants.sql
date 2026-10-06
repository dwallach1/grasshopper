-- Capture live grants for steward_log_decision (SECURITY INVOKER).
--
-- PR #120 added public.steward_log_decision calling private.try_numeric / resolve_*.
-- Only quantanamo_worker had USAGE on schema private, so bandit_worker and
-- oddsborne_worker got permission denied over steward-rpc. These three statements
-- were applied live; keep them in declarative schema so the next schema push
-- does not drop them. Private helpers remain revoked from anon/authenticated.

grant usage on schema private to oddsborne_worker, bandit_worker;

alter function public.steward_log_decision(jsonb) set search_path = public, private, pg_temp;

grant execute on function private.try_numeric(text) to oddsborne_worker, bandit_worker, quantanamo_worker, service_role;
