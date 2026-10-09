-- Breach age and line-after-add (beliefs breach_escalates_next_run, recheck_line_after_add).
--
-- 10/8: NBIS and CODA traded through their lines at the open. The ledger's first regular-session
-- prints under the lines are portfolio_exposure 2026-10-08 13:53:02.278126+00 (NBIS 227.72 vs
-- 227.90, CODA 10.32 vs 10.35). The 13:49:09 snapshot was still above both lines. The next prints,
-- 16:44:06.973851+00, were still through (NBIS 226.59, CODA 10.29). The invalidation watch and the
-- 9:00 PT market scan never ran, so the exits waited until a manual sell around 16:45. Lessons 109
-- and 110. This does not invent a price: first_seen is that print's observed_at.
--
-- An actionable breach (exit_full_lot; equities only on an rth mark) is escalated when a second
-- check is still through the line, or when the first print is 15 minutes old. Fifteen minutes is
-- long enough that the run which wrote the print, and its own heartbeat in that same minute, does
-- not escalate itself, and short of the ~2h the 10/8 exits waited. Escalation is an alert the next
-- steward routine reads. It does not block an order.
--
-- 10/6: the NBIS add at 252.2499 lifted blended cost to 227.6137 while the line stayed 227.90, so
-- the line was still a hair above cost and this check stays quiet on that row. An add whose line
-- is at or below the new blended cost is written on the lot and listed in v_ledger_integrity,
-- unless the lot, the fill, or the intent records accepted_scratch. It does not refuse the fill.
--
-- Existing watchdog columns are unchanged. New ones are appended.

-- ——— pure rule (the replay and the view use the same 15-minute window) ———

create or replace function public.breach_age_label(p_minutes integer)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_minutes is null or p_minutes < 0 then null
    when p_minutes < 60 then p_minutes::text || 'm'
    when p_minutes % 60 = 0 then (p_minutes / 60)::text || 'h'
    else (p_minutes / 60)::text || 'h ' || (p_minutes % 60)::text || 'm'
  end;
$$;

comment on function public.breach_age_label(integer) is
  'Breach age in plain words: 14 -> 14m, 120 -> 2h, 171 -> 2h 51m.';

create or replace function public.breach_escalation_state(
  p_checks integer,
  p_first_seen timestamptz,
  p_as_of timestamptz
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'escalated',
      p_first_seen is not null and p_as_of is not null and (
        coalesce(p_checks, 0) >= 2
        or p_as_of >= p_first_seen + interval '15 minutes'
      ),
    'escalation',
      case
        when p_first_seen is null or p_as_of is null then null
        when coalesce(p_checks, 0) >= 2 then 'next_check'
        when p_as_of >= p_first_seen + interval '15 minutes' then 'window'
        else null
      end
  );
$$;

comment on function public.breach_escalation_state(integer, timestamptz, timestamptz) is
  'Escalated on the second check (next_check) or once the first real print is 15 minutes old (window). No first print means not escalated.';

create or replace function public.escalated_breach_sentence(p_instrument text, p_minutes integer)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when nullif(btrim(p_instrument), '') is null or public.breach_age_label(p_minutes) is null then null
    else btrim(p_instrument) || ' has been under its exit line for ' || public.breach_age_label(p_minutes) || ' — sell now'
  end;
$$;

comment on function public.escalated_breach_sentence(text, integer) is
  'Desk line for an escalated breach. No price and no P/L.';

