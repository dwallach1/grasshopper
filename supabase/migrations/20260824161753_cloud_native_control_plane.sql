-- Canonical cloud-run and broker-intent audit state. Cloudflare Durable Objects
-- coordinate work, but Supabase remains the durable source of truth.

create table public.cloud_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_key text not null unique,
  trigger_source text not null check (trigger_source in ('schedule', 'manual', 'event', 'replay')),
  market_slot text,
  mode text not null default 'shadow' check (mode in ('shadow', 'read_only', 'live')),
  status text not null default 'queued' check (status in ('queued', 'running', 'complete', 'skipped', 'failed')),
  scheduled_for timestamptz,
  actionable_window boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_cloud_runs_status_scheduled on public.cloud_runs(status, scheduled_for desc);

create table public.cloud_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.cloud_runs(id) on delete cascade,
  idempotency_key text not null unique,
  task_type text not null,
  entity_type text,
  entity_key text,
  status text not null default 'queued' check (status in ('queued', 'running', 'complete', 'skipped', 'failed', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  prompt_version text,
  input_sha256 text,
  output jsonb,
  ai_gateway_log_id text,
  error_text text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index idx_cloud_tasks_run_status on public.cloud_tasks(run_id, status);
create index idx_cloud_tasks_entity on public.cloud_tasks(entity_type, entity_key, queued_at desc);

create table public.position_episodes (
  id uuid primary key default gen_random_uuid(),
  account_key text not null,
  symbol text not null references public.symbols(symbol),
  broker_position_id text,
  status text not null default 'open' check (status in ('proposed', 'open', 'closing', 'closed', 'cancelled')),
  quantity numeric(28, 10) not null default 0,
  average_cost numeric(20, 6),
  opened_at timestamptz,
  closed_at timestamptz,
  next_review_at timestamptz,
  monitor_policy jsonb not null default '{}'::jsonb,
  last_recommendation jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index idx_position_episodes_one_open
  on public.position_episodes(account_key, symbol)
  where status in ('proposed', 'open', 'closing');
create index idx_position_episodes_review on public.position_episodes(next_review_at)
  where status = 'open';

create table public.position_monitor_events (
  id bigint generated always as identity primary key,
  position_episode_id uuid not null references public.position_episodes(id) on delete cascade,
  cloud_task_id uuid references public.cloud_tasks(id) on delete set null,
  event_type text not null,
  recommendation text check (recommendation is null or recommendation in ('hold', 'add', 'reduce', 'exit', 'insufficient_data')),
  evidence jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index idx_position_monitor_event_task
  on public.position_monitor_events(cloud_task_id)
  where cloud_task_id is not null;
create index idx_position_monitor_events_episode
  on public.position_monitor_events(position_episode_id, observed_at desc);

create table public.trade_intents (
  id uuid primary key default gen_random_uuid(),
  trade_proposal_id bigint references public.trade_proposals(id) on delete set null,
  position_episode_id uuid references public.position_episodes(id) on delete set null,
  account_key text not null,
  broker_ref_id uuid not null unique,
  mode text not null default 'shadow' check (mode in ('shadow', 'live')),
  status text not null default 'draft' check (status in (
    'draft', 'gated', 'awaiting_confirmation', 'confirmed', 'submitting',
    'submitted', 'partially_filled', 'filled', 'cancelled', 'rejected', 'blocked'
  )),
  symbol text not null references public.symbols(symbol),
  side text not null check (side in ('buy', 'sell')),
  notional numeric(20, 4) check (notional is null or notional >= 0),
  quantity numeric(28, 10) check (quantity is null or quantity >= 0),
  order_type text not null,
  time_in_force text not null,
  account_snapshot_id bigint references public.account_snapshots(id) on delete restrict,
  policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  gate_results jsonb not null default '{}'::jsonb,
  review_payload jsonb,
  reviewed_quote_at timestamptz,
  confirmation_actor text,
  confirmed_at timestamptz,
  broker_order_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_trade_intents_status_created on public.trade_intents(status, created_at desc);
create index idx_trade_intents_account_status on public.trade_intents(account_key, status);

create table public.broker_execution_attempts (
  id uuid primary key default gen_random_uuid(),
  trade_intent_id uuid not null references public.trade_intents(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  request_fingerprint text not null,
  status text not null check (status in ('started', 'succeeded', 'failed', 'reconciled')),
  broker_order_id text,
  response_payload jsonb,
  error_text text,
  started_at timestamptz not null,
  completed_at timestamptz,
  unique (trade_intent_id, attempt_number),
  unique (trade_intent_id, request_fingerprint)
);

create table public.broker_fills (
  id uuid primary key default gen_random_uuid(),
  trade_intent_id uuid not null references public.trade_intents(id) on delete cascade,
  broker_fill_id text not null unique,
  broker_order_id text not null,
  quantity numeric(28, 10) not null check (quantity > 0),
  price numeric(20, 6) not null check (price >= 0),
  executed_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_broker_fills_intent on public.broker_fills(trade_intent_id, executed_at);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'cloud_runs', 'cloud_tasks', 'position_episodes', 'position_monitor_events',
    'trade_intents', 'broker_execution_attempts', 'broker_fills'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
  end loop;
end $$;

grant usage, select on all sequences in schema public to service_role;
;
