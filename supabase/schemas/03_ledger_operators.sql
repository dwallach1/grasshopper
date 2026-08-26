-- Signed-in operators for the local desk. Applied incrementally via
-- supabase/migrations/20260826200000_ledger_operator_auth.sql.

create table if not exists public.ledger_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

alter table public.ledger_operators enable row level security;
revoke all on table public.ledger_operators from public, anon, authenticated;
grant all on table public.ledger_operators to service_role;
grant select on table public.ledger_operators to authenticated;

drop policy if exists ledger_operators_self_select on public.ledger_operators;
create policy ledger_operators_self_select
on public.ledger_operators
for select
to authenticated
using (user_id = (select auth.uid()));

create schema if not exists private;

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
revoke all on function private.claim_first_ledger_operator() from public, anon, authenticated;
grant execute on function private.claim_first_ledger_operator() to service_role;

-- Must be SECURITY DEFINER: `authenticated` has no USAGE on schema private, so an
-- invoker wrapper fails with "permission denied for schema private" and the desk
-- treats the operator as not allowlisted.
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

-- SECURITY DEFINER: authenticated RLS cannot see ledger_operators rows without
-- a policy, so an INVOKER exists() is always false. Empty search_path; anon revoked.
create or replace function public.is_ledger_operator()
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
revoke all on function public.is_ledger_operator() from public, anon;
grant execute on function public.is_ledger_operator() to authenticated, service_role;

do $$
declare
  target_table text;
  sequence_name text;
begin
  foreach target_table in array array[
    'theses','thesis_symbols','thesis_evidence','thesis_scores','thesis_relations','runs',
    'cloud_runs','cloud_tasks','codex_automations','catalysts','research_queue','research_lessons',
    'postmortems','research_cycles','strategy_tests','test_scenarios','backtest_artifacts','agent_runs','account_snapshots',
    'position_episodes','portfolio_exposure','trade_intents','trade_proposals','broker_fills',
    'insights','predictions','risk_controls','ontology_themes','symbols','ontology_candidates',
    'ontology_management_actions','graph_nodes'
  ]
  loop
    execute format('grant select on table public.%I to authenticated', target_table);
    execute format(
      'create policy ledger_operator_select on public.%I for select to authenticated using ((select public.is_ledger_operator()))',
      target_table
    );
  end loop;

  foreach target_table in array array['thesis_evidence','research_lessons','runs']
  loop
    execute format('grant insert on table public.%I to authenticated', target_table);
    execute format(
      'create policy ledger_operator_insert on public.%I for insert to authenticated with check ((select public.is_ledger_operator()))',
      target_table
    );
    sequence_name := pg_get_serial_sequence(format('public.%I', target_table), 'id');
    if sequence_name is not null then
      execute format('grant usage, select on sequence %s to authenticated', sequence_name);
    end if;
  end loop;

  execute 'grant update on table public.theses to authenticated';
  create policy ledger_operator_update
  on public.theses
  for update
  to authenticated
  using ((select public.is_ledger_operator()))
  with check ((select public.is_ledger_operator()));
end $$;
