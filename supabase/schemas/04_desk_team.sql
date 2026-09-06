-- Domain-agnostic desk roster. Stewardship is a soft assignment:
-- reassign `desk_domain_stewards`, do not rename tables or domains after a person.
-- Seeded domains today: ledger, equity, prediction, meme.
-- Seeded agents today: grasshopper, quantanamo, oddsborne, bandit.
-- Browser `anon` has no privileges. Local desk reads as `authenticated`.
-- QUANTANAMO writes via the server connection. Public Worker never queries these.

create table if not exists public.desk_domains (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  kind text not null check (kind in ('trading', 'research', 'ops', 'other')),
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'paused', 'retired')),
  accent text not null default '#7dd3a7',
  sort_order integer not null default 100,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.desk_agents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  role_title text not null,
  charter text not null default '',
  accent text not null default '#7dd3a7',
  avatar_key text not null default 'spark',
  status text not null default 'active' check (status in ('active', 'idle', 'watching', 'away', 'retired')),
  heartbeat_at timestamptz,
  sort_order integer not null default 100,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.desk_domain_stewards (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references public.desk_domains(id) on delete cascade,
  agent_id uuid not null references public.desk_agents(id) on delete cascade,
  is_primary boolean not null default true,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  note text,
  unique (domain_id, agent_id, assigned_at)
);

create table if not exists public.desk_accounts (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references public.desk_domains(id) on delete restrict,
  account_key text not null unique,
  label text not null,
  currency text not null default 'USD',
  status text not null default 'active' check (status in ('active', 'paused', 'closed')),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists desk_domain_stewards_current_idx
  on public.desk_domain_stewards (domain_id)
  where ended_at is null;

alter table public.desk_domains enable row level security;
alter table public.desk_agents enable row level security;
alter table public.desk_domain_stewards enable row level security;
alter table public.desk_accounts enable row level security;

revoke all on table public.desk_domains from public, anon;
revoke all on table public.desk_agents from public, anon;
revoke all on table public.desk_domain_stewards from public, anon;
revoke all on table public.desk_accounts from public, anon;

grant select on table public.desk_domains to authenticated;
grant select on table public.desk_agents to authenticated;
grant select on table public.desk_domain_stewards to authenticated;
grant select on table public.desk_accounts to authenticated;

grant all on table public.desk_domains to service_role;
grant all on table public.desk_agents to service_role;
grant all on table public.desk_domain_stewards to service_role;
grant all on table public.desk_accounts to service_role;

drop policy if exists desk_domains_select on public.desk_domains;
create policy desk_domains_select
on public.desk_domains
for select
to authenticated
using (true);

drop policy if exists desk_agents_select on public.desk_agents;
create policy desk_agents_select
on public.desk_agents
for select
to authenticated
using (true);

drop policy if exists desk_domain_stewards_select on public.desk_domain_stewards;
create policy desk_domain_stewards_select
on public.desk_domain_stewards
for select
to authenticated
using (true);

drop policy if exists desk_accounts_select on public.desk_accounts;
create policy desk_accounts_select
on public.desk_accounts
for select
to authenticated
using (true);
