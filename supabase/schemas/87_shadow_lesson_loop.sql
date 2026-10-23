-- Lessons 151, 152, and 154: score them, do not promote them.
--
-- 152 uses the existing shadow-exit contract (meta.paper_* , v_shadow_exits,
-- v_shadow_exit_scorecard). Rule ah_open_holds_prior_close is not a live exit.
-- It is written only from prices already on the lot and on equity_implied_moves.
-- A missing day-0 open is skipped. Nothing here invents a mark.
--
-- 151 records a cohort-down flag on the pre-print candidate (the lot, or a
-- logged decision). Skipping is scored only when the flag was on and both the
-- entry and the real exit are already stored. It is wired to test 41. Not a rule.
--
-- 154 labels each earnings name ACTIONABLE or SCORE-ONLY from the starter week
-- already stored on the lots (meta.starter.week and meta.starter.of). It does
-- not change that authorization and it does not change who may enter.
--
-- court-ruling: docs/rules/shadow-exits.md
-- The marker names the measurement ruling these rows join. No sizing function moves.

-- ---------------------------------------------------------------- week and session

create or replace function private.us_session_day(p_day date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_day is not null
    and extract(isodow from p_day) between 1 and 5
    and not exists (
      select 1 from public.us_equity_market_calendar c
      where c.day = p_day and c.kind = 'holiday'
    );
$$;

create or replace function private.prior_us_session(p_day date)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select g.day
  from pg_catalog.generate_series(
    (p_day - 1)::timestamp,
    (p_day - 14)::timestamp,
    interval '-1 day'
  ) as gs(at)
  cross join lateral (select gs.at::date as day) g
  where private.us_session_day(g.day)
  order by g.day desc
  limit 1;
$$;

create or replace function private.starter_week_label(p_day date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_day is null then null
    else to_char(s.monday, 'YYYY-MM-DD') || '/' || to_char(s.monday + 4, 'YYYY-MM-DD')
  end
  from (
    select (p_day - (extract(isodow from p_day)::int - 1))::date as monday
  ) s;
$$;

comment on function private.starter_week_label(date) is
  'Monday/Friday label matching position_episodes.meta.starter.week. Does not decide how many starters a week allows.';

-- ---------------------------------------------------------------- 152: after-hours open shadow

create or replace function private.write_ah_open_shadow(p_lot uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meta jsonb;
  v_status text;
  v_entry numeric;
  v_line numeric;
  v_reason text;
  v_fill numeric;
  v_ref numeric;
  v_open numeric;
  v_close numeric;
  v_real numeric;
  v_paper_px numeric;
  v_paper numeric;
  v_triggered boolean;
  v_value jsonb;
begin
  select pe.meta, pe.status, pe.average_cost, pe.invalidation_price
    into v_meta, v_status, v_entry, v_line
  from public.position_episodes pe
  where pe.id = p_lot;
  if v_status is null then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', 'no_lot', 'lot_id', p_lot);
  end if;
  v_reason := coalesce(v_meta->'exit'->>'reason', '');
  if v_reason !~* 'ah[[:space:]].*8[[:space:]]*pm' then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', 'not_ah_exit', 'lot_id', p_lot);
  end if;
  if v_status <> 'closed' then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', 'not_closed', 'lot_id', p_lot);
  end if;
  v_fill := private.jsonb_num(v_meta->'exit'->'price');
  if v_entry is null or v_entry <= 0 or v_fill is null or v_fill <= 0 then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', 'no_fill', 'lot_id', p_lot);
  end if;
  select im.reference_close, im.post_open, im.post_close
    into v_ref, v_open, v_close
  from public.equity_implied_moves im
  where im.lot_id = p_lot;
  if v_ref is null or v_ref <= 0 or v_open is null or v_open <= 0 then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', 'no_open', 'lot_id', p_lot);
  end if;

  v_real := round((v_fill - v_entry) / v_entry * 100, 4);
  v_triggered := v_open >= v_ref;
  if not v_triggered then
    v_paper_px := v_fill;
  elsif v_line is not null and v_line > 0
    and (v_open <= v_line or (v_close is not null and v_close > 0 and v_close <= v_line)) then
    v_paper_px := v_line;
  elsif v_close is not null and v_close > 0 then
    v_paper_px := v_close;
  else
    v_paper_px := null;
  end if;
  v_paper := case
    when v_paper_px is null then null
    else round((v_paper_px - v_entry) / v_entry * 100, 4)
  end;

  v_value := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'rule', 'ah_open_holds_prior_close',
    'lesson_id', 152,
    'test_id', 44,
    'triggered', v_triggered,
    'paper_exit_pct', v_paper,
    'real_exit_pct', v_real,
    'delta_pct_pts', case when v_paper is null then null else v_paper - v_real end,
    'prior_close', v_ref,
    'day0_open', v_open,
    'day0_close', v_close,
    'line', v_line,
    'real_fill', v_fill,
    'paper_exit_price', v_paper_px,
    'source', 'ledger',
    'note', case
      when not v_triggered then 'Day-0 open is below the prior close, so the after-hours exit stands.'
      when v_paper_px is not distinct from v_line then 'The open held the prior close and a stored print is through the line, so the shadow exits at the line.'
      when v_close is not null then 'The open held the prior close. The line is not through the stored open or close, so the shadow is marked at the day-0 close.'
      else 'The open held the prior close. No day-0 close is stored, so the shadow is not scored.'
    end
  ));

  update public.position_episodes
     set meta = coalesce(meta, '{}'::jsonb) || pg_catalog.jsonb_build_object('paper_ah_open_hold', v_value)
   where id = p_lot
     and (meta->'paper_ah_open_hold') is distinct from v_value;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'lot_id', p_lot,
    'rule', 'ah_open_holds_prior_close',
    'triggered', v_triggered,
    'scored', v_paper is not null
  );