-- Walk real prints in order. A null price is skipped. An equity print counts only in the regular
-- session. The first print under the line is check 1. The next one is check 2 and escalates.
create or replace function public.replay_actionable_breach_checks(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_line numeric := (p->>'line')::numeric;
  v_equity boolean := coalesce((p->>'equity')::boolean, true);
  v_as_of timestamptz := nullif(p->>'as_of', '')::timestamptz;
  v_mark jsonb;
  v_at timestamptz;
  v_price numeric;
  v_checks integer := 0;
  v_first timestamptz;
  v_second timestamptz;
  v_state jsonb;
  v_age integer;
begin
  if v_line is null then
    return jsonb_build_object('checks', 0, 'escalated', false, 'escalation', null, 'first_seen_at', null, 'sentence', null);
  end if;
  for v_mark in
    select m
    from jsonb_array_elements(coalesce(p->'marks', '[]'::jsonb)) m
    order by nullif(m->>'at', '')::timestamptz
  loop
    v_at := nullif(v_mark->>'at', '')::timestamptz;
    v_price := nullif(v_mark->>'price', '')::numeric;
    if v_at is null or v_price is null or v_price > v_line then
      continue;
    end if;
    if v_equity and public.us_equity_session(v_at) is distinct from 'rth' then
      continue;
    end if;
    v_checks := v_checks + 1;
    if v_checks = 1 then
      v_first := v_at;
    elsif v_checks = 2 then
      v_second := v_at;
    end if;
  end loop;
  if v_as_of is null then
    v_as_of := coalesce(v_second, v_first);
  end if;
  v_state := public.breach_escalation_state(v_checks, v_first, v_as_of);
  v_age := case
    when v_first is null or v_as_of is null then null
    else floor(extract(epoch from (v_as_of - v_first)) / 60)::integer
  end;
  return v_state || jsonb_build_object(
    'checks', v_checks,
    'first_seen_at', v_first,
    'second_seen_at', v_second,
    'as_of', v_as_of,
    'breach_age_minutes', v_age,
    'sentence', case
      when coalesce((v_state->>'escalated')::boolean, false)
        then public.escalated_breach_sentence(p->>'instrument', v_age)
      else null
    end
  );
end;
$$;

comment on function public.replay_actionable_breach_checks(jsonb) is
  'Replay a lot''s prints. First print under the line is not escalated. The second print still under the line is next_check. Pass as_of to test the 15-minute window on a single print.';

-- ——— line versus blended cost after an add (alert only) ———

create or replace function public.line_at_or_below_blended(p_line numeric, p_cost numeric)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_line is not null and p_cost is not null and p_cost > 0 and p_line <= p_cost;
$$;

comment on function public.line_at_or_below_blended(numeric, numeric) is
  'True when the invalidation line is at or below the blended cost. A line still above cost, including NBIS 227.90 vs 227.6137 on 10/6, is false.';

create or replace function public.lot_accepts_scratch(p_meta jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(p_meta->>'accepted_scratch', '') in ('true', 't', 'yes')
    or exists (
      select 1
      from jsonb_array_elements(
        case when jsonb_typeof(p_meta->'adds') = 'array' then p_meta->'adds' else '[]'::jsonb end
      ) a
      where coalesce(a->>'accepted_scratch', '') in ('true', 't', 'yes')
    );
$$;

create or replace function public.line_vs_cost_meta(
  p_meta jsonb,
  p_line numeric,
  p_cost numeric,
  p_is_add boolean,
  p_scratch boolean,
  p_at timestamptz
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when coalesce(p_is_add, false)
      and not coalesce(p_scratch, false)
      and public.line_at_or_below_blended(p_line, p_cost)
      then coalesce(p_meta, '{}'::jsonb) || jsonb_build_object(
        'line_at_or_below_cost', true,
        'line_vs_cost_line', p_line,
        'line_vs_cost_blended', p_cost,
        'line_vs_cost_at', p_at
      )
    else (coalesce(p_meta, '{}'::jsonb)
      - 'line_at_or_below_cost' - 'line_vs_cost_line' - 'line_vs_cost_blended' - 'line_vs_cost_at')
  end;
$$;

comment on function public.line_vs_cost_meta(jsonb, numeric, numeric, boolean, boolean, timestamptz) is
  'Writes or clears the lot meta flag. An accepted scratch, a first buy, or a line still above cost clears it. Never raises.';

create or replace function public.equity_lot_has_add(p_episode uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select count(distinct i.id) > 1
    from public.broker_fills f
    join public.trade_intents i on i.id = f.trade_intent_id
    where i.position_episode_id = p_episode and i.side = 'buy'
  ), false)
  or coalesce((
    select jsonb_typeof(pe.meta->'adds') = 'array' and jsonb_array_length(pe.meta->'adds') > 0
    from public.position_episodes pe
    where pe.id = p_episode
  ), false);
$$;

create or replace function public.pm_lot_has_add(p_position uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select count(distinct f.order_id) > 1
    from public.pm_fills f
    where f.position_id = p_position and f.side = 'buy' and f.order_id is not null
  ), false);
$$;

create or replace function public.meme_lot_has_add(p_position uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select count(distinct f.order_id) > 1
    from public.meme_fills f
    where f.position_id = p_position and f.side = 'buy' and f.order_id is not null
  ), false);
$$;

create or replace function public.equity_fill_accepts_scratch(p_episode uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.broker_fills f
    join public.trade_intents i on i.id = f.trade_intent_id
    where i.position_episode_id = p_episode
      and (
        coalesce(f.payload->>'accepted_scratch', '') in ('true', 't', 'yes')
        or coalesce(i.review_payload->>'accepted_scratch', '') in ('true', 't', 'yes')
        or coalesce(i.gate_results->>'accepted_scratch', '') in ('true', 't', 'yes')
      )
  );
$$;

create or replace function public.pm_fill_accepts_scratch(p_position uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.pm_fills f
    where f.position_id = p_position
      and coalesce(f.payload->>'accepted_scratch', '') in ('true', 't', 'yes')
  );
$$;

create or replace function public.meme_fill_accepts_scratch(p_position uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.meme_fills f
    where f.position_id = p_position
      and coalesce(f.payload->>'accepted_scratch', '') in ('true', 't', 'yes')
  );
$$;

-- ——— first-seen rows. One per lot. Cleared when the lot is no longer an actionable breach. ———

create table public.invalidation_breach_sightings (
  lot_table text not null,
  lot_id uuid not null,
  steward text not null,
  instrument text not null,
  first_mark_at timestamptz not null,
  first_mark numeric not null,
  line_at_first numeric not null,
  last_mark_at timestamptz not null,
  last_mark numeric not null,
  last_line numeric not null,
  check_count integer not null,
  last_check_key text not null,
  first_check_at timestamptz not null default now(),
  last_check_at timestamptz not null default now(),
  escalated_at timestamptz,
  escalation text,
  cleared_at timestamptz,
  primary key (lot_table, lot_id),
  constraint invalidation_breach_sightings_escalation_chk
    check (escalation is null or escalation in ('next_check', 'window')),
  constraint invalidation_breach_sightings_checks_chk
    check (check_count >= 1)
);

comment on table public.invalidation_breach_sightings is
  'First real print under an exit line, and later checks. first_mark_at is copied from the mark. A row with no mark is not inserted. cleared_at set when the lot is no longer an actionable breach.';

alter table public.invalidation_breach_sightings enable row level security;

revoke all on table public.invalidation_breach_sightings from public, anon;

