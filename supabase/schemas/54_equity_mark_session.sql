-- Session-aware equity breaches (2026-10-06, CODA premarket print).
-- QUANTANAMO marked CODA at 06:05 PT (09:05 ET) on a thin $10.31 premarket print, under its $10.35
-- invalidation line. The exit rule counts only regular-session trades, and CODA opened at $10.94.
-- action_hint already sent any non-regular-session equity mark to review_at_open (24 + 29), but the
-- views carried only a boolean, so the desk could not say which session a mark came from and drew it
-- as a plain breach. This adds the session label derived from the mark timestamp. No column is added
-- to the marks table: the session is always derived from portfolio_exposure.observed_at.
--
--   private.us_equity_session(timestamptz)   'pre' | 'rth' | 'post' | 'closed' (null for a null time)
--   public.us_equity_session(timestamptz)    same answer for stewards
--   v_open_lot_marks.mark_session            appended; null for prediction markets and memes (24/7)
--   v_invalidation_breaches.mark_session     appended; action_hint is unchanged
--
-- Sessions, America/New_York, NYSE calendar (public.us_equity_market_calendar):
--   rth     Mon-Fri 09:30 to 16:00 (13:00 on an early-close day). Same rule as is_us_regular_session.
--   pre     a trading day, 04:00 to 09:30
--   post    a trading day, the close to 20:00 (17:00 on an early-close day)
--   closed  weekends, exchange holidays, and 20:00 to 04:00
-- Only 'rth' is ever exit_full_lot for an equity. Every other session is review_at_open.

create or replace function private.us_equity_session(p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with et as (
    select (p_at at time zone 'America/New_York') as local_at
  ), cal as (
    select et.local_at::time as tod,
           extract(isodow from et.local_at) as dow,
           c.kind,
           coalesce(c.close_et, time '16:00') as close_at,
           case when c.kind = 'early_close' then time '17:00' else time '20:00' end as post_end
    from et
    left join public.us_equity_market_calendar c on c.day = et.local_at::date
  )
  select case
           when p_at is null then null
           when cal.dow > 5 or cal.kind = 'holiday' then 'closed'
           when cal.tod >= time '04:00' and cal.tod < time '09:30' then 'pre'
           when cal.tod >= time '09:30' and cal.tod < cal.close_at then 'rth'
           when cal.tod >= cal.close_at and cal.tod < cal.post_end then 'post'
           else 'closed'
         end
  from cal;
$$;

comment on function private.us_equity_session(timestamptz) is
  'US equity session at p_at in America/New_York: pre (04:00-09:30), rth (09:30-16:00, 13:00 on early closes), post (close-20:00, 17:00 on early closes), closed (weekends, holidays, overnight). rth matches private.is_us_regular_session.';

revoke all on function private.us_equity_session(timestamptz) from public, anon;
grant execute on function private.us_equity_session(timestamptz)
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

create or replace function public.us_equity_session(p_at timestamptz default now())
returns text
language sql
stable
set search_path = ''
as $$
  select private.us_equity_session(p_at);
$$;

comment on function public.us_equity_session(timestamptz) is
  'US equity session at p_at: pre, rth, post or closed. Only an rth mark at or below a lot''s invalidation is an actionable exit; any other session is review_at_open.';

revoke all on function public.us_equity_session(timestamptz) from public, anon;
grant execute on function public.us_equity_session(timestamptz)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

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
       px.quantity as broker_quantity,
       private.us_equity_session(px.observed_at) as mark_session
from public.position_episodes pe
left join eq_latest l on l.account_last4 = right(pe.account_key, 4)
left join public.portfolio_exposure px
  on px.account_last4 = l.account_last4 and px.observed_at = l.observed_at and px.symbol = pe.symbol
where pe.status = 'open'
union all
select 'oddsborne', 'pm_positions', p.id, coalesce(m.slug, m.question, p.market_id::text) || ' ' || p.outcome,
       'USD', p.thesis_id, nullif(btrim(coalesce(p.meta->>'untagged', '')), ''),
       p.quantity, p.invalidation_price, p.invalidation_note, p.mark, p.mark_at, null::boolean, p.opened_at, null::numeric,
       null::text
from public.pm_positions p
left join public.pm_markets m on m.id = p.market_id
where p.status = 'open'
union all
select 'bandit', 'meme_positions', p.id, coalesce(t.symbol, t.mint, p.token_id::text),
       'SOL', p.thesis_id, nullif(btrim(coalesce(p.meta->>'untagged', '')), ''),
       p.quantity, p.invalidation_price, p.invalidation_note, p.mark_sol, p.mark_at, null::boolean, p.opened_at, null::numeric,
       null::text
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
       end as action_hint,
       mark_session
from public.v_open_lot_marks
where invalidation_price is not null
  and mark is not null
  and mark <= invalidation_price;

grant select on public.v_open_lot_marks, public.v_invalidation_breaches
  to authenticated, quantanamo_worker, desk_public_reader, service_role;
