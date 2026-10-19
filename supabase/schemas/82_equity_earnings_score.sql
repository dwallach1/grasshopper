-- Score a held equity's earnings print against the options-priced move.
-- court-ruling: docs/rules/portfolio-exposure.md
--
-- The open-risk rule is unchanged: until the report is out, risk is still
-- max(line distance, implied move), and a later expiry stays in that max.
-- This migration only records whether the priced move was right, flags a
-- straddle whose expiry is more than 7 days after the report (a loose upper
-- bound; EFX and ROL listed the monthly, and no nearer expiry was stored),
-- and lets the steward write a lesson when one print is an outlier.
-- Nothing here invents a bar. A missing bar is score_missing_reason.
--
-- Apply: supabase/migrations/20261019220000_equity_earnings_score.sql
-- Do not apply from the app. The reviewer applies it.
-- Score NFLX (pm 2026-10-20) and EFX (am 2026-10-20) on the morning of
-- 2026-10-21 with:
--   python3 /workspace/quantanamo/earnings_implied.py score --execute
-- after sync_box.sh. The same scoring runs at the end of
-- `earnings_implied.py write <payload.json> --execute`.

-- ---------------------------------------------------------------- 1. columns. Prices stay; the score sits beside them.
alter table public.equity_implied_moves
  add column if not exists reference_close numeric,
  add column if not exists reference_session date,
  add column if not exists post_open numeric,
  add column if not exists post_close numeric,
  add column if not exists post_session date,
  add column if not exists realized_open_gap numeric,
  add column if not exists realized_close_to_close numeric,
  add column if not exists realized_implied_ratio numeric,
  add column if not exists line_jumped boolean,
  add column if not exists score_missing_reason text,
  add column if not exists score_source text,
  add column if not exists scored_at timestamptz;

alter table public.equity_implied_moves
  drop constraint if exists equity_implied_moves_score_prices_check,
  drop constraint if exists equity_implied_moves_score_gap_check,
  drop constraint if exists equity_implied_moves_score_close_check,
  drop constraint if exists equity_implied_moves_score_ratio_check,
  drop constraint if exists equity_implied_moves_line_jumped_check,
  drop constraint if exists equity_implied_moves_score_reason_check;

alter table public.equity_implied_moves
  add constraint equity_implied_moves_score_prices_check check (
    (reference_close is null or reference_close > 0)
    and (post_open is null or post_open > 0)
    and (post_close is null or post_close > 0)
  ),
  add constraint equity_implied_moves_score_gap_check check (
    realized_open_gap is null or (reference_close > 0 and post_open > 0)
  ),
  add constraint equity_implied_moves_score_close_check check (
    realized_close_to_close is null or (reference_close > 0 and post_close > 0)
  ),
  add constraint equity_implied_moves_score_ratio_check check (
    realized_implied_ratio is null or realized_close_to_close is not null
  ),
  add constraint equity_implied_moves_line_jumped_check check (
    line_jumped is null or post_open is not null
  ),
  add constraint equity_implied_moves_score_reason_check check (
    score_missing_reason is null or score_missing_reason in (
      'bars_unavailable', 'no_reference_bar', 'no_post_open', 'no_post_close'
    )
  );

-- Days from the report to the listed expiry. > 7 is a loose upper bound.
-- Generated so a row written before this migration (EFX, ROL, NFLX) is flagged
-- from the dates already stored. The risk math does not read these columns.
alter table public.equity_implied_moves
  add column if not exists expiry_gap_days integer generated always as (
    case
      when expiry_date is not null and report_date is not null then (expiry_date - report_date)
      else null
    end
  ) stored,
  add column if not exists expiry_loose boolean generated always as (
    coalesce(
      expiry_date is not null and report_date is not null and (expiry_date - report_date) > 7,
      false
    )
  ) stored;

comment on column public.equity_implied_moves.reference_close is
  'Close before the print. AM: prior NYSE session. PM: that session''s close. A real daily bar only.';
comment on column public.equity_implied_moves.post_open is
  'First regular-session open after the print. AM: the report session when it is a session. PM: the next session.';
