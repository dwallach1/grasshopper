-- Open equity lots with no current earnings implied-move row.
-- A missed write shows up as v_ledger_watchdog.equity_implied_move_gaps.
-- The 10% budget, the risk rule, and /api/health stay as they are.
-- The predicate matches stewards/quantanamo/earnings_implied.py is_implied_move_gap.

-- ---------------------------------------------------------------- 1. the gap predicate (pure; the view and the tests call it)
create or replace function public.equity_implied_move_is_gap(
  p_has_row boolean,
  p_report_date date,
  p_report_timing text,
  p_reported boolean,
  p_straddle numeric,
  p_missing_reason text,
  p_at timestamptz
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  -- No row: the sweep never wrote. A report still ahead with no straddle and no
  -- implied_move_missing flag is the same gap. A priced straddle, a passed report,
  -- a checked calendar with nothing pending, or a missing flag is current.
  -- The clock matches private.equity_report_passed (09:30 / 20:00 / next midnight ET).
  select case
    when coalesce(p_has_row, false) = false then true
    when p_report_date is null then false
    when p_straddle > 0 then false
    when p_missing_reason is not null then false
    when coalesce(p_reported, false) then false
    when case
      when p_report_timing = 'am' then p_at >= (p_report_date + time '09:30') at time zone 'America/New_York'
      when p_report_timing = 'pm' then p_at >= (p_report_date + time '20:00') at time zone 'America/New_York'
      else p_at >= ((p_report_date + 1)::timestamp) at time zone 'America/New_York'
    end then false
    else true
  end;
$$;

comment on function public.equity_implied_move_is_gap(boolean, date, text, boolean, numeric, text, timestamptz) is
  'True when an open equity lot has no current implied-move row. No row, or a report still ahead with no straddle and no implied_move_missing flag. Mirrors stewards/quantanamo/earnings_implied.py is_implied_move_gap.';

revoke all on function public.equity_implied_move_is_gap(boolean, date, text, boolean, numeric, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.equity_implied_move_is_gap(boolean, date, text, boolean, numeric, text, timestamptz)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 2. the lots
create or replace view public.v_equity_implied_move_gaps
with (security_invoker = true)
as
select pe.id as lot_id, pe.symbol, pe.quantity
from public.position_episodes pe
left join public.equity_implied_moves im on im.lot_id = pe.id
where pe.status = 'open'
  and pe.quantity > 0
  and public.equity_implied_move_is_gap(
    im.lot_id is not null,
    im.report_date,
    im.report_timing,
    coalesce(im.reported, false),
    im.straddle_price,
    im.missing_reason,
    now()
  );

comment on view public.v_equity_implied_move_gaps is
  'Open QUANTANAMO equity lots with no current implied-move row: no equity_implied_moves row, or a report still ahead with no straddle and no implied_move_missing flag. A missed write stays here. A priced straddle, a passed report, or implied_move_missing does not.';

revoke all on public.v_equity_implied_move_gaps from public, anon;
grant select on public.v_equity_implied_move_gaps
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 3. one watchdog column, appended. Same body as schema 80 otherwise.
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
  ), '[]'::jsonb) as escalated,
  (select count(*)::integer from public.v_equity_implied_move_gaps) as equity_implied_move_gaps;


comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, and equity_implied_move_gaps are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. equity_implied_move_gaps counts open equity lots with a report still ahead and no current implied-move row.';

comment on column public.v_ledger_watchdog.equity_implied_move_gaps is
  'Open equity lots in public.v_equity_implied_move_gaps. A missed implied-move write stays in this count. It does not make /api/health not-ok.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 4. plan reads the same lots (steward-rpc allowlist)
create or replace function public.steward_implied_move_gaps(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not list implied-move gaps', current_user using errcode = '42501';
  end if;
  if v_steward <> 'quantanamo' then
    raise exception 'refusal:implied_move: equity implied moves are for quantanamo' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'lot_id', g.lot_id,
      'symbol', g.symbol,
      'quantity', g.quantity
    ) order by g.symbol, g.lot_id)
    from public.v_equity_implied_move_gaps g
  ), '[]'::jsonb);
end;
$$;

comment on function public.steward_implied_move_gaps(jsonb) is
  'Open QUANTANAMO equity lots that lack a current implied-move row (report still ahead, or never written). Read-only. earnings_implied.py plan prints these and the Robinhood calls.';

revoke all on function public.steward_implied_move_gaps(jsonb) from public, anon, authenticated;
grant execute on function public.steward_implied_move_gaps(jsonb) to quantanamo_worker, service_role;
