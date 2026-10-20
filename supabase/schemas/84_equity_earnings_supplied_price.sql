-- Supplied post-report close.
--
-- earnings_implied.py score --price skips Financial Datasets and sends that
-- close. A close without an open is kept; the open gap stays null. price_source
-- is written on equity_implied_moves.meta beside the score. Pending lots also
-- return the prices already stored, so a later --price keeps a real reference
-- close instead of the straddle underlying.
--
-- Declarative copy: supabase/schemas/84_equity_earnings_supplied_price.sql.
-- Apply after 20261019220000_equity_earnings_score.sql. CREATE OR REPLACE and
-- GRANT are idempotent.

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
  v_price_source text := nullif(btrim(coalesce(p->>'price_source', '')), '');
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
      'price_source', v_row.meta->>'price_source',
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
  elsif v_open is null and v_close is null then
    v_reason := 'no_post_open';
  elsif v_close is null then
    v_reason := 'no_post_close';
  else
    -- A close without an open is the supplied post-report price. The gap stays unknown.
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
    meta = case
      when v_price_source is null then im.meta
      else coalesce(im.meta, '{}'::jsonb) || jsonb_build_object('price_source', v_price_source)
    end,
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
    'price_source', nullif(v_row.meta->>'price_source', ''),
    'outlier', coalesce(v_row.realized_implied_ratio > 1.5, false) or coalesce(v_row.line_jumped, false),
    'n', v_n,
    'thin', v_n < 5
  ));
end;
$$;

comment on function public.steward_record_equity_earnings_score(jsonb) is
  'Record the realized earnings move on an existing equity_implied_moves row and set reported. Percents are recomputed from the bar prices. A missing bar stores score_missing_reason and no price. A later empty read does not erase a stored close. A close sent without an open is kept (the gap stays null). price_source, when named, is written on meta. Does not change open risk.';

revoke all on function public.steward_record_equity_earnings_score(jsonb) from public, anon, authenticated;
grant execute on function public.steward_record_equity_earnings_score(jsonb) to quantanamo_worker, service_role;

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
      'reference_close', im.reference_close,
      'reference_session', im.reference_session,
      'post_open', im.post_open,
      'post_close', im.post_close,
      'post_session', im.post_session,
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