comment on column public.equity_implied_moves.post_close is
  'Close of that same post session, once the session has closed. Not a partial print.';
comment on column public.equity_implied_moves.realized_open_gap is
  '(post_open - reference_close) / reference_close. Null when either price is missing.';
comment on column public.equity_implied_moves.realized_close_to_close is
  '(post_close - reference_close) / reference_close. The realized move the ratio uses.';
comment on column public.equity_implied_moves.realized_implied_ratio is
  'abs(realized_close_to_close) / (straddle_price / underlying_price). Null without both.';
comment on column public.equity_implied_moves.line_jumped is
  'True when the post-session open went through invalidation_price. Long: open <= line. Short: open >= line. Null when the open or the line is missing.';
comment on column public.equity_implied_moves.score_missing_reason is
  'Set when a real bar is missing: bars_unavailable, no_reference_bar, no_post_open, no_post_close. Never a guessed price.';
comment on column public.equity_implied_moves.expiry_gap_days is
  'expiry_date - report_date, in days. Null when either date is missing.';
comment on column public.equity_implied_moves.expiry_loose is
  'True when the listed expiry is more than 7 days after the report. The implied move is then a loose upper bound. Open risk is unchanged.';

-- A passed report must not wipe the straddle the score compares against.
-- A missing flag still clears prices. A new report date with no new straddle clears both.
create or replace function public.steward_record_equity_implied_move(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_lot uuid;
  v_symbol text;
  v_timing text := nullif(lower(btrim(coalesce(p->>'report_timing', ''))), '');
  v_reported boolean := lower(btrim(coalesce(p->>'reported', ''))) in ('true', 't', '1');
  v_straddle numeric := private.try_numeric(p->>'straddle_price');
  v_underlying numeric := private.try_numeric(p->>'underlying_price');
  v_call numeric := private.try_numeric(p->>'call_price');
  v_put numeric := private.try_numeric(p->>'put_price');
  v_strike numeric := private.try_numeric(p->>'strike');
  v_report date;
  v_expiry date;
  v_observed timestamptz;
  v_source text := nullif(btrim(coalesce(p->>'source', '')), '');
  v_reason text := nullif(btrim(coalesce(p->>'missing_reason', '')), '');
  v_meta jsonb := case when jsonb_typeof(p->'meta') = 'object' then p->'meta' else '{}'::jsonb end;
  v_priced boolean;
  v_kept_straddle numeric;
  v_kept_underlying numeric;
  v_kept_expiry date;
  v_kept_reported boolean;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not record an equity implied move', current_user using errcode = '42501';
  end if;
  if v_steward <> 'quantanamo' then
    raise exception 'refusal:implied_move: equity implied moves are for quantanamo' using errcode = 'P0001';
  end if;
  begin
    v_lot := (p->>'lot_id')::uuid;
  exception when others then
    raise exception 'refusal:implied_move: lot_id is not a uuid' using errcode = 'P0001';
  end;
  if v_lot is null then
    raise exception 'refusal:implied_move: lot_id is required' using errcode = 'P0001';
  end if;
  select pe.symbol into v_symbol
  from public.position_episodes pe
  where pe.id = v_lot and pe.status = 'open';
  if v_symbol is null then
    raise exception 'refusal:implied_move: lot % is not an open equity lot', v_lot using errcode = 'P0001';
  end if;
  if upper(btrim(coalesce(p->>'symbol', ''))) <> upper(v_symbol) then
    raise exception 'refusal:implied_move: symbol does not match lot %', v_symbol using errcode = 'P0001';
  end if;
  if v_timing is not null and v_timing not in ('am', 'pm') then
    raise exception 'refusal:implied_move: report_timing must be am, pm, or omitted' using errcode = 'P0001';
  end if;
  if v_reason is not null and v_reason <> 'implied_move_missing' then
    raise exception 'refusal:implied_move: missing_reason must be implied_move_missing' using errcode = 'P0001';
  end if;
  if v_source is null then
    raise exception 'refusal:implied_move: name the source' using errcode = 'P0001';
  end if;
  begin
    v_report := nullif(btrim(coalesce(p->>'report_date', '')), '')::date;
    v_expiry := nullif(btrim(coalesce(p->>'expiry_date', '')), '')::date;
    v_observed := nullif(btrim(coalesce(p->>'observed_at', '')), '')::timestamptz;
  exception when others then
    raise exception 'refusal:implied_move: report_date, expiry_date and observed_at must be a date or timestamp'
      using errcode = 'P0001';
  end;
  if v_observed is null then
    raise exception 'refusal:implied_move: observed_at is required' using errcode = 'P0001';
  end if;
  if v_observed > pg_catalog.now() + interval '2 minutes' then
    raise exception 'refusal:implied_move: observed_at % is in the future', v_observed using errcode = 'P0001';
  end if;

  v_priced := v_straddle is not null or v_underlying is not null or v_call is not null
    or v_put is not null or v_expiry is not null or v_strike is not null;
  if v_priced then
    if v_reason is not null then
      raise exception 'refusal:implied_move: a flagged lot has no prices' using errcode = 'P0001';
    end if;
    if v_straddle is null or v_straddle <= 0 or v_underlying is null or v_underlying <= 0
       or v_call is null or v_call <= 0 or v_put is null or v_put <= 0
       or v_strike is null or v_strike <= 0 or v_expiry is null then
      raise exception 'refusal:implied_move: straddle, underlying, call, put, strike and expiry are required together'
        using errcode = 'P0001';
    end if;
    if v_straddle <> v_call + v_put then
      raise exception 'refusal:implied_move: straddle_price must be the call mark plus the put mark'
        using errcode = 'P0001';
    end if;
    if v_report is not null and v_expiry < v_report then
      raise exception 'refusal:implied_move: expiry % is before the report %', v_expiry, v_report
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.equity_implied_moves (
    lot_id, symbol, report_date, report_timing, reported,
    straddle_price, underlying_price, call_price, put_price, expiry_date, strike,
    observed_at, source, missing_reason, meta
  ) values (
    v_lot, v_symbol, v_report, v_timing, v_reported,
    v_straddle, v_underlying, v_call, v_put, v_expiry, v_strike,
    v_observed, v_source, v_reason, v_meta
  )
  on conflict (lot_id) do update set
    symbol = excluded.symbol,
    report_date = excluded.report_date,
    report_timing = excluded.report_timing,
    reported = excluded.reported,
    straddle_price = case
      when excluded.missing_reason is not null then null
      when excluded.straddle_price is not null then excluded.straddle_price
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.straddle_price
    end,
    underlying_price = case
      when excluded.missing_reason is not null then null
      when excluded.straddle_price is not null then excluded.underlying_price
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.underlying_price
    end,
    call_price = case
      when excluded.missing_reason is not null then null
      when excluded.straddle_price is not null then excluded.call_price
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.call_price
    end,
    put_price = case
      when excluded.missing_reason is not null then null
      when excluded.straddle_price is not null then excluded.put_price
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.put_price
    end,
    expiry_date = case
      when excluded.missing_reason is not null then null
      when excluded.straddle_price is not null then excluded.expiry_date
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.expiry_date
    end,
    strike = case
      when excluded.missing_reason is not null then null
      when excluded.straddle_price is not null then excluded.strike
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.strike
    end,
    reference_close = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.reference_close
    end,
    reference_session = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.reference_session
    end,
    post_open = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.post_open
    end,
    post_close = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.post_close
    end,
    post_session = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.post_session
    end,
    realized_open_gap = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.realized_open_gap
    end,
    realized_close_to_close = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.realized_close_to_close
    end,
    realized_implied_ratio = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.realized_implied_ratio
    end,
    line_jumped = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.line_jumped
    end,
    score_missing_reason = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.score_missing_reason
    end,
    score_source = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.score_source
    end,
    scored_at = case
      when excluded.report_date is distinct from public.equity_implied_moves.report_date then null
      else public.equity_implied_moves.scored_at
    end,
    observed_at = excluded.observed_at,
    source = excluded.source,
    missing_reason = excluded.missing_reason,
    meta = excluded.meta,
    recorded_by = excluded.recorded_by,
    updated_at = pg_catalog.now()
  returning straddle_price, underlying_price, expiry_date, reported
  into v_kept_straddle, v_kept_underlying, v_kept_expiry, v_kept_reported;

  return jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'lot_id', v_lot,
    'symbol', v_symbol,
    'report_date', v_report,
    'report_timing', v_timing,
    'reported', v_kept_reported,
    'expiry_date', v_kept_expiry,
    'straddle_price', v_kept_straddle,
    'underlying_price', v_kept_underlying,
    'missing_reason', v_reason
  ));