end;
$$;

comment on function private.write_ah_open_shadow(uuid) is
  'Write meta.paper_ah_open_hold from the lot fill, the prior close, and the day-0 open already stored. Skips when the open is missing. Does not place an order.';

revoke all on function private.write_ah_open_shadow(uuid) from public, anon;
grant execute on function private.write_ah_open_shadow(uuid) to quantanamo_worker, service_role;

create or replace function public.quantanamo_score_ah_open_shadow(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_lot uuid;
  v_one jsonb;
  v_all jsonb := '[]'::jsonb;
  r record;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not score a shadow exit', current_user using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p->>'lot_id', '')), '') is null then
    for r in
      select pe.id
      from public.position_episodes pe
      where pe.status = 'closed'
        and coalesce(pe.meta->'exit'->>'reason', '') ~* 'ah[[:space:]].*8[[:space:]]*pm'
    loop
      v_one := private.write_ah_open_shadow(r.id);
      v_all := v_all || pg_catalog.jsonb_build_array(v_one);
    end loop;
    return pg_catalog.jsonb_build_object('ok', true, 'lots', v_all);
  end if;
  begin
    v_lot := (p->>'lot_id')::uuid;
  exception when others then
    raise exception 'refusal:shadow: lot_id is not a uuid' using errcode = 'P0001';
  end;
  return private.write_ah_open_shadow(v_lot);
end;
$$;

comment on function public.quantanamo_score_ah_open_shadow(jsonb) is
  'Score lesson 152 for one closed lot, or every closed after-hours exit when lot_id is omitted. Measurement only.';

revoke all on function public.quantanamo_score_ah_open_shadow(jsonb) from public, anon, authenticated;
grant execute on function public.quantanamo_score_ah_open_shadow(jsonb) to quantanamo_worker, service_role;

-- ---------------------------------------------------------------- 151: cohort-down flag

create or replace function private.write_cohort_flag(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lot uuid;
  v_decision uuid;
  v_cohort text := upper(btrim(coalesce(p->>'cohort', '')));
  v_return numeric := private.jsonb_num(p->'cohort_return');
  v_source text := nullif(btrim(coalesce(p->>'source', '')), '');
  v_session date;
  v_opened date;
  v_entry numeric;
  v_outcome numeric;
  v_flagged boolean;
  v_delta numeric;
  v_existing jsonb;
  v_value jsonb;
  v_test int := coalesce(private.jsonb_num(p->'test_id')::int, 41);
begin
  if v_cohort not in ('QQQ', 'SMH') then
    raise exception 'refusal:cohort_flag: cohort must be QQQ or SMH' using errcode = 'P0001';
  end if;
  if v_return is null then
    raise exception 'refusal:cohort_flag: cohort_return is required' using errcode = 'P0001';
  end if;
  if v_return < -1 or v_return > 2 then
    raise exception 'refusal:cohort_flag: cohort_return is not a fraction of price' using errcode = 'P0001';
  end if;
  if v_source is null then
    raise exception 'refusal:cohort_flag: name the price source' using errcode = 'P0001';
  end if;
  if v_test <> 41 then
    raise exception 'refusal:cohort_flag: this flag feeds test 41' using errcode = 'P0001';
  end if;
  begin
    v_session := nullif(btrim(coalesce(p->>'entry_session', '')), '')::date;
  exception when others then
    raise exception 'refusal:cohort_flag: entry_session must be a date' using errcode = 'P0001';
  end;
  if v_session is null then
    raise exception 'refusal:cohort_flag: entry_session is required' using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(p->>'lot_id', '')), '') is not null then
    begin
      v_lot := (p->>'lot_id')::uuid;
    exception when others then
      raise exception 'refusal:cohort_flag: lot_id is not a uuid' using errcode = 'P0001';
    end;
    select (pe.opened_at at time zone 'America/New_York')::date,
           pe.average_cost,
           private.jsonb_num(pe.meta->'exit'->'price'),
           pe.meta->'paper_cohort_down'
      into v_opened, v_entry, v_outcome, v_existing
    from public.position_episodes pe
    where pe.id = v_lot;
    if v_opened is null then
      raise exception 'refusal:cohort_flag: lot % is not an equity lot', v_lot using errcode = 'P0001';
    end if;
    if v_opened <> v_session then
      raise exception 'refusal:cohort_flag: entry_session does not match the lot open' using errcode = 'P0001';
    end if;
  elsif nullif(btrim(coalesce(p->>'decision_id', '')), '') is not null then
    begin
      v_decision := (p->>'decision_id')::uuid;
    exception when others then
      raise exception 'refusal:cohort_flag: decision_id is not a uuid' using errcode = 'P0001';
    end;
    select d.book_price,
           case
             when d.counterfactual_pnl is not null and d.book_price > 0
               then d.book_price + d.counterfactual_pnl
           end,
           d.meta->'paper_cohort_down'
      into v_entry, v_outcome, v_existing
    from public.decision_candidates d
    where d.id = v_decision
      and d.steward = 'quantanamo'
      and d.thesis_id = 'earnings_gap_structure';
    if v_entry is null and v_existing is null and not found then
      raise exception 'refusal:cohort_flag: decision % is not an earnings candidate', v_decision
        using errcode = 'P0001';
    end if;
  else
    raise exception 'refusal:cohort_flag: lot_id or decision_id is required' using errcode = 'P0001';
  end if;

  if v_existing ? 'cohort_return'
     and private.jsonb_num(v_existing->'cohort_return') is distinct from round(v_return, 6) then
    raise exception 'refusal:cohort_flag: cohort return already stored' using errcode = 'P0001';
  end if;

  v_flagged := v_return <= -0.03;
  if v_flagged and v_entry is not null and v_entry > 0 and v_outcome is not null and v_outcome > 0 then
    v_delta := round(-((v_outcome - v_entry) / v_entry) * 100, 4);
  else
    v_delta := null;
  end if;

  v_value := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'rule', 'cohort_down_3pct',
    'lesson_id', 151,
    'test_id', 41,
    'subsplit', 'qqq',
    'cohort', v_cohort,
    'cohort_return', round(v_return, 6),
    'flagged', v_flagged,
    'entry_session', v_session,
    'entry_price', v_entry,
    'outcome_price', case when v_flagged then v_outcome else null end,
    'skip_delta_pct', v_delta,
    'source', coalesce(v_existing->>'source', v_source)
  ));

  if v_lot is not null then
    update public.position_episodes
       set meta = coalesce(meta, '{}'::jsonb) || pg_catalog.jsonb_build_object('paper_cohort_down', v_value)
     where id = v_lot
       and (meta->'paper_cohort_down') is distinct from v_value;
  else
    update public.decision_candidates
       set meta = coalesce(meta, '{}'::jsonb) || pg_catalog.jsonb_build_object('paper_cohort_down', v_value)
     where id = v_decision
       and (meta->'paper_cohort_down') is distinct from v_value;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'rule', 'cohort_down_3pct',
    'test_id', 41,
    'flagged', v_flagged,
    'scored', v_delta is not null,
    'lot_id', v_lot,
    'decision_id', v_decision
  );
