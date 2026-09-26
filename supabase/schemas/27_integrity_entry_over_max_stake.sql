-- v_ledger_integrity + entry_over_max_stake: detect entries that bypassed
-- steward_sizing_guidance (size above the thesis's edge-scaled max_stake).
-- Same columns; v_ledger_watchdog counts it automatically.

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
-- Entries that bypassed guidance: a live buy (PM / coins) or a new equity lot opened
-- since the edge-scaled max stake went live whose size is above its thesis's
-- max_stake (10% slippage allowance). Compared with the *current* cap, so a cap
-- that shrank after later losses can also surface here: review, don't auto-act.
select 'entry_over_max_stake', 'warn', 'oddsborne', 'pm_orders', o.id::text, o.venue_order_id,
       format('buy filled %s USD vs thesis %s max_stake %s USD', round(f.notional, 2), o.thesis_id, round(ms.max_stake, 2)),
       o.created_at
from public.pm_orders o
join (select order_id, sum(quantity * price) as notional from public.pm_fills where side = 'buy' group by order_id) f
  on f.order_id = o.id
join public.v_thesis_max_stake ms on ms.steward = 'oddsborne' and ms.thesis_id = o.thesis_id
where o.side = 'buy' and o.mode = 'live' and o.created_at >= '2026-09-26 18:03:53+00'
  and f.notional > ms.max_stake * 1.10
union all
select 'entry_over_max_stake', 'warn', 'bandit', 'meme_orders', o.id::text, o.signature,
       format('buy filled %s SOL vs thesis %s max_stake %s SOL', round(f.notional, 4), o.thesis_id, round(ms.max_stake, 4)),
       o.created_at
from public.meme_orders o
join (select order_id, sum(quantity * price_sol) as notional from public.meme_fills where side = 'buy' group by order_id) f
  on f.order_id = o.id
join public.v_thesis_max_stake ms on ms.steward = 'bandit' and ms.thesis_id = o.thesis_id
where o.side = 'buy' and o.mode = 'live' and o.created_at >= '2026-09-26 18:03:53+00'
  and f.notional > ms.max_stake * 1.10
union all
select 'entry_over_max_stake', 'warn', 'quantanamo', 'position_episodes', e.id::text, e.symbol,
       format('new lot cost %s USD vs thesis %s max_stake %s USD', round(e.quantity * e.average_cost, 2), e.thesis_id, round(ms.max_stake, 2)),
       e.opened_at
from public.position_episodes e
join public.v_thesis_max_stake ms on ms.steward = 'quantanamo' and ms.thesis_id = e.thesis_id
where e.status = 'open' and e.opened_at >= '2026-09-26 18:03:53+00'
  and e.quantity * e.average_cost > ms.max_stake * 1.10;