end;
$$;

comment on function public.steward_record_equity_implied_move(jsonb) is
  'Upsert one sourced earnings observation for an open QUANTANAMO lot. A later call with no prices and no implied_move_missing flag keeps the stored straddle (the score needs it) and flips reported. A missing flag clears prices. A different report_date with no new straddle clears prices and the score. Nothing is interpolated.';

-- ---------------------------------------------------------------- 2. score one print from bars the caller already read
create or replace function public.steward_record_equity_earnings_score(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_lot uuid;
  v_symbol text;
  v_status text;
  v_qty numeric;
  v_invalidation numeric;
  v_report date;
  v_timing text;
  v_ref numeric := private.try_numeric(p->>'reference_close');
  v_open numeric := private.try_numeric(p->>'post_open');
  v_close numeric := private.try_numeric(p->>'post_close');
  v_ref_session date;
  v_post_session date;
  v_reason text := nullif(btrim(coalesce(p->>'score_missing_reason', '')), '');
  v_source text := nullif(btrim(coalesce(p->>'score_source', '')), '');
  v_straddle numeric;
  v_underlying numeric;
  v_implied numeric;
  v_gap numeric;
  v_cc numeric;
  v_ratio numeric;
  v_jumped boolean;
  v_old_cc numeric;
  v_n integer;
  v_row public.equity_implied_moves%rowtype;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not score an earnings print', current_user using errcode = '42501';
  end if;
  if v_steward <> 'quantanamo' then
    raise exception 'refusal:earnings_score: equity scores are for quantanamo' using errcode = 'P0001';
  end if;
  begin
    v_lot := (p->>'lot_id')::uuid;
  exception when others then
    raise exception 'refusal:earnings_score: lot_id is not a uuid' using errcode = 'P0001';
  end;
  if v_lot is null then
    raise exception 'refusal:earnings_score: lot_id is required' using errcode = 'P0001';
  end if;
  select pe.symbol, pe.status, pe.quantity, pe.invalidation_price
    into v_symbol, v_status, v_qty, v_invalidation
  from public.position_episodes pe
  where pe.id = v_lot;
  if v_symbol is null then
    raise exception 'refusal:earnings_score: lot % is not an equity lot', v_lot using errcode = 'P0001';
  end if;
  if upper(btrim(coalesce(p->>'symbol', ''))) <> upper(v_symbol) then
    raise exception 'refusal:earnings_score: symbol does not match lot %', v_symbol using errcode = 'P0001';
  end if;
  select im.report_date, im.report_timing, im.straddle_price, im.underlying_price, im.realized_close_to_close
    into v_report, v_timing, v_straddle, v_underlying, v_old_cc
  from public.equity_implied_moves im
  where im.lot_id = v_lot;
  if v_report is null and not found then
    raise exception 'refusal:earnings_score: lot % has no implied-move row', v_lot using errcode = 'P0001';
  end if;
  if v_report is null then
    raise exception 'refusal:earnings_score: lot % has no report date', v_lot using errcode = 'P0001';
  end if;
  -- Clock only. Passing reported=true would make this always succeed.
  if not private.equity_report_passed(v_report, v_timing, false, pg_catalog.now()) then
    raise exception 'refusal:earnings_score: the report for % has not passed', v_symbol using errcode = 'P0001';
  end if;
  if v_reason is not null and v_reason not in (
    'bars_unavailable', 'no_reference_bar', 'no_post_open', 'no_post_close'
  ) then
    raise exception 'refusal:earnings_score: score_missing_reason % is not a bar reason', v_reason
      using errcode = 'P0001';
  end if;
  if v_source is null then
    raise exception 'refusal:earnings_score: name the bar source' using errcode = 'P0001';
  end if;
  begin
    v_ref_session := nullif(btrim(coalesce(p->>'reference_session', '')), '')::date;
    v_post_session := nullif(btrim(coalesce(p->>'post_session', '')), '')::date;
  exception when others then
    raise exception 'refusal:earnings_score: sessions must be dates' using errcode = 'P0001';
  end;
  if v_ref is not null and v_ref <= 0 or v_open is not null and v_open <= 0 or v_close is not null and v_close <= 0 then
    raise exception 'refusal:earnings_score: a bar price must be > 0' using errcode = 'P0001';
  end if;
  if v_post_session is not null and v_ref_session is not null and v_post_session < v_ref_session then
    raise exception 'refusal:earnings_score: post session is before the reference session' using errcode = 'P0001';
  end if;

  -- A later empty read must not erase a close that was already scored.
  if v_old_cc is not null and v_close is null then
    select * into v_row from public.equity_implied_moves where lot_id = v_lot;
    v_implied := case when v_row.straddle_price > 0 and v_row.underlying_price > 0
      then v_row.straddle_price / v_row.underlying_price end;
    select count(*)::integer into v_n
    from public.equity_implied_moves where realized_close_to_close is not null;
    return jsonb_strip_nulls(jsonb_build_object(
      'ok', true, 'replayed', true, 'lot_id', v_lot, 'symbol', v_symbol,
      'reported', true,
      'reference_close', v_row.reference_close,
      'post_open', v_row.post_open,
      'post_close', v_row.post_close,
      'realized_open_gap', v_row.realized_open_gap,
      'realized_close_to_close', v_row.realized_close_to_close,
      'implied_fraction', v_implied,
      'realized_implied_ratio', v_row.realized_implied_ratio,
      'line_jumped', v_row.line_jumped,
      'expiry_loose', v_row.expiry_loose,
      'expiry_gap_days', v_row.expiry_gap_days,
      'score_missing_reason', v_row.score_missing_reason,
      'outlier', coalesce(v_row.realized_implied_ratio > 1.5, false) or coalesce(v_row.line_jumped, false),
      'n', v_n,
      'thin', v_n < 5
    ));
  end if;

  if v_ref is null and v_open is null and v_close is null then
    v_reason := coalesce(v_reason, 'bars_unavailable');
  elsif v_ref is null then
    v_reason := 'no_reference_bar';
    v_open := null;
    v_close := null;
  elsif v_open is null then
    v_reason := 'no_post_open';
    v_close := null;
  elsif v_close is null then
    v_reason := 'no_post_close';
  else
    v_reason := null;
  end if;

  v_gap := case when v_ref > 0 and v_open > 0 then round((v_open - v_ref) / v_ref, 6) end;
  v_cc := case when v_ref > 0 and v_close > 0 then round((v_close - v_ref) / v_ref, 6) end;
  v_implied := case when v_straddle > 0 and v_underlying > 0 then v_straddle / v_underlying end;
  v_ratio := case when v_cc is not null and v_implied > 0 then round(abs(v_cc) / v_implied, 6) end;
  v_jumped := case
    when v_open is null or v_invalidation is null then null
    when coalesce(v_qty, 0) < 0 then v_open >= v_invalidation
    else v_open <= v_invalidation
  end;

  update public.equity_implied_moves im set
    reported = true,
    reference_close = v_ref,
    reference_session = v_ref_session,
    post_open = v_open,
    post_close = v_close,
    post_session = v_post_session,
    realized_open_gap = v_gap,
    realized_close_to_close = v_cc,
    realized_implied_ratio = v_ratio,
    line_jumped = v_jumped,
    score_missing_reason = v_reason,
    score_source = v_source,
    scored_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
  where im.lot_id = v_lot
  returning * into v_row;

  select count(*)::integer into v_n
  from public.equity_implied_moves where realized_close_to_close is not null;

  return jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'lot_id', v_lot,
    'symbol', v_symbol,
    'reported', true,
    'reference_close', v_row.reference_close,
    'reference_session', v_row.reference_session,
    'post_open', v_row.post_open,
    'post_close', v_row.post_close,
    'post_session', v_row.post_session,
    'realized_open_gap', v_row.realized_open_gap,
    'realized_close_to_close', v_row.realized_close_to_close,
    'implied_fraction', v_implied,
    'realized_implied_ratio', v_row.realized_implied_ratio,
    'line_jumped', v_row.line_jumped,
    'expiry_loose', v_row.expiry_loose,
    'expiry_gap_days', v_row.expiry_gap_days,
    'score_missing_reason', v_row.score_missing_reason,
    'outlier', coalesce(v_row.realized_implied_ratio > 1.5, false) or coalesce(v_row.line_jumped, false),
    'n', v_n,
    'thin', v_n < 5
  ));
