-- ODDSBORNE wrote pm_* (marks, notes, pnl) without bumping desk_agents.heartbeat_at.
-- Bandit already had a heartbeat UPDATE grant; Oddsborne did not. Pair the grant
-- with a statement trigger so a later pm_* write cannot leave Team/Book looking
-- idle while Predictions rows are newer.

grant select on public.desk_agents to oddsborne_worker;
grant update (heartbeat_at, updated_at) on public.desk_agents to oddsborne_worker;

drop policy if exists oddsborne_worker_desk_agents_select on public.desk_agents;
create policy oddsborne_worker_desk_agents_select on public.desk_agents
  for select to oddsborne_worker using (true);

drop policy if exists oddsborne_worker_desk_agents_update on public.desk_agents;
create policy oddsborne_worker_desk_agents_update on public.desk_agents
  for update to oddsborne_worker
  using (slug = 'oddsborne')
  with check (slug = 'oddsborne');

create or replace function public.touch_oddsborne_heartbeat()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.desk_agents
  set heartbeat_at = greatest(coalesce(heartbeat_at, '-infinity'::timestamptz), now()),
      updated_at = now()
  where slug = 'oddsborne';
  return null;
end;
$$;

revoke all on function public.touch_oddsborne_heartbeat() from public, anon;
grant execute on function public.touch_oddsborne_heartbeat() to oddsborne_worker, service_role;

drop trigger if exists pm_markets_touch_oddsborne on public.pm_markets;
create trigger pm_markets_touch_oddsborne
after insert or update on public.pm_markets
for each statement execute function public.touch_oddsborne_heartbeat();

drop trigger if exists pm_positions_touch_oddsborne on public.pm_positions;
create trigger pm_positions_touch_oddsborne
after insert or update on public.pm_positions
for each statement execute function public.touch_oddsborne_heartbeat();

drop trigger if exists pm_fills_touch_oddsborne on public.pm_fills;
create trigger pm_fills_touch_oddsborne
after insert or update on public.pm_fills
for each statement execute function public.touch_oddsborne_heartbeat();

drop trigger if exists pm_pnl_touch_oddsborne on public.pm_pnl;
create trigger pm_pnl_touch_oddsborne
after insert or update on public.pm_pnl
for each statement execute function public.touch_oddsborne_heartbeat();

drop trigger if exists pm_notes_touch_oddsborne on public.pm_notes;
create trigger pm_notes_touch_oddsborne
after insert or update on public.pm_notes
for each statement execute function public.touch_oddsborne_heartbeat();

update public.desk_agents as agent
set
  heartbeat_at = greatest(
    coalesce(agent.heartbeat_at, '-infinity'::timestamptz),
    coalesce((select max(as_of) from public.pm_pnl), '-infinity'::timestamptz),
    coalesce((select max(mark_at) from public.pm_positions), '-infinity'::timestamptz),
    coalesce((select max(last_marked_at) from public.pm_markets), '-infinity'::timestamptz),
    coalesce((select max(executed_at) from public.pm_fills), '-infinity'::timestamptz),
    coalesce((select max(created_at) from public.pm_notes), '-infinity'::timestamptz)
  ),
  updated_at = now()
where agent.slug = 'oddsborne'
  and greatest(
    coalesce(agent.heartbeat_at, '-infinity'::timestamptz),
    coalesce((select max(as_of) from public.pm_pnl), '-infinity'::timestamptz),
    coalesce((select max(mark_at) from public.pm_positions), '-infinity'::timestamptz),
    coalesce((select max(last_marked_at) from public.pm_markets), '-infinity'::timestamptz),
    coalesce((select max(executed_at) from public.pm_fills), '-infinity'::timestamptz),
    coalesce((select max(created_at) from public.pm_notes), '-infinity'::timestamptz)
  ) > '-infinity'::timestamptz;
