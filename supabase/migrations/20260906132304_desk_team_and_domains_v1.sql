-- Applied on the live ledger as desk_team_and_domains_v1.
-- Domain-agnostic roster: Stocks / Predictions / Ledger stay if a steward rotates.

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

insert into public.desk_domains (slug, name, kind, description, accent, status, sort_order)
values
  ('ledger', 'Ledger', 'ops', 'Schema, desk, public phone view, cross-domain integrity.', '#7dd3a7', 'active', 5),
  ('equity', 'Stocks', 'trading', 'Equities / broker book. Domain stays even if the steward changes.', '#5b8def', 'active', 10),
  ('prediction', 'Predictions', 'trading', 'Prediction markets. Steward is soft-assigned.', '#c084fc', 'active', 20)
on conflict (slug) do nothing;

insert into public.desk_agents (slug, display_name, role_title, charter, accent, avatar_key, status, heartbeat_at, sort_order)
values
  (
    'grasshopper',
    'GRASSHOPPER',
    'Ledger steward',
    'Owns the shared ledger schema, desk UX, and public phone view. Keeps domains and stewards consistent — not the trader for a book.',
    '#7dd3a7',
    'grasshopper',
    'active',
    now(),
    1
  ),
  (
    'quantanamo',
    'QUANTANAMO',
    'Equities trader',
    'Research, theses, and live trades on the equity book (Robinhood). Domain: Stocks.',
    '#5b8def',
    'quant',
    'active',
    now(),
    2
  ),
  (
    'oddsborne',
    'ODDSBORNE',
    'Prediction markets trader',
    'Polymarket US and future prediction venues. Domain: Predictions — steward can rotate without a migration.',
    '#c084fc',
    'odds',
    'watching',
    now(),
    3
  )
on conflict (slug) do nothing;

insert into public.desk_domain_stewards (domain_id, agent_id, is_primary, note)
select d.id, a.id, true, 'Initial seed'
from public.desk_domains d
join public.desk_agents a
  on (d.slug = 'ledger' and a.slug = 'grasshopper')
  or (d.slug = 'equity' and a.slug = 'quantanamo')
  or (d.slug = 'prediction' and a.slug = 'oddsborne')
where not exists (
  select 1
  from public.desk_domain_stewards s
  where s.domain_id = d.id
    and s.agent_id = a.id
    and s.ended_at is null
);

insert into public.desk_accounts (domain_id, account_key, label, currency, status)
select d.id, v.account_key, v.label, 'USD', 'active'
from (
  values
    ('equity', 'robinhood_agentic_7638', 'Robinhood Agentic ···7638'),
    ('prediction', 'polymarket-us-primary', 'Polymarket US primary')
) as v(domain_slug, account_key, label)
join public.desk_domains d on d.slug = v.domain_slug
on conflict (account_key) do nothing;
