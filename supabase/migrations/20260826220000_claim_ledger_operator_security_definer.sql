-- public.claim_ledger_operator ran as authenticated (SECURITY INVOKER) and
-- called into schema private. That role has no USAGE on private, so every
-- desk load failed with "permission denied for schema private" and the gate
-- showed "not on the operator allowlist" even for the claimed operator.

create or replace function public.claim_ledger_operator()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.claim_first_ledger_operator();
$$;
revoke all on function public.claim_ledger_operator() from public, anon;
grant execute on function public.claim_ledger_operator() to authenticated, service_role;

revoke all on function private.claim_first_ledger_operator() from public, anon, authenticated;
grant execute on function private.claim_first_ledger_operator() to service_role;
