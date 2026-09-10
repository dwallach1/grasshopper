-- Oddsborne's worker UPDATE on desk_agents returned null (empty representation).
-- The statement trigger `touch_oddsborne_heartbeat` is RETURNS TRIGGER — a
-- PostgREST rpc() of that name also returns null even when the row moved.
-- Give the worker a callable invoker RPC plus Bandit-parity column grants
-- so a heartbeat does not depend on GRASSHOPPER.

grant select on public.desk_agents to oddsborne_worker;
grant update (status, heartbeat_at, updated_at, meta) on public.desk_agents to oddsborne_worker;

drop policy if exists oddsborne_worker_desk_agents_select on public.desk_agents;
create policy oddsborne_worker_desk_agents_select on public.desk_agents
  for select to oddsborne_worker using (true);

drop policy if exists oddsborne_worker_desk_agents_update on public.desk_agents;
create policy oddsborne_worker_desk_agents_update on public.desk_agents
  for update to oddsborne_worker
  using (slug = 'oddsborne')
  with check (slug = 'oddsborne');

create or replace function public.oddsborne_touch_heartbeat()
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  touched timestamptz;
begin
  update public.desk_agents
  set heartbeat_at = now(),
      updated_at = now()
  where slug = 'oddsborne'
  returning heartbeat_at into touched;
  return touched;
end;
$$;

revoke all on function public.oddsborne_touch_heartbeat() from public, anon;
grant execute on function public.oddsborne_touch_heartbeat() to oddsborne_worker, service_role;

comment on function public.oddsborne_touch_heartbeat() is
  'Oddsborne worker heartbeat. Call this RPC — do not rpc touch_oddsborne_heartbeat (trigger, returns null).';
