-- The edge-scaled cap in force at entry, snapshotted on the entry row.
-- 2026-09-26 (David: compare entry_over_max_stake with the cap at entry, not today's cap).
--
-- pm_orders / meme_orders / trade_intents (buys) and position_episodes (new open lots) get
-- max_stake_at_entry, max_stake_reason_at_entry, max_stake_snapshot_at. Stewards pass the
-- values steward_sizing_guidance returned (max_stake, max_stake_reason); when a row arrives
-- without them, a BEFORE INSERT trigger computes the same private.edge_max_stake the guidance
-- uses at that moment. The trigger never blocks an insert. Units: USD (QUANTANAMO, ODDSBORNE),
-- SOL (BANDIT).

alter table public.pm_orders
  add column if not exists max_stake_at_entry numeric check (max_stake_at_entry is null or max_stake_at_entry >= 0),
  add column if not exists max_stake_reason_at_entry text,
  add column if not exists max_stake_snapshot_at timestamptz;
alter table public.meme_orders
  add column if not exists max_stake_at_entry numeric check (max_stake_at_entry is null or max_stake_at_entry >= 0),
  add column if not exists max_stake_reason_at_entry text,
  add column if not exists max_stake_snapshot_at timestamptz;
alter table public.trade_intents
  add column if not exists max_stake_at_entry numeric check (max_stake_at_entry is null or max_stake_at_entry >= 0),
  add column if not exists max_stake_reason_at_entry text,
  add column if not exists max_stake_snapshot_at timestamptz;
alter table public.position_episodes
  add column if not exists max_stake_at_entry numeric check (max_stake_at_entry is null or max_stake_at_entry >= 0),
  add column if not exists max_stake_reason_at_entry text,
  add column if not exists max_stake_snapshot_at timestamptz;

comment on column public.pm_orders.max_stake_at_entry is 'Edge-scaled max_stake (USD) in force when this buy was entered (guidance or insert-time snapshot).';
comment on column public.meme_orders.max_stake_at_entry is 'Edge-scaled max_stake (SOL) in force when this buy was entered (guidance or insert-time snapshot).';
comment on column public.trade_intents.max_stake_at_entry is 'Edge-scaled max_stake (USD) in force when this buy intent was entered (guidance or insert-time snapshot).';
comment on column public.position_episodes.max_stake_at_entry is 'Edge-scaled max_stake (USD) in force when this lot was opened (guidance or insert-time snapshot).';

create or replace function private.snapshot_entry_max_stake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_steward text;
  v_thesis text;
  v_max numeric;
  v_reason text;
begin
  if new.max_stake_at_entry is not null then
    new.max_stake_snapshot_at := coalesce(new.max_stake_snapshot_at, now());
    return new;
  end if;
  if tg_table_name = 'pm_orders' then
    if new.side is distinct from 'buy' then return new; end if;
    v_steward := 'oddsborne';
    v_thesis := new.thesis_id;
  elsif tg_table_name = 'meme_orders' then
    if new.side is distinct from 'buy' then return new; end if;
    v_steward := 'bandit';
    v_thesis := new.thesis_id;
  elsif tg_table_name = 'trade_intents' then
    if new.side is distinct from 'buy' then return new; end if;
    v_steward := 'quantanamo';
    v_thesis := coalesce(
      (select e.thesis_id from public.position_episodes e where e.id = new.position_episode_id),
      (select p.thesis_id from public.trade_proposals p where p.id = new.trade_proposal_id));
  elsif tg_table_name = 'position_episodes' then
    if new.status is distinct from 'open' then return new; end if;
    v_steward := 'quantanamo';
    v_thesis := new.thesis_id;
  else
    return new;
  end if;

  select m.max_stake, m.reason into v_max, v_reason
  from private.edge_max_stake(v_steward, v_thesis,
         (select b.equity from private.steward_book_equity(v_steward) b)) m;

  new.max_stake_at_entry := v_max;
  new.max_stake_reason_at_entry := v_reason;
  new.max_stake_snapshot_at := now();
  return new;
exception when others then
  -- Measurement only: never block an entry because the snapshot failed.
  return new;
end;
$$;

revoke all on function private.snapshot_entry_max_stake() from public, anon, authenticated;

drop trigger if exists snapshot_entry_max_stake on public.pm_orders;
create trigger snapshot_entry_max_stake before insert on public.pm_orders
  for each row execute function private.snapshot_entry_max_stake();
drop trigger if exists snapshot_entry_max_stake on public.meme_orders;
create trigger snapshot_entry_max_stake before insert on public.meme_orders
  for each row execute function private.snapshot_entry_max_stake();
drop trigger if exists snapshot_entry_max_stake on public.trade_intents;
create trigger snapshot_entry_max_stake before insert on public.trade_intents
  for each row execute function private.snapshot_entry_max_stake();
drop trigger if exists snapshot_entry_max_stake on public.position_episodes;
create trigger snapshot_entry_max_stake before insert on public.position_episodes
  for each row execute function private.snapshot_entry_max_stake();

create or replace view public.v_ledger_integrity
with (security_invoker = true)
as
-- Open lots with no thesis (a steward must bind one; never inferred here).
select 'open_lot_without_thesis'::text as check_name, 'warn'::text as severity, steward, lot_table as ref_table,
       lot_id::text as ref_id, instrument,
       'open lot has no thesis_id' || coalesce(' (untagged: ' || untagged || ')', '') as detail,
       opened_at as at
from public.v_open_lot_marks where thesis_id is null
union all
-- Open lots with no ledger mark at all.
select 'open_lot_no_mark', 'warn', steward, lot_table, lot_id::text, instrument,
       'open lot has no ledger mark', opened_at
from public.v_open_lot_marks where mark is null
union all
-- Stale marks feeding decisions: equities > 4 days (weekend-safe), PM / memes > 6 hours.
select 'open_lot_stale_mark', 'warn', steward, lot_table, lot_id::text, instrument,
       format('latest mark is %s minutes old', floor(extract(epoch from (now() - mark_at)) / 60)::int), mark_at
from public.v_open_lot_marks
where mark_at is not null
  and now() - mark_at > case when lot_table = 'position_episodes' then interval '4 days' else interval '6 hours' end
union all
-- Equity lot quantity disagrees with the latest broker snapshot.
select 'lot_broker_qty_mismatch', 'error', steward, lot_table, lot_id::text, instrument,
       format('lot quantity %s vs broker %s', quantity, coalesce(broker_quantity::text, 'absent')), mark_at
from public.v_open_lot_marks
where lot_table = 'position_episodes'
  and (broker_quantity is null or abs(broker_quantity - quantity) > 0.000001)
union all
-- A broker position in the latest snapshot with no open lot (account with lots only).
select 'broker_position_without_lot', 'error', 'quantanamo', 'portfolio_exposure', px.id::text, px.symbol,
       format('broker holds %s with no open position_episodes lot', px.quantity), px.observed_at
from public.portfolio_exposure px
join (select account_last4, max(observed_at) as observed_at from public.portfolio_exposure group by account_last4) l
  on l.account_last4 = px.account_last4 and l.observed_at = px.observed_at
where px.quantity > 0
  and exists (select 1 from public.position_episodes e where right(e.account_key, 4) = px.account_last4)
  and not exists (
    select 1 from public.position_episodes e
    where right(e.account_key, 4) = px.account_last4 and e.symbol = px.symbol and e.status = 'open')
union all
-- Fills not reconciled to a lot (last 30 days).
select 'fill_without_position', 'warn', 'oddsborne', 'pm_fills', f.id::text, f.venue_fill_id,
       'pm fill has no position_id', f.executed_at
from public.pm_fills f where f.position_id is null and f.executed_at > now() - interval '30 days'
union all
select 'fill_without_position', 'warn', 'bandit', 'meme_fills', f.id::text, f.venue_fill_id,
       'meme fill has no position_id', f.executed_at
from public.meme_fills f where f.position_id is null and f.executed_at > now() - interval '30 days'
union all
-- Untagged live buys (last 30 days).
select 'buy_order_without_thesis', 'warn', 'oddsborne', 'pm_orders', o.id::text, o.venue_order_id,
       format('live %s buy has no thesis_id', o.status), o.created_at
from public.pm_orders o
where o.side = 'buy' and o.mode = 'live' and o.thesis_id is null and o.status = 'filled'
  and o.created_at > now() - interval '30 days'
  and not exists (select 1 from public.pm_fills f join public.pm_positions p on p.id = f.position_id
                  where f.order_id = o.id and p.meta ? 'untagged')
union all
select 'buy_order_without_thesis', 'warn', 'bandit', 'meme_orders', o.id::text, o.signature,
       format('live %s buy has no thesis_id', o.status), o.created_at
from public.meme_orders o
where o.side = 'buy' and o.mode = 'live' and o.thesis_id is null and o.status = 'filled'
  and o.created_at > now() - interval '30 days'
  and not exists (select 1 from public.meme_fills f join public.meme_positions p on p.id = f.position_id
                  where f.order_id = o.id and p.meta ? 'untagged')
union all
-- Broker fills not tied to an intent.
select 'broker_fill_without_intent', 'error', 'quantanamo', 'broker_fills', f.id::text, f.broker_order_id,
       'broker fill has no trade_intent_id', f.executed_at
from public.broker_fills f where f.trade_intent_id is null
union all
-- Entries that bypassed guidance: a live buy whose filled size is above the edge-scaled
-- max_stake that was in force when it was entered (max_stake_at_entry, snapshotted on the
-- order / intent / lot row at insert), plus a 10% slippage allowance. A cap that shrinks
-- later never flags an old entry. Rows without a snapshot are not judged.
select 'entry_over_max_stake', 'warn', 'oddsborne', 'pm_orders', o.id::text, o.venue_order_id,
       format('buy filled %s USD vs max_stake at entry %s USD (%s)', round(f.notional, 2),
              round(o.max_stake_at_entry, 2), coalesce(o.max_stake_reason_at_entry, 'no reason')),
       o.created_at
from public.pm_orders o
join (select order_id, sum(quantity * price) as notional from public.pm_fills where side = 'buy' group by order_id) f
  on f.order_id = o.id
where o.side = 'buy' and o.mode = 'live' and o.max_stake_at_entry is not null
  and f.notional > o.max_stake_at_entry * 1.10
union all
select 'entry_over_max_stake', 'warn', 'bandit', 'meme_orders', o.id::text, o.signature,
       format('buy filled %s SOL vs max_stake at entry %s SOL (%s)', round(f.notional, 4),
              round(o.max_stake_at_entry, 4), coalesce(o.max_stake_reason_at_entry, 'no reason')),
       o.created_at
from public.meme_orders o
join (select order_id, sum(quantity * price_sol) as notional from public.meme_fills where side = 'buy' group by order_id) f
  on f.order_id = o.id
where o.side = 'buy' and o.mode = 'live' and o.max_stake_at_entry is not null
  and f.notional > o.max_stake_at_entry * 1.10
union all
select 'entry_over_max_stake', 'warn', 'quantanamo', 'trade_intents', i.id::text, i.symbol,
       format('buy %s USD vs max_stake at entry %s USD (%s)', round(coalesce(bf.notional, i.notional), 2),
              round(i.max_stake_at_entry, 2), coalesce(i.max_stake_reason_at_entry, 'no reason')),
       i.created_at
from public.trade_intents i
left join (select trade_intent_id, sum(quantity * price) as notional from public.broker_fills group by trade_intent_id) bf
  on bf.trade_intent_id = i.id
where i.side = 'buy' and i.max_stake_at_entry is not null
  and coalesce(bf.notional, i.notional) > i.max_stake_at_entry * 1.10
union all
-- An equity lot opened with no buy intent behind it: judge its opening cost.
select 'entry_over_max_stake', 'warn', 'quantanamo', 'position_episodes', e.id::text, e.symbol,
       format('new lot cost %s USD vs max_stake at entry %s USD (%s)', round(e.quantity * e.average_cost, 2),
              round(e.max_stake_at_entry, 2), coalesce(e.max_stake_reason_at_entry, 'no reason')),
       e.opened_at
from public.position_episodes e
where e.status = 'open' and e.max_stake_at_entry is not null
  and not exists (select 1 from public.trade_intents i where i.position_episode_id = e.id and i.side = 'buy')
  and e.quantity * e.average_cost > e.max_stake_at_entry * 1.10;
