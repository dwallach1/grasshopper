-- Outcome ledger + steward scorecard (measurement only).
-- One row per closed round trip, every steward. Close-time triggers write rows
-- going forward; historical rows are backfilled in the timestamped migration.
-- Nothing here reads into trading, sizing, confidence gates, or order paths.
-- Trigger bodies swallow their own errors so a scorecard bug can never block a
-- steward's position or note write.

create schema if not exists private;

-- ——— trade_outcomes ———

create table if not exists public.trade_outcomes (
  id uuid primary key default gen_random_uuid(),
  steward text not null check (steward in ('quantanamo', 'oddsborne', 'bandit', 'cointanamo')),
  venue text not null check (venue in ('equity', 'prediction', 'meme', 'crypto')),
  account_key text not null,
  instrument text not null,
  thesis_id text,
  source_table text not null
    check (source_table in ('position_episodes', 'pm_positions', 'meme_positions', 'manual_backfill')),
  source_id text not null,
  opened_at timestamptz,
  closed_at timestamptz not null,
  cost numeric,
  proceeds numeric,
  -- null = not captured (unknown), never silently zero.
  fees numeric,
  -- Net of fees. Null = closed but not priced yet (counts against data quality).
  realized_pnl numeric,
  unit text not null check (unit in ('USD', 'SOL')),
  pnl_source text not null check (pnl_source in ('fills', 'cash_delta', 'settlement', 'manual')),
  confidence_at_entry numeric check (confidence_at_entry is null or confidence_at_entry between 0 and 100),
  size_pct_nav_at_entry numeric,
  edge_at_entry numeric,
  exit_reason text,
  is_paper boolean not null default false,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trade_outcomes_source_key unique (source_table, source_id)
);

comment on table public.trade_outcomes is
  'One row per closed round trip (all stewards). Measurement only; nothing reads this into sizing or gates. meta.origin = trigger | backfill.';
comment on column public.trade_outcomes.pnl_source is
  'fills = priced from venue fills; cash_delta = account cash change; settlement = market resolution payout; manual = reconstructed (see meta.basis).';

create index if not exists idx_trade_outcomes_steward_closed on public.trade_outcomes (steward, closed_at desc);
create index if not exists idx_trade_outcomes_thesis on public.trade_outcomes (thesis_id) where thesis_id is not null;

alter table public.trade_outcomes enable row level security;

revoke all on table public.trade_outcomes from public, anon, authenticated;
grant select on table public.trade_outcomes to authenticated;
grant select on table public.trade_outcomes to desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker;
grant all on table public.trade_outcomes to service_role;

drop policy if exists ledger_operator_select on public.trade_outcomes;
create policy ledger_operator_select on public.trade_outcomes
  for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists desk_public_reader_select on public.trade_outcomes;
create policy desk_public_reader_select on public.trade_outcomes
  for select to desk_public_reader using (true);
drop policy if exists steward_worker_select on public.trade_outcomes;
create policy steward_worker_select on public.trade_outcomes
  for select to quantanamo_worker, oddsborne_worker, bandit_worker using (true);

-- ——— decision_candidates ———

create table if not exists public.decision_candidates (
  id uuid primary key default gen_random_uuid(),
  steward text not null check (steward in ('quantanamo', 'oddsborne', 'bandit', 'cointanamo')),
  venue text not null check (venue in ('equity', 'prediction', 'meme', 'crypto')),
  decided_at timestamptz not null default now(),
  decision text not null check (decision in ('enter', 'skip')),
  market_id uuid references public.pm_markets(id) on delete set null,
  instrument text,
  thesis_id text,
  -- Contract the counterfactual is scored on: the edge-favored side, YES when no probability.
  side text check (side is null or side in ('yes', 'no')),
  my_probability numeric check (my_probability is null or my_probability between 0 and 1),
  book_price numeric check (book_price is null or book_price between 0 and 1),
  edge numeric,
  reason text,
  source_table text not null default 'direct' check (source_table in ('pm_notes', 'meme_notes', 'direct')),
  source_id text not null default gen_random_uuid()::text,
  resolved_outcome text check (resolved_outcome is null or resolved_outcome in ('yes', 'no', 'void')),
  resolved_at timestamptz,
  -- P/L of one contract of `side` bought at book_price. >0 on a skip = the skip cost money.
  counterfactual_pnl numeric,
  -- (my_probability - yes_outcome)^2 for the YES contract.
  brier numeric,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint decision_candidates_source_key unique (source_table, source_id)
);

comment on table public.decision_candidates is
  'Enter/skip decisions with stated probability and book price; resolver fills resolved_outcome, counterfactual_pnl, brier. Measurement only.';

create index if not exists idx_decision_candidates_market on public.decision_candidates (market_id) where market_id is not null;
create index if not exists idx_decision_candidates_steward on public.decision_candidates (steward, decided_at desc);

alter table public.decision_candidates enable row level security;

revoke all on table public.decision_candidates from public, anon, authenticated;
grant select on table public.decision_candidates to authenticated;
grant select on table public.decision_candidates to desk_public_reader;
grant select, insert on table public.decision_candidates to quantanamo_worker, oddsborne_worker, bandit_worker;
grant all on table public.decision_candidates to service_role;

drop policy if exists ledger_operator_select on public.decision_candidates;
create policy ledger_operator_select on public.decision_candidates
  for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists desk_public_reader_select on public.decision_candidates;
