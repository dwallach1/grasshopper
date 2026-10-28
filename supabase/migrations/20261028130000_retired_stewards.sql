-- Retired stewards (desk_agents.status = 'retired'; BANDIT and ODDSBORNE retired 2026-10-28 by David).
-- Nobody marks a retired steward's book, so open_lot_no_mark / open_lot_stale_mark skip its lots.
-- Every other integrity check still runs on them. No rows are deleted; the agents stay on the roster.

create or replace view public.v_ledger_integrity
with (security_invoker = true)
as
select 'open_lot_without_thesis'::text as check_name, 'warn'::text as severity, steward, lot_table as ref_table,
       lot_id::text as ref_id, instrument,
       'open lot has no thesis_id' || coalesce(' (untagged: ' || untagged || ')', '') as detail,
       opened_at as at
from public.v_open_lot_marks where thesis_id is null
union all
select 'open_lot_no_mark', 'warn', steward, lot_table, lot_id::text, instrument,
       'open lot has no ledger mark', opened_at
from public.v_open_lot_marks where mark is null
  and steward not in (select a.slug from public.desk_agents a where a.status = 'retired')
union all
select 'open_lot_stale_mark', 'warn', steward, lot_table, lot_id::text, instrument,
       format('latest mark is %s minutes old', floor(extract(epoch from (now() - mark_at)) / 60)::int), mark_at
from public.v_open_lot_marks
where mark_at is not null
  and now() - mark_at > case when lot_table = 'position_episodes' then interval '4 days' else interval '6 hours' end
  and steward not in (select a.slug from public.desk_agents a where a.status = 'retired')
union all
select 'lot_broker_qty_mismatch', 'error', steward, lot_table, lot_id::text, instrument,
       format('lot quantity %s vs broker %s', quantity, coalesce(broker_quantity::text, 'absent')), mark_at
from public.v_open_lot_marks
where lot_table = 'position_episodes'
  and (broker_quantity is null or abs(broker_quantity - quantity) > 0.000001)
union all
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
select 'fill_without_position', 'warn', 'oddsborne', 'pm_fills', f.id::text, f.venue_fill_id,
       'pm fill has no position_id', f.executed_at
from public.pm_fills f where f.position_id is null and f.executed_at > now() - interval '30 days'
union all
select 'fill_without_position', 'warn', 'bandit', 'meme_fills', f.id::text, f.venue_fill_id,
       'meme fill has no position_id', f.executed_at
from public.meme_fills f where f.position_id is null and f.executed_at > now() - interval '30 days'
union all
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
select 'broker_fill_without_intent', 'error', 'quantanamo', 'broker_fills', f.id::text, f.broker_order_id,
       'broker fill has no trade_intent_id', f.executed_at
from public.broker_fills f where f.trade_intent_id is null
union all
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
select 'entry_over_max_stake', 'warn', 'quantanamo', 'position_episodes', e.id::text, e.symbol,
       format('new lot cost %s USD vs max_stake at entry %s USD (%s)', round(e.quantity * e.average_cost, 2),
              round(e.max_stake_at_entry, 2), coalesce(e.max_stake_reason_at_entry, 'no reason')),
       e.opened_at
from public.position_episodes e
where e.status = 'open' and e.max_stake_at_entry is not null
  and not exists (select 1 from public.trade_intents i where i.position_episode_id = e.id and i.side = 'buy')
  and e.quantity * e.average_cost > e.max_stake_at_entry * 1.10
union all
select 'line_at_or_below_cost', 'warn', 'quantanamo', 'position_episodes', e.id::text, e.symbol,
       format('%s exit line %s is at or below blended cost %s after an add',
              e.symbol, trim_scale(e.invalidation_price), trim_scale(e.average_cost)),
       e.updated_at
from public.position_episodes e
where e.status = 'open'
  and public.line_at_or_below_blended(e.invalidation_price, e.average_cost)
  and public.equity_lot_has_add(e.id)
  and not public.lot_accepts_scratch(e.meta)
  and not public.equity_fill_accepts_scratch(e.id)
union all
select 'line_at_or_below_cost', 'warn', 'oddsborne', 'pm_positions', p.id::text, coalesce(m.slug, p.outcome),
       format('%s exit line %s is at or below blended cost %s after an add',
              coalesce(m.slug, p.outcome), trim_scale(p.invalidation_price), trim_scale(p.average_cost)),
       p.updated_at
from public.pm_positions p
left join public.pm_markets m on m.id = p.market_id
where p.status = 'open'
  and public.line_at_or_below_blended(p.invalidation_price, p.average_cost)
  and public.pm_lot_has_add(p.id)
  and not public.lot_accepts_scratch(p.meta)
  and not public.pm_fill_accepts_scratch(p.id)
union all
select 'line_at_or_below_cost', 'warn', 'bandit', 'meme_positions', p.id::text, coalesce(t.symbol, t.mint),
       format('%s exit line %s is at or below blended cost %s after an add',
              coalesce(t.symbol, t.mint), trim_scale(p.invalidation_price), trim_scale(p.average_cost_sol)),
       p.updated_at
from public.meme_positions p
left join public.meme_tokens t on t.id = p.token_id
where p.status = 'open'
  and public.line_at_or_below_blended(p.invalidation_price, p.average_cost_sol)
  and public.meme_lot_has_add(p.id)
  and not public.lot_accepts_scratch(p.meta)
  and not public.meme_fill_accepts_scratch(p.id);

comment on view public.v_ledger_integrity is
  'One row per integrity finding. line_at_or_below_cost is an add whose exit line is at or below blended cost and was not recorded as an accepted scratch. Warn, not a block.';

-- Retire BANDIT (meme) and ODDSBORNE (prediction). Books, lots and history are left as they are.
update public.desk_agents set status = 'retired', updated_at = now(),
       meta = meta || jsonb_build_object('retired_at', '2026-10-28', 'retired_note', 'David: only QUANTANAMO stays')
 where slug in ('bandit', 'oddsborne') and status <> 'retired';
update public.desk_domains set status = 'retired', updated_at = now()
 where slug in ('meme', 'prediction') and status <> 'retired';
