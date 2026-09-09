-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
-- ODDSBORNE prediction-market ledger v1
-- Project: xqungxapqicdmboniezz (Quantanamo)
-- Review: QUANTANAMO before apply. Do NOT widen quantanamo_worker.
-- Password for oddsborne_worker is NOT set here — set out of band after create.

-- 1) Worker role (login, no RLS bypass, no inherit)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'oddsborne_worker') then
    create role oddsborne_worker
      login
      noinherit
      nobypassrls;
  end if;
end $$;

-- 2) Tables (public pm_* only; no equity table touches)

create table if not exists public.pm_markets (
  id uuid primary key default gen_random_uuid(),
  venue text not null check (venue in ('polymarket', 'robinhood_events', 'kalshi', 'other')),
  condition_id text,
  slug text,
  question text not null,
  status text not null default 'open'
    check (status in ('open', 'closed', 'resolved', 'cancelled', 'watch')),
  close_time timestamptz,
  yes_token_id text,
  no_token_id text,
  last_yes numeric,
  last_no numeric,
  last_marked_at timestamptz,
  resolution_outcome text check (resolution_outcome is null or resolution_outcome in ('yes', 'no', 'unknown')),
  thesis_id text references public.theses(id) on delete set null,
  rules_summary text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pm_markets_venue_condition_uniq unique (venue, condition_id),
  constraint pm_markets_venue_slug_uniq unique (venue, slug)
);