create policy desk_public_reader_select on public.decision_candidates
  for select to desk_public_reader using (true);
drop policy if exists steward_worker_select on public.decision_candidates;
create policy steward_worker_select on public.decision_candidates
  for select to quantanamo_worker, oddsborne_worker, bandit_worker using (true);
drop policy if exists quantanamo_worker_insert on public.decision_candidates;
create policy quantanamo_worker_insert on public.decision_candidates
  for insert to quantanamo_worker with check (steward = 'quantanamo');
drop policy if exists oddsborne_worker_insert on public.decision_candidates;
create policy oddsborne_worker_insert on public.decision_candidates
  for insert to oddsborne_worker with check (steward = 'oddsborne');
drop policy if exists bandit_worker_insert on public.decision_candidates;
create policy bandit_worker_insert on public.decision_candidates
  for insert to bandit_worker with check (steward = 'bandit');

-- ——— helpers ———

create or replace function private.try_numeric(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  return p_value::numeric;
exception when others then
  return null;
end;
$$;

-- Latest thesis_scores confidence at or before `p_at`. Null when never scored.
create or replace function private.thesis_confidence_at(p_thesis_id text, p_at timestamptz)
returns numeric
language sql
stable
set search_path = ''
as $$
  select s.confidence::numeric
  from public.thesis_scores s
  where p_thesis_id is not null
    and s.thesis_id = p_thesis_id
    and (p_at is null or s.scored_at <= p_at)
  order by s.scored_at desc, s.id desc
  limit 1;
$$;

-- Canonical desk_accounts key per venue (trade_outcomes only; source tables untouched).
create or replace function private.canonical_account_key(p_venue text, p_raw text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select a.account_key
      from public.desk_accounts a
      join public.desk_domains d on d.id = a.domain_id
      where d.slug = p_venue
        and a.status = 'active'
        and (
          a.account_key = p_raw
          or regexp_replace(lower(a.account_key), '[^a-z0-9]', '', 'g')
             like '%' || regexp_replace(lower(coalesce(p_raw, '')), '[^a-z0-9]', '', 'g')
        )
      order by (a.account_key = p_raw) desc
      limit 1
    ),
    p_raw
  );
$$;

-- ——— outcome writers (one per source table) ———