end;
$$;

comment on function private.write_cohort_flag(jsonb) is
  'Store lesson 151 on one pre-print candidate. The cohort return is the caller''s sourced fraction. The skip result uses the stored entry and exit only, and only when the flag is on.';

revoke all on function private.write_cohort_flag(jsonb) from public, anon;
grant execute on function private.write_cohort_flag(jsonb) to quantanamo_worker, service_role;

create or replace function private.rescore_cohort_flag(p_lot uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
begin
  select pe.meta->'paper_cohort_down' into v_existing
  from public.position_episodes pe
  where pe.id = p_lot;
  if v_existing is null or not (v_existing ? 'rule') then
    return;
  end if;
  if coalesce((v_existing->>'flagged')::boolean, false) is not true then
    return;
  end if;
  if private.jsonb_num(v_existing->'skip_delta_pct') is not null then
    return;
  end if;
  perform private.write_cohort_flag(pg_catalog.jsonb_build_object(
    'lot_id', p_lot,
    'cohort', v_existing->>'cohort',
    'cohort_return', private.jsonb_num(v_existing->'cohort_return'),
    'source', coalesce(v_existing->>'source', 'ledger'),
    'entry_session', v_existing->>'entry_session',
    'test_id', 41
  ));
end;
$$;

revoke all on function private.rescore_cohort_flag(uuid) from public, anon;
grant execute on function private.rescore_cohort_flag(uuid) to quantanamo_worker, service_role;

create or replace function public.quantanamo_record_cohort_flag(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not record a cohort flag', current_user using errcode = '42501';
  end if;
  return private.write_cohort_flag(p);
end;
$$;

comment on function public.quantanamo_record_cohort_flag(jsonb) is
  'Record lesson 151 for one pre-print candidate. Does not block the entry.';

revoke all on function public.quantanamo_record_cohort_flag(jsonb) from public, anon, authenticated;
grant execute on function public.quantanamo_record_cohort_flag(jsonb) to quantanamo_worker, service_role;

-- ---------------------------------------------------------------- keep the two shadows current

create or replace function public.score_shadow_lesson_trigger()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_table_name = 'position_episodes' and tg_op = 'UPDATE' then
    if (old.meta - 'paper_ah_open_hold' - 'paper_cohort_down')
         is not distinct from (new.meta - 'paper_ah_open_hold' - 'paper_cohort_down')
       and old.status is not distinct from new.status
       and old.closed_at is not distinct from new.closed_at
       and old.average_cost is not distinct from new.average_cost
       and old.invalidation_price is not distinct from new.invalidation_price
       and old.opened_at is not distinct from new.opened_at
    then
      return new;
    end if;
  end if;
  if tg_table_name = 'equity_implied_moves' then
    perform private.write_ah_open_shadow(new.lot_id);
  elsif tg_table_name = 'position_episodes' then
    perform private.write_ah_open_shadow(new.id);
    perform private.rescore_cohort_flag(new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.score_shadow_lesson_trigger() from public, anon;
grant execute on function public.score_shadow_lesson_trigger() to quantanamo_worker, service_role;

drop trigger if exists score_shadow_lesson_on_print on public.equity_implied_moves;
create trigger score_shadow_lesson_on_print
  after insert or update of reference_close, post_open, post_close
  on public.equity_implied_moves
  for each row
  execute function public.score_shadow_lesson_trigger();

drop trigger if exists score_shadow_lesson_on_lot on public.position_episodes;
create trigger score_shadow_lesson_on_lot
  after update of meta, status, closed_at, average_cost, invalidation_price, opened_at
  on public.position_episodes
  for each row
  execute function public.score_shadow_lesson_trigger();

-- ---------------------------------------------------------------- 154: sheet slot

create or replace function private.earnings_sheet_slot(p_event_date date, p_timing text)
returns table (
  slot text,
  week_label text,
  entry_session date,
  starters integer,
  starter_cap integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timing text := lower(btrim(coalesce(p_timing, '')));
  v_entry date;
  v_label text;
  v_starters integer;
  v_cap integer;
begin
  if p_event_date is null or v_timing not in ('am', 'pm') then
    return;
  end if;
  if v_timing = 'am' then
    v_entry := private.prior_us_session(p_event_date);
  elsif private.us_session_day(p_event_date) then
    v_entry := p_event_date;
  else
    v_entry := private.prior_us_session(p_event_date);
  end if;
  v_label := private.starter_week_label(v_entry);
  select count(*)::int into v_starters
  from public.position_episodes pe
  where pe.meta->'starter'->>'week' = v_label
    and pe.meta->'starter' ? 'n';
  select (pe.meta->'starter'->>'of')::int into v_cap
  from public.position_episodes pe
  where pe.meta->'starter'->>'of' ~ '^[0-9]+$'
  order by pe.opened_at desc nulls last
  limit 1;
  slot := case
    when v_cap is not null and v_cap > 0 and v_starters >= v_cap then 'SCORE-ONLY'
    else 'ACTIONABLE'
  end;
  week_label := v_label;
  entry_session := v_entry;
  starters := v_starters;
  starter_cap := v_cap;
  return next;
end;
$$;

comment on function private.earnings_sheet_slot(date, text) is
  'ACTIONABLE or SCORE-ONLY for one print. The cap is the latest meta.starter.of already on the lots. A full week is a label, not a new block.';

revoke all on function private.earnings_sheet_slot(date, text) from public, anon;
grant execute on function private.earnings_sheet_slot(date, text)
  to quantanamo_worker, service_role, authenticated, desk_public_reader;

create or replace function public.earnings_sheet_slot(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_day date;
  v_row record;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not read the earnings sheet', current_user using errcode = '42501';
  end if;
  begin
    v_day := nullif(btrim(coalesce(p->>'event_date', '')), '')::date;
  exception when others then
    raise exception 'refusal:sheet: event_date must be a date' using errcode = 'P0001';
  end;
  if lower(btrim(coalesce(p->>'timing', ''))) not in ('am', 'pm') then
    raise exception 'refusal:sheet: timing must be am or pm' using errcode = 'P0001';
  end if;
  select * into v_row from private.earnings_sheet_slot(v_day, lower(btrim(p->>'timing')));
  if v_row.slot is null then
    raise exception 'refusal:sheet: event_date is required' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'slot', v_row.slot,
    'week', v_row.week_label,
    'entry_session', v_row.entry_session,
    'starters', v_row.starters,
    'starter_cap', v_row.starter_cap,
    'symbol', nullif(upper(btrim(coalesce(p->>'symbol', ''))), '')
  );
end;
$$;

comment on function public.earnings_sheet_slot(jsonb) is
  'Lesson 154 label for one name. SCORE-ONLY means the entry session is in a week that already has its stored starter count. The sizing gate is untouched.';

revoke all on function public.earnings_sheet_slot(jsonb) from public, anon, authenticated;
grant execute on function public.earnings_sheet_slot(jsonb) to quantanamo_worker, service_role;

create or replace view public.v_earnings_sheet
with (security_invoker = true)
as
with names as (
  select distinct on (c.symbol, c.event_date)
    c.symbol,
    c.event_date,
    c.status,
    case
      when c.summary ~* '\mAMC\M|after the close|after close|\mPM\M' then 'pm'
      when c.summary ~* '\mbefore the open\M|\mAM\M' then 'am'
      else null
    end as timing
  from public.catalysts c
  where c.thesis_id = 'earnings_gap_structure'
    and c.symbol is not null
    and c.event_date >= (pg_catalog.now() at time zone 'America/New_York')::date
    and c.event_date < (pg_catalog.now() at time zone 'America/New_York')::date + 21
    and lower(c.status) not in ('cancelled', 'canceled', 'killed', 'passed', 'expired', 'done')
  order by c.symbol, c.event_date, c.created_at desc
)
select n.symbol,
       n.event_date,
       n.timing,
       n.status,
       s.slot,
       s.week_label as week,
       s.entry_session,
       s.starters,
       s.starter_cap
from names n
left join lateral private.earnings_sheet_slot(n.event_date, n.timing) s on n.timing is not null;

comment on view public.v_earnings_sheet is
  'Forward earnings names tagged ACTIONABLE or SCORE-ONLY. Timing that is not written on the catalyst stays unlabeled. Does not size.';

revoke all on public.v_earnings_sheet from public, anon;
grant select on public.v_earnings_sheet
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- desk tally

create or replace function private.shadow_candidate_rows()
returns table (
  candidate_key text,
  lesson_id integer,
  test_id integer,
  thesis_id text,
  steward text,
  kind text,
  checked integer,
  flagged integer,
  n integer,
  mean_delta_pct numeric,
  lcb_delta_pct numeric,
  clips_to_decide integer,
  promotable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with catalog as (
    select *
    from (values
      ('ah_open_holds_prior_close'::text, 152, 44, 'earnings_gap_structure'::text, 'quantanamo'::text, 'exit'::text),
      ('cohort_down_3pct', 151, 41, 'earnings_gap_structure', 'quantanamo', 'entry_flag')
    ) as c(candidate_key, lesson_id, test_id, thesis_id, steward, kind)
  ),
  exits as (
    select
      count(*)::int as n,
      round(avg(delta_pct_pts), 2) as mean_delta_pct,
      case
        when count(*) >= 1 then round(
          avg(delta_pct_pts) - stddev_samp(delta_pct_pts) / sqrt(count(*)::numeric),
          2
        )
      end as lcb_delta_pct
    from public.v_shadow_exits
    where steward = 'quantanamo'
      and rule = 'ah_open_holds_prior_close'
      and delta_pct_pts is not null
  ),
  flags as (
    select
      count(*)::int as checked,
      count(*) filter (where flagged)::int as flagged,
      count(*) filter (where flagged and delta is not null)::int as n,
      round(avg(delta) filter (where flagged and delta is not null), 2) as mean_delta_pct,
      case
        when count(*) filter (where flagged and delta is not null) >= 1 then round(
          avg(delta) filter (where flagged and delta is not null)
            - stddev_samp(delta) filter (where flagged and delta is not null)
              / sqrt((count(*) filter (where flagged and delta is not null))::numeric),
          2
        )
      end as lcb_delta_pct
    from (
      select
        coalesce((v->>'flagged')::boolean, false) as flagged,
        private.jsonb_num(v->'skip_delta_pct') as delta
      from (
        select pe.meta->'paper_cohort_down' as v
        from public.position_episodes pe
        where jsonb_typeof(pe.meta->'paper_cohort_down') = 'object'
          and pe.meta->'paper_cohort_down' ? 'rule'
        union all
        select d.meta->'paper_cohort_down'
        from public.decision_candidates d
        where jsonb_typeof(d.meta->'paper_cohort_down') = 'object'
          and d.meta->'paper_cohort_down' ? 'rule'
          and d.meta->'paper_cohort_down'->>'lot_id' is null
      ) raw
    ) scored
  )
  select
    c.candidate_key,
    c.lesson_id,
    c.test_id,
    c.thesis_id,
    c.steward,
    c.kind,
    case when c.kind = 'exit' then coalesce(e.n, 0) else coalesce(f.checked, 0) end as checked,
    case when c.kind = 'exit' then coalesce(e.n, 0) else coalesce(f.flagged, 0) end as flagged,
    case when c.kind = 'exit' then coalesce(e.n, 0) else coalesce(f.n, 0) end as n,
    case when c.kind = 'exit' then e.mean_delta_pct else f.mean_delta_pct end as mean_delta_pct,
    case when c.kind = 'exit' then e.lcb_delta_pct else f.lcb_delta_pct end as lcb_delta_pct,
    case
      when c.kind = 'exit' then greatest(0, 10 - coalesce(e.n, 0))
      else null
    end as clips_to_decide,
    coalesce(
      c.kind = 'exit' and coalesce(e.n, 0) >= 10 and e.lcb_delta_pct > 0,
      false
    ) as promotable
  from catalog c
  left join exits e on c.kind = 'exit'
  left join flags f on c.kind = 'entry_flag';
$$;

comment on function private.shadow_candidate_rows() is
  'Running tally for lessons 152 and 151. Empty clips stay on the list with n 0. No dollar P/L.';

revoke all on function private.shadow_candidate_rows() from public, anon;
grant execute on function private.shadow_candidate_rows()
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create or replace view public.v_shadow_candidates
with (security_invoker = true)
as
select * from private.shadow_candidate_rows();

comment on view public.v_shadow_candidates is
  'Shadow candidates the Book page reads. Measurement only.';

revoke all on public.v_shadow_candidates from public, anon;
grant select on public.v_shadow_candidates
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- backfill from stored and broker bars
-- Day-0 opens below are Robinhood get_equity_historicals day bounds=regular
-- adjustment=none, read 2026-10-23. They are written only where post_open is
-- still null. Cohort closes are the same bars. The return is computed here;
-- the flag function decides whether -3% was met.

update public.equity_implied_moves im
set post_open = v.open_px,
    realized_open_gap = round((v.open_px - im.reference_close) / im.reference_close, 6),
    line_jumped = case
      when pe.invalidation_price is null then im.line_jumped
      when coalesce(pe.quantity, 0) < 0 then v.open_px >= pe.invalidation_price
      else v.open_px <= pe.invalidation_price
    end,
    meta = coalesce(im.meta, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'open_source', 'robinhood_historicals day bounds=regular adjustment=none',
      'open_recorded_at', '2026-10-23'
    )
from (
  values
    ('d7bd1636-d1f1-4e29-b12e-1076507cfdcd'::uuid, 31.84::numeric),
    ('dd071e52-1dbb-4236-b899-bca0f3a96f4a'::uuid, 64.15::numeric)
) as v(lot_id, open_px)
join public.position_episodes pe on pe.id = v.lot_id
where im.lot_id = v.lot_id
  and im.post_open is null
  and im.reference_close > 0;

-- The print trigger scores the after-hours shadow as the open lands.
-- Record the cohort flag for the four pre-print starters whose entry day is known.

do $$
declare
  v record;
begin
  -- Score every closed after-hours exit from prices already stored, including
  -- the opens written above. A lot with no day-0 open is skipped.
  perform public.quantanamo_score_ah_open_shadow('{}'::jsonb);
  for v in
    select src.lot_id, src.entry_session,
           round((src.day_close - src.prior_close) / src.prior_close, 6) as cohort_return
    from (
      values
        ('dd071e52-1dbb-4236-b899-bca0f3a96f4a'::uuid, date '2026-10-16', 728.000::numeric, 709.800::numeric),
        ('d7bd1636-d1f1-4e29-b12e-1076507cfdcd'::uuid, date '2026-10-19', 709.800::numeric, 718.360::numeric),
        ('d6fb88ea-80fe-4567-8969-6743930d3faa'::uuid, date '2026-10-19', 709.800::numeric, 718.360::numeric),
        ('dcf49ffe-653d-455c-9270-72c4b29f9f09'::uuid, date '2026-10-20', 718.360::numeric, 717.630::numeric)
    ) as src(lot_id, entry_session, prior_close, day_close)
    join public.position_episodes pe on pe.id = src.lot_id
    where (pe.opened_at at time zone 'America/New_York')::date = src.entry_session
  loop
    perform public.quantanamo_record_cohort_flag(pg_catalog.jsonb_build_object(
      'lot_id', v.lot_id,
      'cohort', 'QQQ',
      'cohort_return', v.cohort_return,
      'source', 'robinhood_historicals_rth_close',
      'entry_session', v.entry_session,
      'test_id', 41
    ));
  end loop;
end;
$$;

-- The scoring paths above exist. Close the three lessons. This is the flag
-- only: it does not insert a playbook rule, because none of the three is a rule yet.
update public.research_lessons
set incorporated = true
where id in (151, 152, 154)
  and incorporated = false;