grant select on table public.invalidation_breach_sightings
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;
grant insert, update on table public.invalidation_breach_sightings
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create policy invalidation_breach_sightings_select
  on public.invalidation_breach_sightings
  for select
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader
  using (true);

create policy invalidation_breach_sightings_insert
  on public.invalidation_breach_sightings
  for insert
  to quantanamo_worker, oddsborne_worker, bandit_worker
  with check (true);

create policy invalidation_breach_sightings_update
  on public.invalidation_breach_sightings
  for update
  to quantanamo_worker, oddsborne_worker, bandit_worker
  using (true)
  with check (true);

create or replace function private.note_breach_sighting(
  p_steward text,
  p_lot_table text,
  p_lot_id uuid,
  p_instrument text,
  p_mark numeric,
  p_mark_at timestamptz,
  p_line numeric,
  p_check_key text
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  s public.invalidation_breach_sightings%rowtype;
  v_key text;
  v_checks integer;
begin
  if p_mark is null or p_mark_at is null or p_line is null or p_lot_id is null or nullif(btrim(p_instrument), '') is null then
    return;
  end if;
  v_key := coalesce(nullif(btrim(p_check_key), ''), 'mark:' || p_mark_at::text);
  if p_mark > p_line then
    update public.invalidation_breach_sightings
       set cleared_at = now()
     where lot_table = p_lot_table and lot_id = p_lot_id and cleared_at is null;
    return;
  end if;
  select * into s
    from public.invalidation_breach_sightings
   where lot_table = p_lot_table and lot_id = p_lot_id
   for update;
  if not found then
    insert into public.invalidation_breach_sightings (
      lot_table, lot_id, steward, instrument,
      first_mark_at, first_mark, line_at_first,
      last_mark_at, last_mark, last_line,
      check_count, last_check_key, first_check_at, last_check_at,
      escalated_at, escalation, cleared_at
    ) values (
      p_lot_table, p_lot_id, p_steward, btrim(p_instrument),
      p_mark_at, p_mark, p_line,
      p_mark_at, p_mark, p_line,
      1, v_key, now(), now(),
      null, null, null
    );
    return;
  end if;
  if s.cleared_at is not null then
    update public.invalidation_breach_sightings
       set steward = p_steward,
           instrument = btrim(p_instrument),
           first_mark_at = p_mark_at,
           first_mark = p_mark,
           line_at_first = p_line,
           last_mark_at = p_mark_at,
           last_mark = p_mark,
           last_line = p_line,
           check_count = 1,
           last_check_key = v_key,
           first_check_at = now(),
           last_check_at = now(),
           escalated_at = null,
           escalation = null,
           cleared_at = null
     where lot_table = p_lot_table and lot_id = p_lot_id;
    return;
  end if;
  if p_mark_at <= s.last_mark_at and v_key = s.last_check_key then
    update public.invalidation_breach_sightings
       set last_mark = p_mark, last_line = p_line, instrument = btrim(p_instrument)
     where lot_table = p_lot_table and lot_id = p_lot_id;
    return;
  end if;
  -- A later print is the next check immediately. A different routine on the same print counts
  -- only after 15 minutes, so the run that wrote the print does not escalate itself.
  if p_mark_at > s.last_mark_at
     or (v_key is distinct from s.last_check_key and now() >= s.first_mark_at + interval '15 minutes') then
    v_checks := s.check_count + 1;
    update public.invalidation_breach_sightings
       set last_mark_at = case when p_mark_at > last_mark_at then p_mark_at else last_mark_at end,
           last_mark = p_mark,
           last_line = p_line,
           instrument = btrim(p_instrument),
           check_count = v_checks,
           last_check_key = v_key,
           last_check_at = now(),
           escalated_at = case
             when escalated_at is not null then escalated_at
             when v_checks >= 2 then case when p_mark_at > s.first_mark_at then p_mark_at else now() end
             else null
           end,
           escalation = case
             when escalation is not null then escalation
             when v_checks >= 2 then 'next_check'
             else null
           end
     where lot_table = p_lot_table and lot_id = p_lot_id;
    return;
  end if;
  update public.invalidation_breach_sightings
     set last_check_key = v_key,
         last_check_at = now(),
         last_mark = p_mark,
         last_line = p_line,
         instrument = btrim(p_instrument)
   where lot_table = p_lot_table and lot_id = p_lot_id;
end;
$$;

comment on function private.note_breach_sighting(text, text, uuid, text, numeric, timestamptz, numeric, text) is
  'Persist the first real print under the line. A later print escalates. A null mark returns without writing.';

revoke all on function private.note_breach_sighting(text, text, uuid, text, numeric, timestamptz, numeric, text)
  from public, anon, authenticated;
grant execute on function private.note_breach_sighting(text, text, uuid, text, numeric, timestamptz, numeric, text)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— mark triggers: the print itself is check 1 ———

create or replace function private.exposure_note_breach()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
begin
  if new.symbol is null or new.account_last4 is null then
    return new;
  end if;
  update public.invalidation_breach_sightings s
     set cleared_at = now()
    from public.position_episodes pe
   where s.lot_table = 'position_episodes'
     and s.lot_id = pe.id
     and s.cleared_at is null
     and pe.symbol = new.symbol
     and right(pe.account_key, 4) = new.account_last4
     and pe.status is distinct from 'open';
  if new.last_price is null or new.observed_at is null then
    return new;
  end if;
  if public.us_equity_session(new.observed_at) is distinct from 'rth' then
    return new;
  end if;
  for r in
    select pe.id, pe.invalidation_price, pe.symbol
    from public.position_episodes pe
    where pe.status = 'open'
      and pe.symbol = new.symbol
      and right(pe.account_key, 4) = new.account_last4
      and pe.invalidation_price is not null
  loop
    perform private.note_breach_sighting(
      'quantanamo', 'position_episodes', r.id, r.symbol,
      new.last_price, new.observed_at, r.invalidation_price,
      'mark:' || new.observed_at::text);
  end loop;
  return new;
end;
$$;

revoke all on function private.exposure_note_breach() from public, anon, authenticated;
grant execute on function private.exposure_note_breach() to quantanamo_worker, service_role;

drop trigger if exists exposure_note_breach on public.portfolio_exposure;
create trigger exposure_note_breach
  after insert or update of last_price, observed_at, quantity on public.portfolio_exposure
  for each row execute function private.exposure_note_breach();

create or replace function private.pm_note_breach()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_instrument text;
begin
  if new.status is distinct from 'open' or new.mark is null or new.mark_at is null or new.invalidation_price is null then
    update public.invalidation_breach_sightings
       set cleared_at = now()
     where lot_table = 'pm_positions' and lot_id = new.id and cleared_at is null
       and (new.status is distinct from 'open' or new.mark is null or new.mark_at is null);
    return new;
  end if;
  select coalesce(m.slug, m.question, new.market_id::text) || ' ' || new.outcome
    into v_instrument
  from public.pm_markets m
  where m.id = new.market_id;
  perform private.note_breach_sighting(
    'oddsborne', 'pm_positions', new.id, coalesce(v_instrument, new.outcome),
    new.mark, new.mark_at, new.invalidation_price,
    'mark:' || new.mark_at::text);
  return new;
end;
$$;

revoke all on function private.pm_note_breach() from public, anon, authenticated;
grant execute on function private.pm_note_breach() to oddsborne_worker, service_role;

drop trigger if exists pm_note_breach on public.pm_positions;
create trigger pm_note_breach
  after insert or update of mark, mark_at, invalidation_price, status on public.pm_positions
  for each row execute function private.pm_note_breach();

create or replace function private.meme_note_breach()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_instrument text;
begin
  if new.status is distinct from 'open' or new.mark_sol is null or new.mark_at is null or new.invalidation_price is null then
    update public.invalidation_breach_sightings
       set cleared_at = now()
     where lot_table = 'meme_positions' and lot_id = new.id and cleared_at is null
       and (new.status is distinct from 'open' or new.mark_sol is null or new.mark_at is null);
    return new;
  end if;
  select coalesce(t.symbol, t.mint, new.token_id::text)
    into v_instrument
  from public.meme_tokens t
  where t.id = new.token_id;
  perform private.note_breach_sighting(
    'bandit', 'meme_positions', new.id, coalesce(v_instrument, new.token_id::text),
    new.mark_sol, new.mark_at, new.invalidation_price,
    'mark:' || new.mark_at::text);
  return new;
end;
$$;

revoke all on function private.meme_note_breach() from public, anon, authenticated;
grant execute on function private.meme_note_breach() to bandit_worker, service_role;

drop trigger if exists meme_note_breach on public.meme_positions;
create trigger meme_note_breach
  after insert or update of mark_sol, mark_at, invalidation_price, status on public.meme_positions
  for each row execute function private.meme_note_breach();

-- ——— add fills: flag the lot, do not refuse ———

create or replace function private.flag_equity_line_after_fill()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_intent public.trade_intents%rowtype;
  v_line numeric;
  v_meta jsonb;
  v_cost numeric;
  v_scratch boolean;
  v_next jsonb;
begin
  if new.trade_intent_id is null then
    return new;
  end if;
  select * into v_intent from public.trade_intents where id = new.trade_intent_id;
  if not found or v_intent.side is distinct from 'buy' or v_intent.position_episode_id is null then
    return new;
  end if;
  if not public.equity_lot_has_add(v_intent.position_episode_id) then
    return new;
  end if;
  select pe.invalidation_price, pe.meta into v_line, v_meta
    from public.position_episodes pe
   where pe.id = v_intent.position_episode_id;
  select sum(f.quantity * f.price) / nullif(sum(f.quantity), 0) into v_cost
    from public.broker_fills f
    join public.trade_intents i on i.id = f.trade_intent_id
   where i.position_episode_id = v_intent.position_episode_id
     and i.side = 'buy' and f.quantity > 0 and f.price > 0;
  v_scratch := public.lot_accepts_scratch(v_meta)
    or public.equity_fill_accepts_scratch(v_intent.position_episode_id);
  v_next := public.line_vs_cost_meta(v_meta, v_line, v_cost, true, v_scratch, coalesce(new.executed_at, now()));
  update public.position_episodes
     set meta = v_next
   where id = v_intent.position_episode_id
     and meta is distinct from v_next;
  return new;
end;
$$;

revoke all on function private.flag_equity_line_after_fill() from public, anon, authenticated;
grant execute on function private.flag_equity_line_after_fill() to quantanamo_worker, service_role;

drop trigger if exists broker_fills_line_after_add on public.broker_fills;
create trigger broker_fills_line_after_add
  after insert on public.broker_fills
  for each row execute function private.flag_equity_line_after_fill();

create or replace function private.flag_equity_line_on_cost()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- A meta-only write (the fill trigger's flag) is left as stored. Recompute when cost or the line moves.
  if new.average_cost is not distinct from old.average_cost
     and new.invalidation_price is not distinct from old.invalidation_price then
    return new;
  end if;
  new.meta := public.line_vs_cost_meta(
    new.meta,
    new.invalidation_price,
    new.average_cost,
    public.equity_lot_has_add(new.id),
    public.lot_accepts_scratch(new.meta) or public.equity_fill_accepts_scratch(new.id),
    coalesce(new.updated_at, now()));
  return new;
end;
$$;

revoke all on function private.flag_equity_line_on_cost() from public, anon, authenticated;
grant execute on function private.flag_equity_line_on_cost() to quantanamo_worker, service_role;

drop trigger if exists position_episodes_line_after_add on public.position_episodes;
create trigger position_episodes_line_after_add
  before update of average_cost, invalidation_price on public.position_episodes
  for each row execute function private.flag_equity_line_on_cost();

create or replace function private.flag_pm_line_after_fill()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pos public.pm_positions%rowtype;
  v_scratch boolean;
  v_next jsonb;
begin
  if tg_op = 'DELETE' or new.position_id is null or new.side is distinct from 'buy' then
    return null;
  end if;
  if not public.pm_lot_has_add(new.position_id) then
    return null;
  end if;
  select * into v_pos from public.pm_positions where id = new.position_id;
  if not found then
    return null;
  end if;
  v_scratch := public.lot_accepts_scratch(v_pos.meta) or public.pm_fill_accepts_scratch(v_pos.id);
  v_next := public.line_vs_cost_meta(
    v_pos.meta, v_pos.invalidation_price, v_pos.average_cost, true, v_scratch, coalesce(new.executed_at, now()));
  update public.pm_positions
     set meta = v_next
   where id = v_pos.id and meta is distinct from v_next;
  return null;
end;
$$;

revoke all on function private.flag_pm_line_after_fill() from public, anon, authenticated;
grant execute on function private.flag_pm_line_after_fill() to oddsborne_worker, service_role;

drop trigger if exists pm_fills_line_after_add on public.pm_fills;
create trigger pm_fills_line_after_add
  after insert or update of position_id, side, quantity, price on public.pm_fills
  for each row execute function private.flag_pm_line_after_fill();

create or replace function private.flag_pm_line_on_cost()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.average_cost is not distinct from old.average_cost
     and new.invalidation_price is not distinct from old.invalidation_price then
    return new;
  end if;
  new.meta := public.line_vs_cost_meta(
    new.meta,
    new.invalidation_price,
    new.average_cost,
    public.pm_lot_has_add(new.id),
    public.lot_accepts_scratch(new.meta) or public.pm_fill_accepts_scratch(new.id),
    coalesce(new.updated_at, now()));
  return new;
end;
$$;

revoke all on function private.flag_pm_line_on_cost() from public, anon, authenticated;
grant execute on function private.flag_pm_line_on_cost() to oddsborne_worker, service_role;

drop trigger if exists pm_positions_line_after_add on public.pm_positions;
create trigger pm_positions_line_after_add
  before update of average_cost, invalidation_price on public.pm_positions
  for each row execute function private.flag_pm_line_on_cost();

create or replace function private.flag_meme_line_after_fill()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pos public.meme_positions%rowtype;
  v_scratch boolean;
  v_next jsonb;
begin
  if tg_op = 'DELETE' or new.position_id is null or new.side is distinct from 'buy' then
    return null;
  end if;
  if not public.meme_lot_has_add(new.position_id) then
    return null;
  end if;
  select * into v_pos from public.meme_positions where id = new.position_id;
  if not found then
    return null;
  end if;
  v_scratch := public.lot_accepts_scratch(v_pos.meta) or public.meme_fill_accepts_scratch(v_pos.id);
  v_next := public.line_vs_cost_meta(
    v_pos.meta, v_pos.invalidation_price, v_pos.average_cost_sol, true, v_scratch, coalesce(new.executed_at, now()));
  update public.meme_positions
     set meta = v_next
   where id = v_pos.id and meta is distinct from v_next;
  return null;
end;
$$;

revoke all on function private.flag_meme_line_after_fill() from public, anon, authenticated;
grant execute on function private.flag_meme_line_after_fill() to bandit_worker, service_role;

drop trigger if exists meme_fills_line_after_add on public.meme_fills;
create trigger meme_fills_line_after_add
  after insert or update of position_id, side, quantity, price_sol on public.meme_fills
  for each row execute function private.flag_meme_line_after_fill();

create or replace function private.flag_meme_line_on_cost()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.average_cost_sol is not distinct from old.average_cost_sol
     and new.invalidation_price is not distinct from old.invalidation_price then
    return new;
  end if;
  new.meta := public.line_vs_cost_meta(
    new.meta,
    new.invalidation_price,
    new.average_cost_sol,
    public.meme_lot_has_add(new.id),
    public.lot_accepts_scratch(new.meta) or public.meme_fill_accepts_scratch(new.id),
    coalesce(new.updated_at, now()));
  return new;
end;
$$;

revoke all on function private.flag_meme_line_on_cost() from public, anon, authenticated;
grant execute on function private.flag_meme_line_on_cost() to bandit_worker, service_role;

drop trigger if exists meme_positions_line_after_add on public.meme_positions;
create trigger meme_positions_line_after_add
  before update of average_cost_sol, invalidation_price on public.meme_positions
  for each row execute function private.flag_meme_line_on_cost();

-- ——— breaches view: same columns as 54, then first-seen and escalation ———

create or replace view public.v_invalidation_breaches
with (security_invoker = true)
as
with base as (
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
    and mark <= invalidation_price
),
joined as (
  select b.*,
         case when s.cleared_at is null then s.first_mark_at end as first_seen_at,
         case when s.cleared_at is null then s.check_count else 0 end as check_count,
         case when s.cleared_at is null then s.escalated_at end as escalated_at,
         case when s.cleared_at is null then s.escalation end as stored_escalation
  from base b
  left join public.invalidation_breach_sightings s
    on s.lot_table = b.lot_table and s.lot_id = b.lot_id
)
select steward, lot_table, lot_id, instrument, unit, thesis_id, quantity,
       invalidation_price, invalidation_note, mark, mark_at,
       mark_age_minutes, opened_at, lot_age_hours, mark_in_regular_session,
       action_hint, mark_session,
       first_seen_at,
       case
         when first_seen_at is null then null
         else floor(extract(epoch from (now() - first_seen_at)) / 60)::int
       end as breach_age_minutes,
       coalesce(check_count, 0)::int as check_count,
       (
         action_hint = 'exit_full_lot'
         and first_seen_at is not null
         and (escalated_at is not null or now() >= first_seen_at + interval '15 minutes')
       ) as escalated,
       case
         when action_hint is distinct from 'exit_full_lot' or first_seen_at is null then null
         when stored_escalation is not null then stored_escalation
         when now() >= first_seen_at + interval '15 minutes' then 'window'
         else null
       end as escalation,
       case
         when action_hint = 'exit_full_lot'
           and first_seen_at is not null
           and (escalated_at is not null or now() >= first_seen_at + interval '15 minutes')
           then public.escalated_breach_sentence(
             instrument,
             floor(extract(epoch from (now() - first_seen_at)) / 60)::int)
         else null
       end as sentence
from joined;

comment on view public.v_invalidation_breaches is
  'Open lots whose latest mark is at or below invalidation_price. first_seen_at is the persisted first real print, never a clock with no mark. escalated is the second check or the 15-minute window. review_at_open is never escalated.';

grant select on public.v_invalidation_breaches
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ——— integrity: same checks as 30, plus line_at_or_below_cost ———

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
union all
select 'open_lot_stale_mark', 'warn', steward, lot_table, lot_id::text, instrument,
       format('latest mark is %s minutes old', floor(extract(epoch from (now() - mark_at)) / 60)::int), mark_at
from public.v_open_lot_marks
where mark_at is not null
  and now() - mark_at > case when lot_table = 'position_episodes' then interval '4 days' else interval '6 hours' end
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

-- ——— watchdog: same columns as 56, then escalation ———

create or replace view public.v_ledger_watchdog
with (security_invoker = true)
as
select now() as checked_at,
  (select count(*) from public.v_invalidation_breaches)::integer as invalidation_breaches,
  (select count(*) from public.v_invalidation_breaches where action_hint = 'exit_full_lot')::integer as breaches_actionable,
  (select count(*) from public.v_invalidation_breaches where action_hint = 'review_at_open')::integer as breaches_review_at_open,
  (select count(*) from public.v_open_lots_missing_invalidation)::integer as lots_missing_invalidation,
  (select count(*) from public.v_ledger_integrity)::integer as integrity_issues,
  (select count(*) from public.v_ledger_integrity where severity = 'error')::integer as integrity_errors,
  coalesce((select jsonb_object_agg(c.check_name, c.n)
            from (select check_name, count(*)::integer as n from public.v_ledger_integrity group by check_name) c),
           '{}'::jsonb) as integrity,
  (select count(*) from public.v_open_lot_marks)::integer as open_lots,
  (select count(*) from public.v_exposure_usage where risk_headroom < 0)::integer as exposure_over_budget,
  coalesce((select jsonb_object_agg(x.steward, jsonb_build_object('unit', x.unit, 'open_risk', x.open_risk,
              'risk_budget', x.risk_budget, 'used_share', x.used_share, 'headroom', x.risk_headroom,
              'risk_basis', x.risk_basis))
            from public.v_exposure_usage x), '{}'::jsonb) as exposure,
  coalesce((
    select jsonb_build_object(
      'quantanamo', count(*) filter (where g.steward = 'quantanamo'),
      'oddsborne', count(*) filter (where g.steward = 'oddsborne'),
      'bandit', count(*) filter (where g.steward = 'bandit'),
      'lots', coalesce((
        select jsonb_agg(jsonb_build_object(
          'steward', recent.steward,
          'lot_table', recent.lot_table,
          'lot_id', recent.lot_id
        ) order by recent.closed_at desc)
        from (
          select steward, lot_table, lot_id, closed_at
          from public.v_learning_loop_gaps
          order by closed_at desc
          limit 24
        ) recent
      ), '[]'::jsonb)
    )
    from public.v_learning_loop_gaps g
  ), '{"quantanamo":0,"oddsborne":0,"bandit":0,"lots":[]}'::jsonb) as learning_gaps,
  coalesce((
    select jsonb_build_object(
      'quantanamo', count(*) filter (where c.steward = 'quantanamo'),
      'oddsborne', count(*) filter (where c.steward = 'oddsborne'),
      'bandit', count(*) filter (where c.steward = 'bandit')
    )
    from public.decision_candidates c
    where not public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and coalesce(c.meta->>'superseded', '') <> 'true'
  ), '{"quantanamo":0,"oddsborne":0,"bandit":0}'::jsonb) as unscoreable_decisions,
  (select count(*) from public.v_invalidation_breaches where escalated)::integer as breaches_escalated,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'steward', b.steward,
      'lot_table', b.lot_table,
      'lot_id', b.lot_id,
      'instrument', b.instrument,
      'first_seen_at', b.first_seen_at,
      'breach_age_minutes', b.breach_age_minutes,
      'escalation', b.escalation,
      'sentence', b.sentence
    ) order by b.first_seen_at)
    from public.v_invalidation_breaches b
    where b.escalated
  ), '[]'::jsonb) as escalated;

comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps and unscoreable_decisions are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

grant select on public.v_open_lot_marks, public.v_open_lots_missing_invalidation, public.v_ledger_integrity
  to oddsborne_worker, bandit_worker;

-- ——— what any steward routine reads, and the check it records ———

create or replace function public.escalated_breaches(p jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'steward', b.steward,
    'lot_table', b.lot_table,
    'lot_id', b.lot_id,
    'instrument', b.instrument,
    'first_seen_at', b.first_seen_at,
    'breach_age_minutes', b.breach_age_minutes,
    'mark', b.mark,
    'invalidation_price', b.invalidation_price,
    'escalation', b.escalation,
    'sentence', b.sentence
  ) order by b.first_seen_at), '[]'::jsonb)
  from public.v_invalidation_breaches b
  where b.escalated
    and (nullif(p->>'steward', '') is null or b.steward = p->>'steward')
    and (nullif(p->>'lot_table', '') is null or b.lot_table = p->>'lot_table');
$$;

comment on function public.escalated_breaches(jsonb) is
  'Actionable breaches to exit now. Any steward heartbeat or open-bell reads this and sells its own lots. Does not invent a mark. Empty array when none.';

create or replace function public.note_actionable_breaches(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  r record;
  v_key text := coalesce(nullif(btrim(p->>'check_key'), ''),
    'note:' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI'));
  v_n integer := 0;
begin
  for r in
    select steward, lot_table, lot_id, instrument, mark, mark_at, invalidation_price
    from public.v_invalidation_breaches
    where action_hint = 'exit_full_lot'
      and mark is not null
      and mark_at is not null
      and invalidation_price is not null
  loop
    perform private.note_breach_sighting(
      r.steward, r.lot_table, r.lot_id, r.instrument,
      r.mark, r.mark_at, r.invalidation_price, v_key);
    v_n := v_n + 1;
  end loop;
  update public.invalidation_breach_sightings s
     set cleared_at = now()
   where s.cleared_at is null
     and not exists (
       select 1 from public.v_invalidation_breaches b
       where b.lot_table = s.lot_table
         and b.lot_id = s.lot_id
         and b.action_hint = 'exit_full_lot'
         and b.mark is not null
         and b.mark_at is not null
     );
  return jsonb_build_object(
    'noted', v_n,
    'check_key', v_key,
    'escalated', public.escalated_breaches('{}'::jsonb));
end;
$$;

comment on function public.note_actionable_breaches(jsonb) is
  'One steward check. Records first_seen from the real mark. A later check_key, or a later print, escalates. Pass check_key open_bell:<day> from the open-bell run.';

revoke all on function public.escalated_breaches(jsonb) from public, anon;
revoke all on function public.note_actionable_breaches(jsonb) from public, anon, authenticated;
grant execute on function public.escalated_breaches(jsonb)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
grant execute on function public.note_actionable_breaches(jsonb)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

revoke all on function public.breach_age_label(integer) from public, anon;
revoke all on function public.breach_escalation_state(integer, timestamptz, timestamptz) from public, anon;
revoke all on function public.escalated_breach_sentence(text, integer) from public, anon;
revoke all on function public.replay_actionable_breach_checks(jsonb) from public, anon;
revoke all on function public.line_at_or_below_blended(numeric, numeric) from public, anon;
revoke all on function public.lot_accepts_scratch(jsonb) from public, anon;
revoke all on function public.line_vs_cost_meta(jsonb, numeric, numeric, boolean, boolean, timestamptz) from public, anon;
revoke all on function public.equity_lot_has_add(uuid) from public, anon;
revoke all on function public.pm_lot_has_add(uuid) from public, anon;
revoke all on function public.meme_lot_has_add(uuid) from public, anon;
revoke all on function public.equity_fill_accepts_scratch(uuid) from public, anon;
revoke all on function public.pm_fill_accepts_scratch(uuid) from public, anon;
revoke all on function public.meme_fill_accepts_scratch(uuid) from public, anon;

grant execute on function public.breach_age_label(integer),
  public.breach_escalation_state(integer, timestamptz, timestamptz),
  public.escalated_breach_sentence(text, integer),
  public.line_at_or_below_blended(numeric, numeric),
  public.lot_accepts_scratch(jsonb),
  public.equity_lot_has_add(uuid),
  public.pm_lot_has_add(uuid),
  public.meme_lot_has_add(uuid),
  public.equity_fill_accepts_scratch(uuid),
  public.pm_fill_accepts_scratch(uuid),
  public.meme_fill_accepts_scratch(uuid)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

grant execute on function public.replay_actionable_breach_checks(jsonb),
  public.line_vs_cost_meta(jsonb, numeric, numeric, boolean, boolean, timestamptz)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- Heartbeats note the check and return the sell-now list. heartbeat_at is unchanged.
create or replace function public.oddsborne_touch_heartbeat(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  v_at := public.oddsborne_touch_heartbeat();
  perform public.note_actionable_breaches(jsonb_build_object(
    'check_key', 'heartbeat:oddsborne:' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI')));
  return jsonb_build_object('heartbeat_at', v_at, 'escalated', public.escalated_breaches('{}'::jsonb));
end;
$$;

create or replace function public.bandit_touch_heartbeat(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  update public.desk_agents set heartbeat_at = now(), updated_at = now()
   where slug = 'bandit' returning heartbeat_at into v_at;
  perform public.note_actionable_breaches(jsonb_build_object(
    'check_key', 'heartbeat:bandit:' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI')));
  return jsonb_build_object('heartbeat_at', v_at, 'escalated', public.escalated_breaches('{}'::jsonb));
end;
$$;

create or replace function public.quantanamo_touch_heartbeat(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  update public.desk_agents set heartbeat_at = now(), updated_at = now()
   where slug = 'quantanamo' returning heartbeat_at into v_at;
  perform public.note_actionable_breaches(jsonb_build_object(
    'check_key', 'heartbeat:quantanamo:' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI')));
  return jsonb_build_object('heartbeat_at', v_at, 'escalated', public.escalated_breaches('{}'::jsonb));
end;
$$;

revoke all on function public.oddsborne_touch_heartbeat(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_touch_heartbeat(jsonb) from public, anon, authenticated;
revoke all on function public.quantanamo_touch_heartbeat(jsonb) from public, anon, authenticated;
grant execute on function public.oddsborne_touch_heartbeat(jsonb) to oddsborne_worker, service_role;
grant execute on function public.bandit_touch_heartbeat(jsonb) to bandit_worker, service_role;
grant execute on function public.quantanamo_touch_heartbeat(jsonb) to quantanamo_worker, service_role;

-- Seed first-seen from prints already in the book. Skip a lot with no mark.
insert into public.invalidation_breach_sightings (
  lot_table, lot_id, steward, instrument,
  first_mark_at, first_mark, line_at_first,
  last_mark_at, last_mark, last_line,
  check_count, last_check_key, first_check_at, last_check_at,
  escalated_at, escalation, cleared_at
)
select b.lot_table, b.lot_id, b.steward, b.instrument,
       coalesce(hist.first_at, b.mark_at),
       coalesce(hist.first_px, b.mark),
       b.invalidation_price,
       b.mark_at, b.mark, b.invalidation_price,
       greatest(coalesce(hist.n, 1), 1),
       'backfill:' || coalesce(hist.first_at, b.mark_at)::text,
       now(), now(),
       case when coalesce(hist.n, 1) >= 2 then hist.second_at else null end,
       case when coalesce(hist.n, 1) >= 2 then 'next_check' else null end,
       null
from public.v_invalidation_breaches b
left join lateral (
  select min(px.observed_at) as first_at,
         count(distinct px.observed_at)::integer as n,
         (array_agg(px.last_price order by px.observed_at))[1] as first_px,
         (array_agg(px.observed_at order by px.observed_at))[2] as second_at
  from public.portfolio_exposure px
  join public.position_episodes pe on pe.id = b.lot_id
  where b.lot_table = 'position_episodes'
    and px.symbol = pe.symbol
    and px.account_last4 = right(pe.account_key, 4)
    and px.last_price is not null
    and px.observed_at is not null
    and px.last_price <= pe.invalidation_price
    and public.us_equity_session(px.observed_at) = 'rth'
    and px.observed_at >= pe.opened_at
    and (pe.closed_at is null or px.observed_at <= pe.closed_at)
) hist on true
where b.action_hint = 'exit_full_lot'
  and b.mark is not null
  and b.mark_at is not null
  and b.invalidation_price is not null
on conflict (lot_table, lot_id) do nothing;

-- Open lots only. Closed NBIS stays as written: 227.90 is still above 227.6137.
update public.position_episodes e
   set meta = public.line_vs_cost_meta(
     e.meta, e.invalidation_price, e.average_cost,
     public.equity_lot_has_add(e.id),
     public.lot_accepts_scratch(e.meta) or public.equity_fill_accepts_scratch(e.id),
     now())
 where e.status = 'open'
   and e.meta is distinct from public.line_vs_cost_meta(
     e.meta, e.invalidation_price, e.average_cost,
     public.equity_lot_has_add(e.id),
     public.lot_accepts_scratch(e.meta) or public.equity_fill_accepts_scratch(e.id),
     now());

update public.pm_positions p
   set meta = public.line_vs_cost_meta(
     p.meta, p.invalidation_price, p.average_cost,
     public.pm_lot_has_add(p.id),
     public.lot_accepts_scratch(p.meta) or public.pm_fill_accepts_scratch(p.id),
     now())
 where p.status = 'open'
   and p.meta is distinct from public.line_vs_cost_meta(
     p.meta, p.invalidation_price, p.average_cost,
     public.pm_lot_has_add(p.id),
     public.lot_accepts_scratch(p.meta) or public.pm_fill_accepts_scratch(p.id),
     now());

update public.meme_positions p
   set meta = public.line_vs_cost_meta(
     p.meta, p.invalidation_price, p.average_cost_sol,
     public.meme_lot_has_add(p.id),
     public.lot_accepts_scratch(p.meta) or public.meme_fill_accepts_scratch(p.id),
     now())
 where p.status = 'open'
   and p.meta is distinct from public.line_vs_cost_meta(
     p.meta, p.invalidation_price, p.average_cost_sol,
     public.meme_lot_has_add(p.id),
     public.lot_accepts_scratch(p.meta) or public.meme_fill_accepts_scratch(p.id),
     now());