create or replace function private.trade_outcome_from_meme(p_position_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pos public.meme_positions%rowtype;
  tok public.meme_tokens%rowtype;
  existing_meta jsonb;
  buy_sol numeric;
  sell_sol numeric;
  buy_q numeric;
  sell_q numeric;
  fee_sum numeric;
  n_fills integer;
  priced boolean;
  v_fees numeric;
  v_pnl numeric;
begin
  select * into pos from public.meme_positions where id = p_position_id;
  if not found or pos.status is distinct from 'closed' then
    return;
  end if;
  select meta into existing_meta
  from public.trade_outcomes
  where source_table = 'meme_positions' and source_id = p_position_id::text;
  if found and coalesce(existing_meta->>'origin', '') <> 'trigger' then
    return;
  end if;
  select * into tok from public.meme_tokens where id = pos.token_id;

  select
    coalesce(sum(f.quantity * f.price_sol) filter (where f.side = 'buy'), 0),
    coalesce(sum(f.quantity * f.price_sol) filter (where f.side = 'sell'), 0),
    coalesce(sum(f.quantity) filter (where f.side = 'buy'), 0),
    coalesce(sum(f.quantity) filter (where f.side = 'sell'), 0),
    coalesce(sum(f.fee_sol), 0),
    count(*)
  into buy_sol, sell_sol, buy_q, sell_q, fee_sum, n_fills
  from public.meme_fills f
  where f.position_id = p_position_id;

  priced := n_fills > 0 and buy_q > 0 and abs(buy_q - sell_q) <= greatest(buy_q, 1) * 0.000001;
  v_fees := case when fee_sum > 0 then fee_sum else null end;
  v_pnl := case when priced then sell_sol - buy_sol - coalesce(v_fees, 0) else null end;

  insert into public.trade_outcomes (
    steward, venue, account_key, instrument, thesis_id, source_table, source_id,
    opened_at, closed_at, cost, proceeds, fees, realized_pnl, unit, pnl_source,
    confidence_at_entry, size_pct_nav_at_entry, edge_at_entry, exit_reason, is_paper, meta
  ) values (
    'bandit', 'meme',
    private.canonical_account_key('meme', pos.account_key),
    coalesce(tok.symbol, tok.mint, pos.token_id::text),
    nullif(btrim(coalesce(pos.thesis_id, '')), ''),
    'meme_positions', p_position_id::text,
    pos.opened_at, coalesce(pos.closed_at, now()),
    case when n_fills > 0 then buy_sol end,
    case when n_fills > 0 then sell_sol end,
    v_fees, v_pnl, 'SOL',
    case when priced then 'fills' else 'manual' end,
    private.thesis_confidence_at(nullif(btrim(coalesce(pos.thesis_id, '')), ''), pos.opened_at),
    null, null,
    nullif(coalesce(pos.meta->>'exit_reason', pos.meta->>'closed_reason', pos.meta->>'kill_reason'), ''),
    false,
    jsonb_strip_nulls(jsonb_build_object(
      'origin', 'trigger',
      'fills', n_fills,
      'fee_capture', case when fee_sum > 0 then 'fills' else 'missing' end,
      'needs_pricing', case when priced then null else true end,
      'mint', tok.mint,
      'source_account_key', pos.account_key
    ))
  )
  on conflict (source_table, source_id) do update set
    account_key = excluded.account_key,
    instrument = excluded.instrument,
    thesis_id = excluded.thesis_id,
    opened_at = excluded.opened_at,
    closed_at = excluded.closed_at,
    cost = excluded.cost,
    proceeds = excluded.proceeds,
    fees = excluded.fees,
    realized_pnl = excluded.realized_pnl,
    pnl_source = excluded.pnl_source,
    confidence_at_entry = excluded.confidence_at_entry,
    exit_reason = excluded.exit_reason,
    meta = excluded.meta,
    updated_at = now()
  where public.trade_outcomes.meta->>'origin' = 'trigger';
end;
$$;

create or replace function private.trade_outcome_from_pm(p_position_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pos public.pm_positions%rowtype;
  mkt public.pm_markets%rowtype;
  existing_meta jsonb;
  buy_cost numeric;
  buy_q numeric;
  sell_proc numeric;
  sell_q numeric;
  fee_sum numeric;
  n_fills integer;
  v_cost numeric;
  v_held numeric;
  v_payout numeric;
  v_proceeds numeric;
  v_pnl numeric;
  v_source text;
  v_edge numeric;
  resolved text;
begin
  select * into pos from public.pm_positions where id = p_position_id;
  if not found or coalesce(pos.status, '') not in ('closed', 'settled', 'resolved', 'expired') then
    return;
  end if;
  select meta into existing_meta
  from public.trade_outcomes
  where source_table = 'pm_positions' and source_id = p_position_id::text;
  if found and coalesce(existing_meta->>'origin', '') <> 'trigger' then
    return;
  end if;
  select * into mkt from public.pm_markets where id = pos.market_id;
  resolved := lower(nullif(mkt.resolution_outcome, ''));

  select
    coalesce(sum(f.quantity * f.price) filter (where f.side = 'buy'), 0),
    coalesce(sum(f.quantity) filter (where f.side = 'buy'), 0),
    coalesce(sum(f.quantity * f.price) filter (where f.side = 'sell'), 0),
    coalesce(sum(f.quantity) filter (where f.side = 'sell'), 0),
    coalesce(sum(f.fee), 0),
    count(*)
  into buy_cost, buy_q, sell_proc, sell_q, fee_sum, n_fills
  from public.pm_fills f
  where f.position_id = p_position_id;

  v_cost := case
    when buy_q > 0 then buy_cost
    else coalesce(
      private.try_numeric(pos.meta->>'cost_cash'),
      private.try_numeric(pos.meta->>'cost'),
      case when pos.quantity > 0 and pos.average_cost is not null then pos.quantity * pos.average_cost end
    )
  end;
  v_held := case
    when buy_q > 0 then buy_q - sell_q
    else coalesce(nullif(pos.quantity, 0), private.try_numeric(pos.meta->>'prior_qty'))
  end;

  if buy_q > 0 and abs(buy_q - sell_q) <= greatest(buy_q, 1) * 0.000001 then
    v_proceeds := sell_proc;
    v_source := 'fills';
  elsif resolved in ('yes', 'no') and v_cost is not null
        and (resolved is distinct from lower(pos.outcome) or v_held is not null) then
    v_payout := case when resolved = lower(pos.outcome) then v_held else 0 end;
    v_proceeds := sell_proc + v_payout;
    v_source := 'settlement';
  else
    v_proceeds := null;
    v_source := 'manual';
  end if;

  v_pnl := case
    when v_proceeds is not null and v_cost is not null
      then v_proceeds - v_cost - (case when buy_q > 0 then fee_sum else 0 end)
  end;

  select c.edge into v_edge
  from public.decision_candidates c
  where c.market_id = pos.market_id and c.decision = 'enter' and c.edge is not null
    and (pos.opened_at is null or c.decided_at <= pos.opened_at + interval '1 day')
  order by c.decided_at desc
  limit 1;

  insert into public.trade_outcomes (
    steward, venue, account_key, instrument, thesis_id, source_table, source_id,
    opened_at, closed_at, cost, proceeds, fees, realized_pnl, unit, pnl_source,
    confidence_at_entry, size_pct_nav_at_entry, edge_at_entry, exit_reason, is_paper, meta
  ) values (
    'oddsborne', 'prediction',
    private.canonical_account_key('prediction', pos.account_key),
    coalesce(mkt.slug, mkt.question, pos.market_id::text) || ' ' || upper(coalesce(pos.outcome, '')),
    nullif(btrim(coalesce(pos.thesis_id, '')), ''),
    'pm_positions', p_position_id::text,
    pos.opened_at, coalesce(pos.closed_at, now()),
    v_cost, v_proceeds,
    case when n_fills > 0 and fee_sum > 0 then fee_sum else private.try_numeric(pos.meta->>'fees') end,
    v_pnl, 'USD', v_source,
    private.thesis_confidence_at(nullif(btrim(coalesce(pos.thesis_id, '')), ''), pos.opened_at),
    null, v_edge,
    nullif(coalesce(pos.meta->>'closed_reason', pos.meta->>'exit_reason',
      case when resolved is not null then 'resolved_' || resolved end), ''),
    false,
    jsonb_strip_nulls(jsonb_build_object(
      'origin', 'trigger',
      'fills', n_fills,
      'market_slug', mkt.slug,
      'resolution', resolved,
      'needs_pricing', case when v_pnl is null then true end,
      'source_account_key', pos.account_key
    ))
  )
  on conflict (source_table, source_id) do update set
    account_key = excluded.account_key,
    instrument = excluded.instrument,
    thesis_id = excluded.thesis_id,
    opened_at = excluded.opened_at,
    closed_at = excluded.closed_at,
    cost = excluded.cost,
    proceeds = excluded.proceeds,
    fees = excluded.fees,
    realized_pnl = excluded.realized_pnl,
    pnl_source = excluded.pnl_source,
    confidence_at_entry = excluded.confidence_at_entry,
    edge_at_entry = excluded.edge_at_entry,
    exit_reason = excluded.exit_reason,
    meta = excluded.meta,
    updated_at = now()
  where public.trade_outcomes.meta->>'origin' = 'trigger';
end;
$$;

create or replace function private.trade_outcome_from_episode(p_episode_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ep public.position_episodes%rowtype;
  existing_meta jsonb;
  fill_buy numeric;
  fill_buy_q numeric;
  fill_sell numeric;
  fill_sell_q numeric;
  int_buy numeric;
  int_buy_q numeric;
  int_sell numeric;
  int_sell_q numeric;
  n_intents integer;
  n_paper integer;
  v_cost numeric;
  v_proceeds numeric;
  v_source text;
  v_basis text;
  v_nav numeric;
begin
  select * into ep from public.position_episodes where id = p_episode_id;
  if not found or ep.status is distinct from 'closed' then
    return;
  end if;
  select meta into existing_meta
  from public.trade_outcomes
  where source_table = 'position_episodes' and source_id = p_episode_id::text;
  if found and coalesce(existing_meta->>'origin', '') <> 'trigger' then
    return;
  end if;

  select
    coalesce(sum(i.notional) filter (where i.side = 'buy'), 0),
    coalesce(sum(i.quantity) filter (where i.side = 'buy'), 0),
    coalesce(sum(i.notional) filter (where i.side = 'sell'), 0),
    coalesce(sum(i.quantity) filter (where i.side = 'sell'), 0),
    count(*),
    count(*) filter (where i.mode = 'paper')
  into int_buy, int_buy_q, int_sell, int_sell_q, n_intents, n_paper
  from public.trade_intents i
  where i.position_episode_id = p_episode_id and i.status = 'filled';

  select
    coalesce(sum(f.quantity * f.price) filter (where i.side = 'buy'), 0),
    coalesce(sum(f.quantity) filter (where i.side = 'buy'), 0),
    coalesce(sum(f.quantity * f.price) filter (where i.side = 'sell'), 0),
    coalesce(sum(f.quantity) filter (where i.side = 'sell'), 0)
  into fill_buy, fill_buy_q, fill_sell, fill_sell_q
  from public.broker_fills f
  join public.trade_intents i on i.id = f.trade_intent_id
  where i.position_episode_id = p_episode_id;

  if fill_buy_q > 0 and abs(fill_buy_q - fill_sell_q) <= greatest(fill_buy_q, 1) * 0.000001 then
    v_cost := fill_buy;
    v_proceeds := fill_sell;
    v_source := 'fills';
  elsif int_buy > 0 and int_sell > 0 and abs(int_buy_q - int_sell_q) <= greatest(int_buy_q, 1) * 0.000001 then
    v_cost := int_buy;
    v_proceeds := int_sell;
    v_source := 'manual';
    v_basis := 'trade_intent_notional';
  else
    v_source := 'manual';
    v_basis := 'unpriced';
  end if;

  select s.total_value into v_nav
  from public.account_snapshots s
  where s.account_label ~* '7638'
    and s.total_value > 0
    and (ep.opened_at is null or s.observed_at <= ep.opened_at)
  order by s.observed_at desc
  limit 1;

  insert into public.trade_outcomes (
    steward, venue, account_key, instrument, thesis_id, source_table, source_id,
    opened_at, closed_at, cost, proceeds, fees, realized_pnl, unit, pnl_source,
    confidence_at_entry, size_pct_nav_at_entry, edge_at_entry, exit_reason, is_paper, meta
  ) values (
    'quantanamo', 'equity',
    private.canonical_account_key('equity', ep.account_key),
    ep.symbol,
    ep.thesis_id,
    'position_episodes', p_episode_id::text,
    ep.opened_at, coalesce(ep.closed_at, now()),
    v_cost, v_proceeds, null,
    case when v_cost is not null and v_proceeds is not null then v_proceeds - v_cost end,
    'USD', v_source,
    private.thesis_confidence_at(ep.thesis_id, ep.opened_at),
    case when v_cost is not null and v_nav > 0 then round(100 * v_cost / v_nav, 2) end,
    null,
    nullif(ep.meta->>'closed_reason', ''),
    n_intents > 0 and n_paper = n_intents,
    jsonb_strip_nulls(jsonb_build_object(
      'origin', 'trigger',
      'basis', v_basis,
      'intents', n_intents,
      'needs_pricing', case when v_cost is null or v_proceeds is null then true end,
      'source_account_key', ep.account_key
    ))
  )
  on conflict (source_table, source_id) do update set
    account_key = excluded.account_key,
    thesis_id = excluded.thesis_id,
    opened_at = excluded.opened_at,
    closed_at = excluded.closed_at,
    cost = excluded.cost,
    proceeds = excluded.proceeds,
    realized_pnl = excluded.realized_pnl,
    pnl_source = excluded.pnl_source,
    confidence_at_entry = excluded.confidence_at_entry,
    size_pct_nav_at_entry = excluded.size_pct_nav_at_entry,
    exit_reason = excluded.exit_reason,
    is_paper = excluded.is_paper,
    meta = excluded.meta,
    updated_at = now()
  where public.trade_outcomes.meta->>'origin' = 'trigger';
end;
$$;

-- One trigger function for every close/fill source. Never raises.
create or replace function private.trade_outcome_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if tg_table_name = 'meme_positions' then
      perform private.trade_outcome_from_meme(new.id);
    elsif tg_table_name = 'pm_positions' then
      perform private.trade_outcome_from_pm(new.id);
    elsif tg_table_name = 'position_episodes' then
      perform private.trade_outcome_from_episode(new.id);
    elsif tg_table_name = 'meme_fills' and new.position_id is not null then
      perform private.trade_outcome_from_meme(new.position_id);
    elsif tg_table_name = 'pm_fills' and new.position_id is not null then
      perform private.trade_outcome_from_pm(new.position_id);
    end if;
  exception when others then
    raise warning 'trade_outcome_capture(%): %', tg_table_name, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.try_numeric(text) from public, anon, authenticated;
revoke all on function private.thesis_confidence_at(text, timestamptz) from public, anon, authenticated;
revoke all on function private.canonical_account_key(text, text) from public, anon, authenticated;
revoke all on function private.trade_outcome_from_meme(uuid) from public, anon, authenticated;
revoke all on function private.trade_outcome_from_pm(uuid) from public, anon, authenticated;
revoke all on function private.trade_outcome_from_episode(uuid) from public, anon, authenticated;
revoke all on function private.trade_outcome_capture() from public, anon, authenticated;
grant execute on function private.trade_outcome_from_meme(uuid) to service_role;
grant execute on function private.trade_outcome_from_pm(uuid) to service_role;
grant execute on function private.trade_outcome_from_episode(uuid) to service_role;

drop trigger if exists trade_outcome_on_close_ins on public.meme_positions;
create trigger trade_outcome_on_close_ins
  after insert on public.meme_positions
  for each row when (new.status = 'closed')
  execute function private.trade_outcome_capture();
drop trigger if exists trade_outcome_on_close_upd on public.meme_positions;
create trigger trade_outcome_on_close_upd
  after update of status, closed_at on public.meme_positions
  for each row when (new.status = 'closed'
    and (old.status is distinct from new.status or old.closed_at is distinct from new.closed_at))
  execute function private.trade_outcome_capture();

drop trigger if exists trade_outcome_on_close_ins on public.pm_positions;
create trigger trade_outcome_on_close_ins
  after insert on public.pm_positions
  for each row when (new.status in ('closed', 'settled', 'resolved', 'expired'))
  execute function private.trade_outcome_capture();
drop trigger if exists trade_outcome_on_close_upd on public.pm_positions;
create trigger trade_outcome_on_close_upd
  after update of status, closed_at on public.pm_positions
  for each row when (new.status in ('closed', 'settled', 'resolved', 'expired')
    and (old.status is distinct from new.status or old.closed_at is distinct from new.closed_at))
  execute function private.trade_outcome_capture();

drop trigger if exists trade_outcome_on_close_ins on public.position_episodes;
create trigger trade_outcome_on_close_ins
  after insert on public.position_episodes
  for each row when (new.status = 'closed')
  execute function private.trade_outcome_capture();
drop trigger if exists trade_outcome_on_close_upd on public.position_episodes;
create trigger trade_outcome_on_close_upd
  after update of status, closed_at on public.position_episodes
  for each row when (new.status = 'closed'
    and (old.status is distinct from new.status or old.closed_at is distinct from new.closed_at))
  execute function private.trade_outcome_capture();

-- Late fills on an already-closed lot re-price trigger-origin rows.
drop trigger if exists trade_outcome_on_fill on public.meme_fills;
create trigger trade_outcome_on_fill
  after insert on public.meme_fills
  for each row when (new.position_id is not null)
  execute function private.trade_outcome_capture();
drop trigger if exists trade_outcome_on_fill on public.pm_fills;
create trigger trade_outcome_on_fill
  after insert on public.pm_fills
  for each row when (new.position_id is not null)
  execute function private.trade_outcome_capture();

-- ——— decision resolver ———

create or replace function private.score_decision_candidate(
  p_side text,
  p_my_probability numeric,
  p_book_price numeric,
  p_outcome text,
  out counterfactual_pnl numeric,
  out brier numeric
)
language sql
immutable
set search_path = ''
as $$
  select
    case
      when p_outcome not in ('yes', 'no') or p_book_price is null or p_side is null then null
      when p_side = 'yes' then (case when p_outcome = 'yes' then 1 else 0 end) - p_book_price
      else (case when p_outcome = 'no' then 1 else 0 end) - (1 - p_book_price)
    end,
    case
      when p_outcome not in ('yes', 'no') or p_my_probability is null then null
      else power(p_my_probability - (case when p_outcome = 'yes' then 1 else 0 end), 2)
    end;
$$;

-- Resolve candidates whose market has a resolution. p_market_id null = all.
create or replace function private.resolve_decision_candidates(p_market_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched integer;
begin
  with resolved as (
    select c.id,
      lower(m.resolution_outcome) as outcome,
      coalesce(m.updated_at, now()) as at,
      s.counterfactual_pnl,
      s.brier
    from public.decision_candidates c
    join public.pm_markets m on m.id = c.market_id
    cross join lateral private.score_decision_candidate(
      c.side, c.my_probability, c.book_price, lower(m.resolution_outcome)
    ) s
    where (p_market_id is null or c.market_id = p_market_id)
      and lower(coalesce(m.resolution_outcome, '')) in ('yes', 'no', 'void')
  )
  update public.decision_candidates c set
    resolved_outcome = r.outcome,
    resolved_at = coalesce(c.resolved_at, r.at),
    counterfactual_pnl = r.counterfactual_pnl,
    brier = r.brier,
    updated_at = now()
  from resolved r
  where c.id = r.id
    and (c.resolved_outcome is distinct from r.outcome
      or c.counterfactual_pnl is distinct from r.counterfactual_pnl
      or c.brier is distinct from r.brier);
  get diagnostics touched = row_count;
  return touched;
end;
$$;

-- pm_notes enter/skip → decision_candidates (forward capture). Never raises.
create or replace function private.decision_candidate_from_pm_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_side text;
begin
  begin
    if new.decision not in ('enter', 'skip') or new.note_type = 'kill' then
      return null;
    end if;
    v_side := case
      when new.my_probability is null or new.book_probability is null then 'yes'
      when new.my_probability >= new.book_probability then 'yes'
      else 'no'
    end;
    insert into public.decision_candidates (
      steward, venue, decided_at, decision, market_id, instrument, thesis_id, side,
      my_probability, book_price, edge, reason, source_table, source_id, meta
    )
    select 'oddsborne', 'prediction', new.created_at, new.decision, new.market_id,
      m.slug, nullif(btrim(coalesce(new.thesis_id, '')), ''), v_side,
      case when new.my_probability between 0 and 1 then new.my_probability end,
      case when new.book_probability between 0 and 1 then new.book_probability end,
      case when new.my_probability between 0 and 1 and new.book_probability between 0 and 1
        then new.my_probability - new.book_probability end,
      left(coalesce(new.title, new.body), 280),
      'pm_notes', new.id::text,
      jsonb_build_object('origin', 'trigger', 'note_type', new.note_type)
    from (select 1) one
    left join public.pm_markets m on m.id = new.market_id
    on conflict (source_table, source_id) do nothing;
    if new.market_id is not null then
      perform private.resolve_decision_candidates(new.market_id);
    end if;
  exception when others then
    raise warning 'decision_candidate_from_pm_note: %', sqlerrm;
  end;
  return null;
end;
$$;

create or replace function private.decision_candidates_on_resolution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.resolve_decision_candidates(new.id);
  exception when others then
    raise warning 'decision_candidates_on_resolution: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.score_decision_candidate(text, numeric, numeric, text) from public, anon, authenticated;
revoke all on function private.resolve_decision_candidates(uuid) from public, anon, authenticated;
revoke all on function private.decision_candidate_from_pm_note() from public, anon, authenticated;
revoke all on function private.decision_candidates_on_resolution() from public, anon, authenticated;
grant execute on function private.resolve_decision_candidates(uuid) to service_role;

drop trigger if exists decision_candidate_capture on public.pm_notes;
create trigger decision_candidate_capture
  after insert on public.pm_notes
  for each row when (new.decision in ('enter', 'skip'))
  execute function private.decision_candidate_from_pm_note();

drop trigger if exists decision_candidates_resolve on public.pm_markets;
create trigger decision_candidates_resolve
  after update of resolution_outcome on public.pm_markets
  for each row when (new.resolution_outcome is distinct from old.resolution_outcome
    and new.resolution_outcome is not null)
  execute function private.decision_candidates_on_resolution();

-- ——— scorecard views (security invoker; read what the caller may read) ———

create or replace view public.v_steward_scorecard
with (security_invoker = true)
as
with stewards(steward, venue, unit, sort_order) as (
  values ('quantanamo', 'equity', 'USD', 1), ('oddsborne', 'prediction', 'USD', 2), ('bandit', 'meme', 'SOL', 3)
),
o as (
  select * from public.trade_outcomes where not is_paper
),
agg as (
  select o.steward,
    count(*)::int as trades,
    count(o.realized_pnl)::int as priced_trades,
    count(*) filter (where o.realized_pnl > 0)::int as wins,
    count(*) filter (where o.realized_pnl < 0)::int as losses,
    sum(o.realized_pnl) as realized_pnl,
    avg(o.realized_pnl) filter (where o.realized_pnl > 0) as avg_win,
    avg(o.realized_pnl) filter (where o.realized_pnl < 0) as avg_loss,
    avg(o.realized_pnl) as expectancy,
    sum(o.fees) as fees_recorded,
    count(*) filter (where o.fees is null)::int as fees_missing,
    count(*) filter (where o.pnl_source = 'fills' and o.realized_pnl is not null)::int as from_fills,
    count(*) filter (where o.pnl_source = 'cash_delta')::int as from_cash_delta,
    count(*) filter (where o.pnl_source = 'settlement')::int as from_settlement,
    count(*) filter (where o.pnl_source = 'manual')::int as from_manual,
    count(*) filter (where o.realized_pnl is null)::int as unpriced,
    min(o.closed_at) as first_closed_at,
    max(o.closed_at) as last_closed_at
  from o
  group by o.steward
),
qnt_marks as (
  select e.quantity, e.average_buy_price, e.last_price, e.observed_at
  from public.portfolio_exposure e
  where e.account_last4 = '7638'
    and e.observed_at = (select max(x.observed_at) from public.portfolio_exposure x where x.account_last4 = '7638')
    and e.quantity > 0
),
unreal as (
  select 'quantanamo'::text as steward,
    count(*)::int as open_positions,
    sum(q.quantity * (q.last_price - q.average_buy_price)) as unrealized_pnl,
    max(q.observed_at) as marked_at
  from qnt_marks q
  union all
  select 'oddsborne', count(*)::int, sum(p.quantity * (p.mark - p.average_cost)), max(p.mark_at)
  from public.pm_positions p where p.status = 'open'
  union all
  select 'bandit', count(*)::int, sum(p.quantity * (p.mark_sol - p.average_cost_sol)), max(p.mark_at)
  from public.meme_positions p where p.status = 'open'
),
dec as (
  select c.steward,
    count(*) filter (where c.decision = 'skip')::int as skips_logged,
    count(*) filter (where c.decision = 'skip' and c.resolved_outcome is not null)::int as skips_resolved,
    count(*) filter (where c.decision = 'skip' and c.counterfactual_pnl is not null)::int as skips_scored,
    count(*) filter (where c.decision = 'skip' and c.counterfactual_pnl > 0)::int as skips_would_have_won,
    sum(c.counterfactual_pnl) filter (where c.decision = 'skip') as skip_counterfactual_pnl,
    count(*) filter (where c.decision = 'enter')::int as enters_logged,
    avg(c.brier) as brier_mean,
    count(c.brier)::int as brier_n
  from public.decision_candidates c
  group by c.steward
)
select
  s.steward,
  s.venue,
  s.unit,
  s.sort_order,
  coalesce(a.trades, 0) as trades,
  coalesce(a.priced_trades, 0) as priced_trades,
  coalesce(a.wins, 0) as wins,
  coalesce(a.losses, 0) as losses,
  round(a.wins::numeric / nullif(a.priced_trades, 0), 4) as hit_rate,
  a.realized_pnl,
  a.avg_win,
  a.avg_loss,
  a.expectancy,
  coalesce(a.priced_trades, 0) < 10 as thin,
  a.fees_recorded,
  coalesce(a.fees_missing, 0) as fees_missing,
  coalesce(a.from_fills, 0) as from_fills,
  coalesce(a.from_cash_delta, 0) as from_cash_delta,
  coalesce(a.from_settlement, 0) as from_settlement,
  coalesce(a.from_manual, 0) as from_manual,
  coalesce(a.unpriced, 0) as unpriced,
  coalesce(a.trades, 0) - coalesce(a.from_fills, 0) as not_from_fills,
  a.first_closed_at,
  a.last_closed_at,
  coalesce(u.open_positions, 0) as open_positions,
  case when coalesce(u.open_positions, 0) = 0 then 0 else u.unrealized_pnl end as unrealized_pnl,
  u.marked_at as unrealized_marked_at,
  coalesce(d.skips_logged, 0) as skips_logged,
  coalesce(d.skips_resolved, 0) as skips_resolved,
  coalesce(d.skips_scored, 0) as skips_scored,
  coalesce(d.skips_would_have_won, 0) as skips_would_have_won,
  d.skip_counterfactual_pnl,
  coalesce(d.enters_logged, 0) as enters_logged,
  d.brier_mean,
  coalesce(d.brier_n, 0) as brier_n
from stewards s
left join agg a on a.steward = s.steward
left join unreal u on u.steward = s.steward
left join dec d on d.steward = s.steward;

comment on view public.v_steward_scorecard is
  'Per-steward realized scorecard from trade_outcomes (live only). thin = priced_trades < 10. not_from_fills = data-quality count.';

create or replace view public.v_steward_scorecard_weekly
with (security_invoker = true)
as
with stewards(steward, unit) as (
  values ('quantanamo', 'USD'), ('oddsborne', 'USD'), ('bandit', 'SOL')
),
o as (
  select t.steward, t.realized_pnl, t.fees, t.pnl_source,
    date_trunc('week', t.closed_at at time zone 'America/Los_Angeles') as week_start
  from public.trade_outcomes t
  where not t.is_paper
),
bounds as (
  select
    coalesce(min(o.week_start), date_trunc('week', now() at time zone 'America/Los_Angeles')) as first_week,
    date_trunc('week', now() at time zone 'America/Los_Angeles') as this_week
  from o
),
weeks as (
  select generate_series(b.first_week, b.this_week, interval '1 week') as week_start, b.this_week
  from bounds b
)
select
  s.steward,
  s.unit,
  w.week_start::date as week_start,
  to_char(w.week_start, 'IYYY-"W"IW') as iso_week,
  (w.week_start = w.this_week) as is_current,
  count(o.steward)::int as trades,
  count(o.realized_pnl)::int as priced_trades,
  count(*) filter (where o.realized_pnl > 0)::int as wins,
  round((count(*) filter (where o.realized_pnl > 0))::numeric / nullif(count(o.realized_pnl), 0), 4) as hit_rate,
  coalesce(sum(o.realized_pnl), 0) as realized_pnl,
  sum(o.fees) as fees_recorded,
  count(*) filter (where o.steward is not null and (o.pnl_source <> 'fills' or o.realized_pnl is null))::int as not_from_fills
from stewards s
cross join weeks w
left join o on o.steward = s.steward and o.week_start = w.week_start
group by s.steward, s.unit, w.week_start, w.this_week;

comment on view public.v_steward_scorecard_weekly is
  'Per-steward ISO week (Monday start, America/Los_Angeles) realized P/L, trades, hit rate. Zero weeks included.';

create or replace view public.v_steward_trend
with (security_invoker = true)
as
with stewards(steward, unit) as (
  values ('quantanamo', 'USD'), ('oddsborne', 'USD'), ('bandit', 'SOL')
),
o as (
  select t.steward, t.realized_pnl,
    case
      when t.closed_at >= now() - interval '14 days' then 'recent'
      when t.closed_at >= now() - interval '28 days' then 'prior'
    end as window_name
  from public.trade_outcomes t
  where not t.is_paper and t.realized_pnl is not null
),
w as (
  select s.steward, s.unit,
    count(*) filter (where o.window_name = 'recent')::int as recent_n,
    sum(o.realized_pnl) filter (where o.window_name = 'recent') as recent_pnl,
    avg(o.realized_pnl) filter (where o.window_name = 'recent') as recent_expectancy,
    round((count(*) filter (where o.window_name = 'recent' and o.realized_pnl > 0))::numeric
      / nullif(count(*) filter (where o.window_name = 'recent'), 0), 4) as recent_hit_rate,
    count(*) filter (where o.window_name = 'prior')::int as prior_n,
    sum(o.realized_pnl) filter (where o.window_name = 'prior') as prior_pnl,
    avg(o.realized_pnl) filter (where o.window_name = 'prior') as prior_expectancy,
    round((count(*) filter (where o.window_name = 'prior' and o.realized_pnl > 0))::numeric
      / nullif(count(*) filter (where o.window_name = 'prior'), 0), 4) as prior_hit_rate
  from stewards s
  left join o on o.steward = s.steward
  group by s.steward, s.unit
)
select w.*,
  w.recent_expectancy - w.prior_expectancy as expectancy_delta,
  w.recent_hit_rate - w.prior_hit_rate as hit_rate_delta,
  (w.recent_n < 10 or w.prior_n < 10) as thin,
  case
    when w.recent_n < 10 or w.prior_n < 10 then 'thin'
    when w.recent_expectancy > w.prior_expectancy then 'improving'
    when w.recent_expectancy < w.prior_expectancy then 'worsening'
    else 'flat'
  end as direction
from w;

comment on view public.v_steward_trend is
  'Last 14 days vs the 14 before (closed_at). thin when either window has fewer than 10 priced trades.';

create or replace view public.v_thesis_scorecard
with (security_invoker = true)
as
with o as (
  select t.thesis_id, t.steward, t.unit, t.realized_pnl, t.confidence_at_entry
  from public.trade_outcomes t
  where not t.is_paper and t.thesis_id is not null
),
agg as (
  select o.thesis_id,
    min(o.steward) as steward,
    min(o.unit) as unit,
    count(*)::int as trades,
    count(o.realized_pnl)::int as priced_trades,
    count(*) filter (where o.realized_pnl > 0)::int as wins,
    sum(o.realized_pnl) as realized_pnl,
    avg(o.confidence_at_entry) as avg_confidence_at_entry
  from o
  group by o.thesis_id
)
select
  a.thesis_id,
  th.name,
  th.status,
  a.steward,
  a.unit,
  th.confidence::numeric as stated_confidence,
  a.avg_confidence_at_entry,
  a.trades,
  a.priced_trades,
  a.wins,
  a.realized_pnl,
  round(100.0 * a.wins / nullif(a.priced_trades, 0), 1) as outcome_implied_confidence,
  th.confidence - round(100.0 * a.wins / nullif(a.priced_trades, 0), 1) as confidence_gap,
  coalesce(abs(th.confidence - round(100.0 * a.wins / nullif(a.priced_trades, 0), 1)) > 15, false) as miscalibrated,
  a.priced_trades < 10 as thin
from agg a
left join public.theses th on th.id = a.thesis_id;

comment on view public.v_thesis_scorecard is
  'Stated thesis confidence vs outcome-implied (hit rate x 100). miscalibrated when |gap| > 15. thin when priced_trades < 10.';

revoke all on table public.v_steward_scorecard from public, anon, authenticated;
revoke all on table public.v_steward_scorecard_weekly from public, anon, authenticated;
revoke all on table public.v_steward_trend from public, anon, authenticated;
revoke all on table public.v_thesis_scorecard from public, anon, authenticated;
grant select on table public.v_steward_scorecard, public.v_steward_scorecard_weekly,
  public.v_steward_trend, public.v_thesis_scorecard
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— thesis_domains gaps (ledger-side only) ———

insert into public.thesis_domains (thesis_id, domain_id)
select v.thesis_id, d.id
from (values
  ('sports_devig_maker_edge', 'prediction'),
  ('meme_4h_momentum_clip', 'meme'),
  ('nfl-mia-ml-vs-sf-20260920', 'prediction')
) as v(thesis_id, domain_slug)
join public.desk_domains d on d.slug = v.domain_slug
where exists (select 1 from public.theses t where t.id = v.thesis_id)
  and not exists (
    select 1 from public.thesis_domains x where x.thesis_id = v.thesis_id and x.domain_id = d.id
  );
