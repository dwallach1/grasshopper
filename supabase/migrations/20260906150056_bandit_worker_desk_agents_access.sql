-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
-- Fix bandit_worker heartbeat: prior policies only targeted authenticated, not bandit_worker.
grant select on public.desk_agents to bandit_worker;
grant update (status, heartbeat_at, updated_at, meta) on public.desk_agents to bandit_worker;

drop policy if exists bandit_worker_desk_agents_select on public.desk_agents;
create policy bandit_worker_desk_agents_select on public.desk_agents
  for select to bandit_worker using (true);

drop policy if exists bandit_worker_desk_agents_update on public.desk_agents;
create policy bandit_worker_desk_agents_update on public.desk_agents
  for update to bandit_worker
  using (slug = 'bandit')
  with check (slug = 'bandit');

-- Also allow select on desk_* catalog for hygiene
grant select on public.desk_domains, public.desk_domain_stewards, public.desk_accounts to bandit_worker;
drop policy if exists bandit_worker_desk_domains_select on public.desk_domains;
create policy bandit_worker_desk_domains_select on public.desk_domains for select to bandit_worker using (true);
drop policy if exists bandit_worker_desk_stewards_select on public.desk_domain_stewards;
create policy bandit_worker_desk_stewards_select on public.desk_domain_stewards for select to bandit_worker using (true);
drop policy if exists bandit_worker_desk_accounts_select on public.desk_accounts;
create policy bandit_worker_desk_accounts_select on public.desk_accounts for select to bandit_worker using (true);
