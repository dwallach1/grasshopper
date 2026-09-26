-- Independent backstop watchdog (2026-09-26, David: "Fix all holes").
-- The automated position monitor is retired. These read-only views flag lots that need a
-- steward's hand. They never invent a mark: a lot with no ledger mark is never a breach; it is
-- listed as open_lot_no_mark in v_ledger_integrity.
--
--   public.v_open_lot_marks                 every open lot (3 books) with its latest ledger mark
--   public.v_invalidation_breaches          open lots whose latest mark is at/below invalidation_price
--   public.v_open_lots_missing_invalidation open lots with no invalidation_price
--   public.v_ledger_integrity               one row per integrity finding (check, severity, detail)
--   public.v_ledger_watchdog                one row of counts for the desk / health routine
--
-- Equities: the mark is the lot's symbol in the latest portfolio_exposure snapshot of its account
-- (last_price, observed_at). A breach is actionable (exit_full_lot) only on a regular-session
-- (09:30-16:00 ET, Mon-Fri) mark; an extended-hours mark is review_at_open. PM (outcome price)
-- and memes (SOL per token) trade 24/7, so they have no session filter.
--
-- Also: buy orders inherit the thesis of the lot their fill lands on (trigger + one-time backfill).

create or replace function private.is_us_regular_session(p_at timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_at is not null
    and extract(isodow from (p_at at time zone 'America/New_York')) between 1 and 5
    and (p_at at time zone 'America/New_York')::time >= time '09:30'
    and (p_at at time zone 'America/New_York')::time < time '16:00';
$$;

grant execute on function private.is_us_regular_session(timestamptz)
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

create or replace view public.v_open_lot_marks
with (security_invoker = true)
as
with eq_latest as (
  select account_last4, max(observed_at) as observed_at
  from public.portfolio_exposure
  group by account_last4
)
select 'quantanamo'::text as steward,
       'position_episodes'::text as lot_table,
       pe.id as lot_id,
       pe.symbol as instrument,
       'USD'::text as unit,
       pe.thesis_id,
       nullif(btrim(coalesce(pe.meta->>'untagged', '')), '') as untagged,
       pe.quantity,
       pe.invalidation_price,
       pe.invalidation_note,
       px.last_price as mark,
       px.observed_at as mark_at,
       private.is_us_regular_session(px.observed_at) as mark_in_regular_session,
       pe.opened_at,
       px.quantity as broker_quantity
from public.position_episodes pe
left join eq_latest l on l.account_last4 = right(pe.account_key, 4)
left join public.portfolio_exposure px
  on px.account_last4 = l.account_last4 and px.observed_at = l.observed_at and px.symbol = pe.symbol
where pe.status = 'open'
union all
select 'oddsborne', 'pm_positions', p.id, coalesce(m.slug, m.question, p.market_id::text) || ' ' || p.outcome,
       'USD', p.thesis_id, nullif(btrim(coalesce(p.meta->>'untagged', '')), ''),
       p.quantity, p.invalidation_price, p.invalidation_note, p.mark, p.mark_at, null::boolean, p.opened_at, null::numeric
from public.pm_positions p
left join public.pm_markets m on m.id = p.market_id
where p.status = 'open'
union all
select 'bandit', 'meme_positions', p.id, coalesce(t.symbol, t.mint, p.token_id::text),
       'SOL', p.thesis_id, nullif(btrim(coalesce(p.meta->>'untagged', '')), ''),
       p.quantity, p.invalidation_price, p.invalidation_note, p.mark_sol, p.mark_at, null::boolean, p.opened_at, null::numeric
from public.meme_positions p
left join public.meme_tokens t on t.id = p.token_id
where p.status = 'open';

create or replace view public.v_invalidation_breaches
with (security_invoker = true)
as
select steward, lot_table, lot_id, instrument, unit, thesis_id, quantity,
       invalidation_price, invalidation_note, mark, mark_at,
       floor(extract(epoch from (now() - mark_at)) / 60)::int as mark_age_minutes,
       opened_at,
       floor(extract(epoch from (now() - opened_at)) / 3600)::int as lot_age_hours,
       mark_in_regular_session,
       case
         when lot_table = 'position_episodes' and not coalesce(mark_in_regular_session, false) then 'review_at_open'
         else 'exit_full_lot'
       end as action_hint
from public.v_open_lot_marks
where invalidation_price is not null
  and mark is not null
  and mark <= invalidation_price;

create or replace view public.v_open_lots_missing_invalidation
with (security_invoker = true)
as
select steward, lot_table, lot_id, instrument, unit, thesis_id, quantity, mark, mark_at, opened_at,
       floor(extract(epoch from (now() - opened_at)) / 3600)::int as lot_age_hours
from public.v_open_lot_marks
where invalidation_price is null;

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
union all
select 'buy_order_without_thesis', 'warn', 'bandit', 'meme_orders', o.id::text, o.signature,
       format('live %s buy has no thesis_id', o.status), o.created_at
from public.meme_orders o
where o.side = 'buy' and o.mode = 'live' and o.thesis_id is null and o.status = 'filled'
  and o.created_at > now() - interval '30 days'
union all
-- Broker fills not tied to an intent.
select 'broker_fill_without_intent', 'error', 'quantanamo', 'broker_fills', f.id::text, f.broker_order_id,
       'broker fill has no trade_intent_id', f.executed_at
from public.broker_fills f where f.trade_intent_id is null;

create or replace view public.v_ledger_watchdog
with (security_invoker = true)
as
select now() as checked_at,
       (select count(*) from public.v_invalidation_breaches)::int as invalidation_breaches,
       (select count(*) from public.v_invalidation_breaches where action_hint = 'exit_full_lot')::int as breaches_actionable,
       (select count(*) from public.v_invalidation_breaches where action_hint = 'review_at_open')::int as breaches_review_at_open,
       (select count(*) from public.v_open_lots_missing_invalidation)::int as lots_missing_invalidation,
       (select count(*) from public.v_ledger_integrity)::int as integrity_issues,
       (select count(*) from public.v_ledger_integrity where severity = 'error')::int as integrity_errors,
       coalesce((select jsonb_object_agg(check_name, n) from (
         select check_name, count(*)::int as n from public.v_ledger_integrity group by check_name) c), '{}'::jsonb) as integrity,
       (select count(*) from public.v_open_lot_marks)::int as open_lots;

grant select on public.v_open_lot_marks, public.v_invalidation_breaches, public.v_open_lots_missing_invalidation,
  public.v_ledger_integrity, public.v_ledger_watchdog
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

-- Buy orders inherit the thesis of the lot their fill lands on.
create or replace function private.order_thesis_from_fill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.position_id is null or new.order_id is null then
    return new;
  end if;
  if tg_table_name = 'meme_fills' then
    update public.meme_orders o set thesis_id = p.thesis_id, updated_at = now()
    from public.meme_positions p
    where p.id = new.position_id and o.id = new.order_id and o.thesis_id is null and p.thesis_id is not null;
  elsif tg_table_name = 'pm_fills' then
    update public.pm_orders o set thesis_id = p.thesis_id, updated_at = now()
    from public.pm_positions p
    where p.id = new.position_id and o.id = new.order_id and o.thesis_id is null and p.thesis_id is not null;
  end if;
  return new;
end;
$$;

revoke all on function private.order_thesis_from_fill() from public, anon, authenticated;

drop trigger if exists order_thesis_from_fill on public.meme_fills;
create trigger order_thesis_from_fill after insert or update of position_id on public.meme_fills
  for each row execute function private.order_thesis_from_fill();
drop trigger if exists order_thesis_from_fill on public.pm_fills;
create trigger order_thesis_from_fill after insert or update of position_id on public.pm_fills
  for each row execute function private.order_thesis_from_fill();

-- One-time backfill: live orders whose fills landed on a lot with a thesis.
update public.meme_orders o set thesis_id = p.thesis_id, updated_at = now()
from public.meme_fills f
join public.meme_positions p on p.id = f.position_id
where f.order_id = o.id and o.thesis_id is null and p.thesis_id is not null;

update public.pm_orders o set thesis_id = p.thesis_id, updated_at = now()
from public.pm_fills f
join public.pm_positions p on p.id = f.position_id
where f.order_id = o.id and o.thesis_id is null and p.thesis_id is not null;

-- Dashboard snapshot: add the watchdog counts and the steward scorecard (keys before 'counts').
do $patch$
declare
  v_def text := pg_get_functiondef('private.build_dashboard_snapshot(jsonb,timestamptz)'::regprocedure);
  v_marker text := E'    ''counts'', jsonb_build_object(\n';
  v_keys text := $keys$    'watchdog', coalesce((select to_jsonb(w) from public.v_ledger_watchdog w), '{}'::jsonb),
    'scorecard', jsonb_build_object(
      'stewards', coalesce((select jsonb_agg(to_jsonb(s) order by s.sort_order) from public.v_steward_scorecard s), '[]'::jsonb),
      'weekly', coalesce((select jsonb_agg(to_jsonb(w) order by w.week_start desc, w.steward) from (
        select steward, unit, week_start, iso_week, is_current, trades, priced_trades, wins, hit_rate, realized_pnl
        from public.v_steward_scorecard_weekly order by week_start desc, steward limit 60) w), '[]'::jsonb),
      'trend', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select steward, recent_n, prior_n, recent_expectancy, prior_expectancy, thin, direction
        from public.v_steward_trend) t), '[]'::jsonb),
      'theses', coalesce((select jsonb_agg(to_jsonb(t) order by t.priced_trades desc) from (
        select thesis_id, name, steward, stated_confidence, outcome_implied_confidence, confidence_gap,
               priced_trades, wins, miscalibrated, thin
        from public.v_thesis_scorecard) t), '[]'::jsonb),
      'max_stake', coalesce((select jsonb_agg(to_jsonb(m) order by m.steward, m.thesis_id) from public.v_thesis_max_stake m), '[]'::jsonb)
    ),
$keys$;
begin
  if position('''watchdog''' in v_def) > 0 then
    return;
  end if;
  if position(v_marker in v_def) = 0 then
    raise exception 'build_dashboard_snapshot: counts marker not found';
  end if;
  execute replace(v_def, v_marker, v_keys || v_marker);
end;
$patch$;
