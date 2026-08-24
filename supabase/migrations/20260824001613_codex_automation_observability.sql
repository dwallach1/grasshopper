create table public.codex_automations (
  id text primary key,
  name text not null,
  prompt text not null,
  kind text not null default 'cron',
  status text not null check (status in ('ACTIVE', 'PAUSED')),
  rrule text not null,
  model text,
  reasoning_effort text,
  execution_environment text,
  project_id text,
  working_directories jsonb not null default '[]'::jsonb,
  next_run_at timestamptz,
  last_run_at timestamptz,
  source_created_at timestamptz not null,
  source_updated_at timestamptz not null,
  indexed_at timestamptz not null default now()
);

create index idx_codex_automations_status_next_run
  on public.codex_automations(status, next_run_at);

create table public.codex_automation_runs (
  thread_id text primary key,
  automation_id text not null references public.codex_automations(id) on delete cascade,
  status text not null,
  outcome text not null check (outcome in ('running', 'passed', 'failed', 'cancelled', 'unknown')),
  started_at timestamptz not null,
  completed_at timestamptz,
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  title text,
  summary text,
  final_output text,
  findings jsonb not null default '[]'::jsonb,
  learnings jsonb not null default '[]'::jsonb,
  explored jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  timeline jsonb not null default '[]'::jsonb,
  error_text text,
  tokens_used bigint check (tokens_used is null or tokens_used >= 0),
  source_metadata jsonb not null default '{}'::jsonb,
  indexed_at timestamptz not null default now()
);

create index idx_codex_automation_runs_automation_started
  on public.codex_automation_runs(automation_id, started_at desc);
create index idx_codex_automation_runs_outcome_started
  on public.codex_automation_runs(outcome, started_at desc);

alter table public.codex_automations enable row level security;
alter table public.codex_automation_runs enable row level security;

revoke all on table public.codex_automations from anon, authenticated;
revoke all on table public.codex_automation_runs from anon, authenticated;
grant all on table public.codex_automations to service_role;
grant all on table public.codex_automation_runs to service_role;

grant select, insert, update on table public.codex_automations to thesisforge_worker;
grant select, insert, update on table public.codex_automation_runs to thesisforge_worker;

create policy thesisforge_worker_select on public.codex_automations
  for select to thesisforge_worker using (true);
create policy thesisforge_worker_insert on public.codex_automations
  for insert to thesisforge_worker with check (true);
create policy thesisforge_worker_update on public.codex_automations
  for update to thesisforge_worker using (true) with check (true);

create policy thesisforge_worker_select on public.codex_automation_runs
  for select to thesisforge_worker using (true);
create policy thesisforge_worker_insert on public.codex_automation_runs
  for insert to thesisforge_worker with check (true);
create policy thesisforge_worker_update on public.codex_automation_runs
  for update to thesisforge_worker using (true) with check (true);