create table if not exists public.pm_orders (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.pm_markets(id) on delete restrict,
  account_key text not null,
  thesis_id text references public.theses(id) on delete set null,
  outcome text not null check (outcome in ('yes', 'no')),
  side text not null check (side in ('buy', 'sell')),
  order_type text not null default 'limit'
    check (order_type in ('limit', 'market', 'fak', 'fok', 'gtc', 'gtd')),
  size numeric not null check (size > 0),
  price numeric check (price is null or (price >= 0 and price <= 1)),
  status text not null default 'draft'
    check (status in (
      'draft', 'paper', 'submitted', 'open', 'partial',
      'filled', 'cancelled', 'rejected', 'expired'
    )),
  mode text not null default 'paper' check (mode in ('paper', 'live')),
  venue_order_id text,
  rationale text,
  kill_criteria text,
  my_probability numeric check (my_probability is null or (my_probability >= 0 and my_probability <= 1)),
  book_probability numeric check (book_probability is null or (book_probability >= 0 and book_probability <= 1)),
  edge_after_costs numeric,
  gate_results jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pm_orders_venue_order_uniq
  on public.pm_orders (account_key, venue_order_id)
  where venue_order_id is not null;

create table if not exists public.pm_positions (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.pm_markets(id) on delete restrict,
  account_key text not null,
  thesis_id text references public.theses(id) on delete set null,
  outcome text not null check (outcome in ('yes', 'no')),
  status text not null default 'open' check (status in ('open', 'closed')),
  quantity numeric not null default 0,
  average_cost numeric,
  mark numeric,
  mark_at timestamptz,
  opened_at timestamptz,
  closed_at timestamptz,
  thesis_text text,
  kill_criteria text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pm_positions_one_open_uniq
  on public.pm_positions (account_key, market_id, outcome)
  where status = 'open';

create table if not exists public.pm_fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.pm_orders(id) on delete restrict,
  position_id uuid references public.pm_positions(id) on delete set null,
  account_key text not null,
  venue_fill_id text not null,
  venue_order_id text,
  outcome text not null check (outcome in ('yes', 'no')),
  side text not null check (side in ('buy', 'sell')),
  quantity numeric not null check (quantity > 0),
  price numeric not null check (price >= 0 and price <= 1),
  fee numeric not null default 0,
  executed_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint pm_fills_venue_fill_uniq unique (account_key, venue_fill_id)
);

create table if not exists public.pm_pnl (
  id uuid primary key default gen_random_uuid(),
  account_key text not null,
  as_of timestamptz not null,
  realized numeric not null default 0,
  unrealized numeric,
  fees numeric not null default 0,
  cash numeric,
  equity numeric,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint pm_pnl_account_asof_uniq unique (account_key, as_of)
);

-- Freeform research / skips / ideas (not public.insights / predictions)
create table if not exists public.pm_notes (
  id uuid primary key default gen_random_uuid(),
  market_id uuid references public.pm_markets(id) on delete set null,
  thesis_id text references public.theses(id) on delete set null,
  note_type text not null
    check (note_type in (
      'scan', 'skip', 'idea', 'thesis', 'kill', 'postmortem', 'lesson', 'other'
    )),
  title text not null,
  body text not null,
  my_probability numeric check (my_probability is null or (my_probability >= 0 and my_probability <= 1)),
  book_probability numeric check (book_probability is null or (book_probability >= 0 and book_probability <= 1)),
  decision text check (decision is null or decision in ('skip', 'watch', 'enter', 'exit', 'hold')),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pm_orders_market_idx on public.pm_orders (market_id);
create index if not exists pm_orders_account_status_idx on public.pm_orders (account_key, status);
create index if not exists pm_positions_account_status_idx on public.pm_positions (account_key, status);
create index if not exists pm_fills_order_idx on public.pm_fills (order_id);
create index if not exists pm_notes_market_idx on public.pm_notes (market_id);
create index if not exists pm_notes_created_idx on public.pm_notes (created_at desc);

-- 3) RLS
alter table public.pm_markets enable row level security;
alter table public.pm_orders enable row level security;
alter table public.pm_positions enable row level security;
alter table public.pm_fills enable row level security;
alter table public.pm_pnl enable row level security;
alter table public.pm_notes enable row level security;

-- Operator read (desk)
drop policy if exists ledger_operator_select on public.pm_markets;
create policy ledger_operator_select on public.pm_markets
  for select to authenticated
  using ((select public.is_ledger_operator()));

drop policy if exists ledger_operator_select on public.pm_orders;
create policy ledger_operator_select on public.pm_orders
  for select to authenticated
  using ((select public.is_ledger_operator()));

drop policy if exists ledger_operator_select on public.pm_positions;
create policy ledger_operator_select on public.pm_positions
  for select to authenticated
  using ((select public.is_ledger_operator()));

drop policy if exists ledger_operator_select on public.pm_fills;
create policy ledger_operator_select on public.pm_fills
  for select to authenticated
  using ((select public.is_ledger_operator()));

drop policy if exists ledger_operator_select on public.pm_pnl;
create policy ledger_operator_select on public.pm_pnl
  for select to authenticated
  using ((select public.is_ledger_operator()));

drop policy if exists ledger_operator_select on public.pm_notes;
create policy ledger_operator_select on public.pm_notes
  for select to authenticated
  using ((select public.is_ledger_operator()));

-- Worker write + read on pm_* only
drop policy if exists oddsborne_worker_select on public.pm_markets;
create policy oddsborne_worker_select on public.pm_markets
  for select to oddsborne_worker using (true);
drop policy if exists oddsborne_worker_insert on public.pm_markets;
create policy oddsborne_worker_insert on public.pm_markets
  for insert to oddsborne_worker with check (true);
drop policy if exists oddsborne_worker_update on public.pm_markets;
create policy oddsborne_worker_update on public.pm_markets
  for update to oddsborne_worker using (true) with check (true);

drop policy if exists oddsborne_worker_select on public.pm_orders;
create policy oddsborne_worker_select on public.pm_orders
  for select to oddsborne_worker using (true);
drop policy if exists oddsborne_worker_insert on public.pm_orders;
create policy oddsborne_worker_insert on public.pm_orders
  for insert to oddsborne_worker with check (true);
drop policy if exists oddsborne_worker_update on public.pm_orders;
create policy oddsborne_worker_update on public.pm_orders
  for update to oddsborne_worker using (true) with check (true);

drop policy if exists oddsborne_worker_select on public.pm_positions;
create policy oddsborne_worker_select on public.pm_positions
  for select to oddsborne_worker using (true);
drop policy if exists oddsborne_worker_insert on public.pm_positions;
create policy oddsborne_worker_insert on public.pm_positions
  for insert to oddsborne_worker with check (true);
drop policy if exists oddsborne_worker_update on public.pm_positions;
create policy oddsborne_worker_update on public.pm_positions
  for update to oddsborne_worker using (true) with check (true);

drop policy if exists oddsborne_worker_select on public.pm_fills;
create policy oddsborne_worker_select on public.pm_fills
  for select to oddsborne_worker using (true);
drop policy if exists oddsborne_worker_insert on public.pm_fills;
create policy oddsborne_worker_insert on public.pm_fills
  for insert to oddsborne_worker with check (true);
drop policy if exists oddsborne_worker_update on public.pm_fills;
create policy oddsborne_worker_update on public.pm_fills
  for update to oddsborne_worker using (true) with check (true);

drop policy if exists oddsborne_worker_select on public.pm_pnl;
create policy oddsborne_worker_select on public.pm_pnl
  for select to oddsborne_worker using (true);
drop policy if exists oddsborne_worker_insert on public.pm_pnl;
create policy oddsborne_worker_insert on public.pm_pnl
  for insert to oddsborne_worker with check (true);
drop policy if exists oddsborne_worker_update on public.pm_pnl;
create policy oddsborne_worker_update on public.pm_pnl
  for update to oddsborne_worker using (true) with check (true);

drop policy if exists oddsborne_worker_select on public.pm_notes;
create policy oddsborne_worker_select on public.pm_notes
  for select to oddsborne_worker using (true);
drop policy if exists oddsborne_worker_insert on public.pm_notes;
create policy oddsborne_worker_insert on public.pm_notes
  for insert to oddsborne_worker with check (true);
drop policy if exists oddsborne_worker_update on public.pm_notes;
create policy oddsborne_worker_update on public.pm_notes
  for update to oddsborne_worker using (true) with check (true);

-- 4) Grants — narrow. No DELETE. No equity tables.
grant usage on schema public to oddsborne_worker;

grant select, insert, update on public.pm_markets to oddsborne_worker;
grant select, insert, update on public.pm_orders to oddsborne_worker;
grant select, insert, update on public.pm_positions to oddsborne_worker;
grant select, insert, update on public.pm_fills to oddsborne_worker;
grant select, insert, update on public.pm_pnl to oddsborne_worker;
grant select, insert, update on public.pm_notes to oddsborne_worker;

-- Optional thesis link lookups only
grant select on public.theses to oddsborne_worker;

grant select on public.pm_markets to authenticated;
grant select on public.pm_orders to authenticated;
grant select on public.pm_positions to authenticated;
grant select on public.pm_fills to authenticated;
grant select on public.pm_pnl to authenticated;
grant select on public.pm_notes to authenticated;
