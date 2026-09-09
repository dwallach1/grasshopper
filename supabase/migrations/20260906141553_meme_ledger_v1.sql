-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
--
-- thesis_domains / belief_updates existed on the hosted ledger before this
-- version (out of band; never recorded in schema_migrations). Snapshot them
-- here so a fresh Preview replay can satisfy the GRANTs below. IF NOT EXISTS
-- is a no-op on Quantanamo.

create table if not exists public.thesis_domains (
  thesis_id text not null references public.theses(id) on delete cascade,
  domain_id uuid not null references public.desk_domains(id) on delete cascade,
  primary key (thesis_id, domain_id)
);

create table if not exists public.belief_updates (
  id uuid primary key default gen_random_uuid(),
  thesis_id text not null references public.theses(id) on delete cascade,
  domain_id uuid references public.desk_domains(id) on delete set null,
  agent_id uuid references public.desk_agents(id) on delete set null,
  event_id bigint references public.research_events(id) on delete set null,
  prior_confidence numeric,
  new_confidence numeric,
  rationale text not null default '',
  observed_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists belief_updates_thesis_observed_idx
  on public.belief_updates (thesis_id, observed_at desc);

alter table public.thesis_domains enable row level security;
alter table public.belief_updates enable row level security;

drop policy if exists thesis_domains_select on public.thesis_domains;
create policy thesis_domains_select on public.thesis_domains
  for select to authenticated using (true);

drop policy if exists belief_updates_select on public.belief_updates;
create policy belief_updates_select on public.belief_updates
  for select to authenticated using (true);

drop policy if exists belief_updates_worker_insert on public.belief_updates;
create policy belief_updates_worker_insert on public.belief_updates
  for insert to authenticated with check (true);

grant select on public.thesis_domains, public.belief_updates to authenticated;
grant all on public.thesis_domains, public.belief_updates to service_role;

-- BANDIT meme-coin ledger v1 (domain-named meme_*, not bandit_*).
-- Password for bandit_worker set out of band after create.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bandit_worker') then
    create role bandit_worker
      login
      noinherit
      nobypassrls;
  end if;
end $$;

create table if not exists public.meme_tokens (
  id uuid primary key default gen_random_uuid(),
  venue text not null check (venue in ('pumpfun', 'pumpswap', 'jupiter', 'raydium', 'other')),
  mint text not null,
  symbol text,
  name text,
  status text not null default 'watch'
    check (status in ('bonding', 'graduated', 'rugged', 'watch', 'dead')),
  bonding_curve_status text,
  graduated_at timestamptz,
  last_price_sol numeric,
  last_mcap_sol numeric,
  last_marked_at timestamptz,
  thesis_id text references public.theses(id) on delete set null,
  kill_criteria text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meme_tokens_mint_uniq unique (mint)
);

create unique index if not exists meme_tokens_venue_mint_uniq
  on public.meme_tokens (venue, mint);

create table if not exists public.meme_orders (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.meme_tokens(id) on delete restrict,
  account_key text not null,
  thesis_id text references public.theses(id) on delete set null,
  side text not null check (side in ('buy', 'sell')),
  order_type text not null default 'market'
    check (order_type in ('limit', 'market', 'fak', 'fok', 'gtc', 'gtd')),
  size_sol numeric check (size_sol is null or size_sol > 0),
  size_tokens numeric check (size_tokens is null or size_tokens > 0),
  price_sol numeric check (price_sol is null or price_sol >= 0),
  status text not null default 'draft'
    check (status in (
      'draft', 'paper', 'submitted', 'open', 'partial',
      'filled', 'cancelled', 'rejected', 'expired'
    )),
  mode text not null default 'paper' check (mode in ('paper', 'live')),
  venue_order_id text,
  signature text,
  rationale text,
  kill_criteria text,
  gate_results jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meme_orders_size_present check (size_sol is not null or size_tokens is not null)
);

create unique index if not exists meme_orders_venue_order_uniq
  on public.meme_orders (account_key, venue_order_id)
  where venue_order_id is not null;

create table if not exists public.meme_positions (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.meme_tokens(id) on delete restrict,
  account_key text not null,
  thesis_id text references public.theses(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'closed')),
  quantity numeric not null default 0,
  average_cost_sol numeric,
  mark_sol numeric,
  mark_at timestamptz,
  opened_at timestamptz,
  closed_at timestamptz,
  thesis_text text,
  kill_criteria text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists meme_positions_one_open_uniq
  on public.meme_positions (account_key, token_id)
  where status = 'open';

create table if not exists public.meme_fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.meme_orders(id) on delete restrict,
  position_id uuid references public.meme_positions(id) on delete set null,
  account_key text not null,
  venue_fill_id text not null,
  venue_order_id text,
  side text not null check (side in ('buy', 'sell')),
  quantity numeric not null check (quantity > 0),
  price_sol numeric not null check (price_sol >= 0),
  fee_sol numeric not null default 0,
  executed_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint meme_fills_venue_fill_uniq unique (account_key, venue_fill_id)
);

