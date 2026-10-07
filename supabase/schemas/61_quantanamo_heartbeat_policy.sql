-- quantanamo_worker had UPDATE (heartbeat_at, updated_at) on desk_agents but no RLS policy there (it is not
-- in `authenticated`), so quantanamo_touch_heartbeat(p jsonb) from 60 matched no row and returned null.
-- Same shape as the bandit/oddsborne policies: read all rows, update only its own.

create policy quantanamo_worker_desk_agents_select on public.desk_agents
  for select to quantanamo_worker using (true);

create policy quantanamo_worker_desk_agents_update on public.desk_agents
  for update to quantanamo_worker using (slug = 'quantanamo') with check (slug = 'quantanamo');
