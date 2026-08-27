-- Drop the unused anon ontology write RPC (advisor 0028) and make public
-- operator RPCs SECURITY INVOKER wrappers (advisor 0029). The private helpers
-- stay SECURITY DEFINER so RLS and schema private still work for the desk.

drop function if exists public.manage_ontology_entity(text, text, text);

grant usage on schema private to authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

create or replace function private.claim_first_ledger_operator()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return false;
  end if;
  if exists (select 1 from public.ledger_operators) then
    return exists (
      select 1 from public.ledger_operators
      where user_id = (select auth.uid())
    );
  end if;
  begin
    insert into public.ledger_operators(user_id, email)
    values (
      (select auth.uid()),
      coalesce((select auth.jwt() ->> 'email'), '')
    );
  exception
    when unique_violation then
      return exists (
        select 1 from public.ledger_operators
        where user_id = (select auth.uid())
      );
  end;
  return true;
end;
$$;
revoke all on function private.claim_first_ledger_operator() from public, anon;
grant execute on function private.claim_first_ledger_operator() to authenticated, service_role;

create or replace function public.claim_ledger_operator()
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.claim_first_ledger_operator();
$$;
revoke all on function public.claim_ledger_operator() from public, anon;
grant execute on function public.claim_ledger_operator() to authenticated, service_role;

create or replace function private.is_ledger_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ledger_operators
    where user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_ledger_operator() from public, anon;
grant execute on function private.is_ledger_operator() to authenticated, service_role;

create or replace function public.is_ledger_operator()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.is_ledger_operator();
$$;
revoke all on function public.is_ledger_operator() from public, anon;
grant execute on function public.is_ledger_operator() to authenticated, service_role;