end;
$$;

comment on function public.steward_record_equity_earnings_score(jsonb) is
  'Record the realized earnings move on an existing equity_implied_moves row and set reported. Percents are recomputed from the bar prices. A missing bar stores score_missing_reason and no price. A later empty read does not erase a stored close. Does not change open risk.';

revoke all on function public.steward_record_equity_earnings_score(jsonb) from public, anon, authenticated;
grant execute on function public.steward_record_equity_earnings_score(jsonb) to quantanamo_worker, service_role;

-- ---------------------------------------------------------------- 3. lots whose report has passed and the close is not scored yet
create or replace function public.steward_earnings_score_pending(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not list earnings scores', current_user using errcode = '42501';
  end if;
  if v_steward <> 'quantanamo' then
    raise exception 'refusal:earnings_score: equity scores are for quantanamo' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'lot_id', pe.id,
      'symbol', pe.symbol,
      'quantity', pe.quantity,
      'invalidation_price', pe.invalidation_price,
      'thesis_id', pe.thesis_id,
      'report_date', im.report_date,
      'report_timing', im.report_timing,
      'straddle_price', im.straddle_price,
      'underlying_price', im.underlying_price,
      'expiry_date', im.expiry_date,
      'expiry_gap_days', im.expiry_gap_days,
      'expiry_loose', im.expiry_loose
    ) order by im.report_date, pe.symbol)
    from public.equity_implied_moves im
    join public.position_episodes pe on pe.id = im.lot_id
    where im.report_date is not null
      and im.realized_close_to_close is null
      and private.equity_report_passed(im.report_date, im.report_timing, im.reported, pg_catalog.now())
  ), '[]'::jsonb);