create table if not exists public.meme_pnl (
  id uuid primary key default gen_random_uuid(),
  account_key text not null,
  as_of timestamptz not null,
  realized numeric not null default 0,
  unrealized numeric,
  fees numeric not null default 0,
  cash_sol numeric,
  equity_sol numeric,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint meme_pnl_account_asof_uniq unique (account_key, as_of)
);

create table if not exists public.meme_notes (
  id uuid primary key default gen_random_uuid(),
  token_id uuid references public.meme_tokens(id) on delete set null,
  thesis_id text references public.theses(id) on delete set null,
  note_type text not null
    check (note_type in (
      'scan', 'skip', 'idea', 'thesis', 'kill', 'postmortem', 'lesson', 'other'
    )),
  title text not null,
  body text not null,
  decision text check (decision is null or decision in ('skip', 'watch', 'enter', 'exit', 'hold')),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meme_orders_token_idx on public.meme_orders (token_id);
create index if not exists meme_orders_account_status_idx on public.meme_orders (account_key, status);
create index if not exists meme_positions_account_status_idx on public.meme_positions (account_key, status);
create index if not exists meme_fills_order_idx on public.meme_fills (order_id);
create index if not exists meme_notes_token_idx on public.meme_notes (token_id);
create index if not exists meme_notes_created_idx on public.meme_notes (created_at desc);
create index if not exists meme_tokens_status_idx on public.meme_tokens (status);

alter table public.meme_tokens enable row level security;
alter table public.meme_orders enable row level security;
alter table public.meme_positions enable row level security;
alter table public.meme_fills enable row level security;
alter table public.meme_pnl enable row level security;
alter table public.meme_notes enable row level security;

-- Operator / authenticated desk read
drop policy if exists ledger_operator_select on public.meme_tokens;
create policy ledger_operator_select on public.meme_tokens for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists ledger_operator_select on public.meme_orders;
create policy ledger_operator_select on public.meme_orders for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists ledger_operator_select on public.meme_positions;
create policy ledger_operator_select on public.meme_positions for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists ledger_operator_select on public.meme_fills;
create policy ledger_operator_select on public.meme_fills for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists ledger_operator_select on public.meme_pnl;
create policy ledger_operator_select on public.meme_pnl for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists ledger_operator_select on public.meme_notes;
create policy ledger_operator_select on public.meme_notes for select to authenticated using ((select public.is_ledger_operator()));

-- bandit_worker CRUD (no DELETE)
drop policy if exists bandit_worker_select on public.meme_tokens;
create policy bandit_worker_select on public.meme_tokens for select to bandit_worker using (true);
drop policy if exists bandit_worker_insert on public.meme_tokens;
create policy bandit_worker_insert on public.meme_tokens for insert to bandit_worker with check (true);
drop policy if exists bandit_worker_update on public.meme_tokens;
create policy bandit_worker_update on public.meme_tokens for update to bandit_worker using (true) with check (true);

drop policy if exists bandit_worker_select on public.meme_orders;
create policy bandit_worker_select on public.meme_orders for select to bandit_worker using (true);
drop policy if exists bandit_worker_insert on public.meme_orders;
create policy bandit_worker_insert on public.meme_orders for insert to bandit_worker with check (true);
drop policy if exists bandit_worker_update on public.meme_orders;
create policy bandit_worker_update on public.meme_orders for update to bandit_worker using (true) with check (true);

drop policy if exists bandit_worker_select on public.meme_positions;
create policy bandit_worker_select on public.meme_positions for select to bandit_worker using (true);
drop policy if exists bandit_worker_insert on public.meme_positions;
create policy bandit_worker_insert on public.meme_positions for insert to bandit_worker with check (true);
drop policy if exists bandit_worker_update on public.meme_positions;
create policy bandit_worker_update on public.meme_positions for update to bandit_worker using (true) with check (true);

drop policy if exists bandit_worker_select on public.meme_fills;
create policy bandit_worker_select on public.meme_fills for select to bandit_worker using (true);
drop policy if exists bandit_worker_insert on public.meme_fills;
create policy bandit_worker_insert on public.meme_fills for insert to bandit_worker with check (true);
drop policy if exists bandit_worker_update on public.meme_fills;
create policy bandit_worker_update on public.meme_fills for update to bandit_worker using (true) with check (true);

drop policy if exists bandit_worker_select on public.meme_pnl;
create policy bandit_worker_select on public.meme_pnl for select to bandit_worker using (true);
drop policy if exists bandit_worker_insert on public.meme_pnl;
create policy bandit_worker_insert on public.meme_pnl for insert to bandit_worker with check (true);
drop policy if exists bandit_worker_update on public.meme_pnl;
create policy bandit_worker_update on public.meme_pnl for update to bandit_worker using (true) with check (true);

drop policy if exists bandit_worker_select on public.meme_notes;
create policy bandit_worker_select on public.meme_notes for select to bandit_worker using (true);
drop policy if exists bandit_worker_insert on public.meme_notes;
create policy bandit_worker_insert on public.meme_notes for insert to bandit_worker with check (true);
drop policy if exists bandit_worker_update on public.meme_notes;
create policy bandit_worker_update on public.meme_notes for update to bandit_worker using (true) with check (true);

grant usage on schema public to bandit_worker;
grant select, insert, update on public.meme_tokens to bandit_worker;
grant select, insert, update on public.meme_orders to bandit_worker;
grant select, insert, update on public.meme_positions to bandit_worker;
grant select, insert, update on public.meme_fills to bandit_worker;
grant select, insert, update on public.meme_pnl to bandit_worker;
grant select, insert, update on public.meme_notes to bandit_worker;
grant select on public.theses, public.thesis_domains, public.belief_updates to bandit_worker;
grant select on public.desk_domains, public.desk_agents, public.desk_domain_stewards, public.desk_accounts to bandit_worker;
grant insert on public.belief_updates, public.thesis_domains to bandit_worker;
grant update (status, heartbeat_at, updated_at, meta) on public.desk_agents to bandit_worker;

grant select on public.meme_tokens, public.meme_orders, public.meme_positions, public.meme_fills, public.meme_pnl, public.meme_notes to authenticated;
grant select on public.meme_tokens, public.meme_orders, public.meme_positions, public.meme_fills, public.meme_pnl, public.meme_notes to quantanamo_worker;

-- Bridge account to meme domain
insert into public.desk_accounts (domain_id, account_key, label, currency, meta)
select d.id,
  'solana-bandit-primary',
  'Solana BANDIT primary',
  'SOL',
  jsonb_build_object(
    'wallet_pubkey', '3AKSqcwDwuH1CPC9ZBN6S8ajGjjeFUyqmaUiyxPFKRFG',
    'venues', jsonb_build_array('pumpfun', 'pumpswap', 'jupiter'),
    'rpc', 'helius',
    'bankroll_sol_start', 2
  )
from public.desk_domains d
where d.slug = 'meme'
on conflict (account_key) do update set
  domain_id = excluded.domain_id,
  label = excluded.label,
  currency = excluded.currency,
  meta = excluded.meta,
  updated_at = now();