end;
$$;

comment on function public.steward_earnings_score_pending(jsonb) is
  'Open or closed equity lots whose report has passed and whose close-to-close move is not stored yet. Read-only. earnings_implied.py score reads these.';

revoke all on function public.steward_earnings_score_pending(jsonb) from public, anon, authenticated;
grant execute on function public.steward_earnings_score_pending(jsonb) to quantanamo_worker, service_role;

-- ---------------------------------------------------------------- 4. one outlier print becomes a lesson and a belief. Confidence stays.
create or replace function public.steward_record_earnings_lesson(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_lot uuid;
  v_symbol text;
  v_thesis text;
  v_summary text := btrim(coalesce(p->>'summary', ''));
  v_ratio numeric;
  v_jumped boolean;
  v_implied numeric;
  v_cc numeric;
  v_loose boolean;
  v_n integer;
  v_cycle bigint;
  v_lesson bigint;
  v_belief uuid;
  v_key text;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not write an earnings lesson', current_user using errcode = '42501';
  end if;
  if v_steward <> 'quantanamo' then
    raise exception 'refusal:earnings_lesson: equity lessons are for quantanamo' using errcode = 'P0001';
  end if;
  begin
    v_lot := (p->>'lot_id')::uuid;
  exception when others then
    raise exception 'refusal:earnings_lesson: lot_id is not a uuid' using errcode = 'P0001';
  end;
  if v_lot is null then
    raise exception 'refusal:earnings_lesson: lot_id is required' using errcode = 'P0001';
  end if;
  if length(v_summary) < 20 then
    raise exception 'refusal:earnings_lesson: summary (what the print did, >= 20 chars) is required'
      using errcode = 'P0001';
  end if;
  select pe.symbol, pe.thesis_id into v_symbol, v_thesis
  from public.position_episodes pe
  where pe.id = v_lot;
  if v_symbol is null then
    raise exception 'refusal:earnings_lesson: lot % is not an equity lot', v_lot using errcode = 'P0001';
  end if;
  if v_thesis is null then
    return jsonb_build_object('ok', true, 'skipped', 'no_thesis', 'lot_id', v_lot, 'symbol', v_symbol);
  end if;
  select im.realized_close_to_close, im.realized_implied_ratio, im.line_jumped, im.expiry_loose,
         case when im.straddle_price > 0 and im.underlying_price > 0
           then im.straddle_price / im.underlying_price end
    into v_cc, v_ratio, v_jumped, v_loose, v_implied
  from public.equity_implied_moves im
  where im.lot_id = v_lot;
  if not found then
    raise exception 'refusal:earnings_lesson: lot % has no implied-move row', v_lot using errcode = 'P0001';
  end if;
  if not (coalesce(v_ratio > 1.5, false) or coalesce(v_jumped, false)) then
    return jsonb_build_object('ok', true, 'skipped', 'not_outlier', 'lot_id', v_lot, 'symbol', v_symbol);
  end if;
  if v_cc is null and not coalesce(v_jumped, false) then
    return jsonb_build_object('ok', true, 'skipped', 'score_incomplete', 'lot_id', v_lot, 'symbol', v_symbol);
  end if;

  select b.id into v_belief
  from public.belief_updates b
  where b.meta->>'kind' = 'earnings_print'
    and b.meta->>'lot_id' = v_lot::text
  order by b.observed_at desc
  limit 1;
  if v_belief is not null then
    return jsonb_build_object(
      'ok', true, 'replayed', true, 'belief_update_id', v_belief,
      'lot_id', v_lot, 'symbol', v_symbol, 'thesis_id', v_thesis
    );
  end if;

  select count(*)::integer into v_n
  from public.equity_implied_moves where realized_close_to_close is not null;
  v_key := 'earnings-print:' || v_lot::text;

  insert into public.research_cycles (
    external_key, thesis_id, hypothesis, preregistered_outcome, preregistered_at,
    stage, status, iteration, created_at, updated_at
  ) values (
    v_key, v_thesis,
    'The options price bounds how far this lot can gap on the print.',
    'The close-to-close move stays inside 1.5x that price, and the open does not jump the exit.',
    pg_catalog.now(), 'research', 'open', 1, pg_catalog.now(), pg_catalog.now()
  )
  on conflict (external_key) do update set updated_at = pg_catalog.now()
  returning id into v_cycle;

  select l.id into v_lesson
  from public.research_lessons l
  where l.cycle_id = v_cycle and l.lesson_type = 'earnings_print'
  limit 1;
  if v_lesson is null then
    insert into public.research_lessons (
      cycle_id, thesis_id, lesson_type, summary, incorporated, created_at
    ) values (
      v_cycle, v_thesis, 'earnings_print', v_summary, false, pg_catalog.now()
    )
    returning id into v_lesson;
  end if;

  insert into public.belief_updates (
    thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta
  ) values (
    v_thesis, null, null, v_summary, pg_catalog.now(),
    jsonb_strip_nulls(jsonb_build_object(
      'kind', 'earnings_print',
      'steward', 'quantanamo',
      'lot_table', 'position_episodes',
      'lot_id', v_lot,
      'symbol', v_symbol,
      'writer', 'earnings_implied',
      'research_lesson_id', v_lesson,
      'realized_close_to_close', v_cc,
      'implied_fraction', v_implied,
      'realized_implied_ratio', v_ratio,
      'line_jumped', v_jumped,
      'expiry_loose', v_loose,
      'n', v_n,
      'thin', v_n < 5,
      'confidence_delta', 0
    ))
  )
  returning id into v_belief;

  return jsonb_build_object(
    'ok', true,
    'belief_update_id', v_belief,
    'research_lesson_id', v_lesson,
    'lot_id', v_lot,
    'symbol', v_symbol,
    'thesis_id', v_thesis,
    'thin', v_n < 5,
    'n', v_n
  );
end;
$$;

comment on function public.steward_record_earnings_lesson(jsonb) is
  'One research_lessons row and one belief_updates row (kind earnings_print) when a scored print moved more than 1.5x the priced move or the open jumped the exit. Idempotent per lot. new_confidence is null, so stated confidence and sizing do not move. Not a playbook_rule, so the rule in force stays.';

revoke all on function public.steward_record_earnings_lesson(jsonb) from public, anon, authenticated;
grant execute on function public.steward_record_earnings_lesson(jsonb) to quantanamo_worker, service_role;

-- ---------------------------------------------------------------- 5. the running score. No verdict on a thin sample.
create or replace view public.v_equity_earnings_scorecard
with (security_invoker = true)
as
with s as (
  select
    im.realized_close_to_close,
    im.realized_implied_ratio,
    im.line_jumped,
    im.expiry_loose,
    case when im.straddle_price > 0 and im.underlying_price > 0
      then im.straddle_price / im.underlying_price end as implied_fraction
  from public.equity_implied_moves im
  where im.realized_close_to_close is not null
)
select
  count(*)::integer as n,
  (count(*) < 5) as thin,
  round(avg(abs(s.realized_close_to_close) / nullif(s.implied_fraction, 0)), 4) as mean_realized_implied_ratio,
  count(*) filter (
    where s.implied_fraction > 0 and abs(s.realized_close_to_close) > s.implied_fraction
  )::integer as realized_exceeded_implied,
  count(*) filter (where s.line_jumped)::integer as line_jumped,
  count(*) filter (where s.expiry_loose)::integer as loose_expiry,
  case
    when count(*) < 5 then null
    else format(
      'mean realized/implied %s across %s prints; %s exceeded the priced move; %s jumped the exit',
      to_char(round(avg(abs(s.realized_close_to_close) / nullif(s.implied_fraction, 0)), 2), 'FM999990.00'),
      count(*),
      count(*) filter (where s.implied_fraction > 0 and abs(s.realized_close_to_close) > s.implied_fraction),
      count(*) filter (where s.line_jumped)
    )
  end as verdict
from s;

comment on view public.v_equity_earnings_scorecard is
  'Scored earnings prints. n is closes with a realized move. thin is n < 5, and verdict is null then. mean_realized_implied_ratio is abs(close-to-close) / (straddle / underlying). realized_exceeded_implied counts closes outside the priced move. line_jumped counts opens through the exit. loose_expiry counts straddles more than 7 days after the report. Measurement only; open risk is unchanged.';

revoke all on public.v_equity_earnings_scorecard from public, anon;
grant select on public.v_equity_earnings_scorecard
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create or replace function public.steward_earnings_scorecard(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_row public.v_equity_earnings_scorecard%rowtype;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not read the earnings scorecard', current_user using errcode = '42501';
  end if;
  if v_steward <> 'quantanamo' then
    raise exception 'refusal:earnings_score: equity scores are for quantanamo' using errcode = 'P0001';
  end if;
  select * into v_row from public.v_equity_earnings_scorecard;
  return jsonb_build_object(
    'n', coalesce(v_row.n, 0),
    'thin', coalesce(v_row.thin, true),
    'mean_realized_implied_ratio', v_row.mean_realized_implied_ratio,
    'realized_exceeded_implied', coalesce(v_row.realized_exceeded_implied, 0),
    'line_jumped', coalesce(v_row.line_jumped, 0),
    'loose_expiry', coalesce(v_row.loose_expiry, 0),
    'verdict', v_row.verdict
  );
end;
$$;

comment on function public.steward_earnings_scorecard(jsonb) is
  'One row from public.v_equity_earnings_scorecard. thin is true when fewer than 5 closes are scored, and verdict is null then.';

revoke all on function public.steward_earnings_scorecard(jsonb) from public, anon, authenticated;
grant execute on function public.steward_earnings_scorecard(jsonb) to quantanamo_worker, service_role;
