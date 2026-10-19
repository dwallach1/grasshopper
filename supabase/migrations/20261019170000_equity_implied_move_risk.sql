-- Equity open risk includes the earnings implied move until the report is out.
-- court-ruling: docs/rules/portfolio-exposure.md
--
-- GRASSHOPPER 2026-10-19. A held equity can gap through its invalidation on the print.
-- Until that report is out, the lot's open risk is the max of the line distance and the
-- implied-move risk. Implied-move risk = (ATM straddle at the nearest expiry on or after
-- the report date / underlying price) x position market value. After the report, the line
-- only. A missing straddle or option quote uses the line and flags implied_move_missing.
-- Nothing here invents a price. Names without weeklies (EFX, ROL) keep the later expiry
-- the chain actually listed; that expiry is stored beside the straddle. No correction.
--
-- The steward writes one current row per open lot (public.equity_implied_moves) from the
-- Robinhood earnings calendar and option quotes. private.open_risk_lots reads it.
-- ODDSBORNE and BANDIT are unchanged (full notional). The 10% budget is unchanged.
-- Guidance's new-entry fraction is unchanged; headroom moves only because open lots do.
--
-- v_ledger_watchdog is dropped and recreated with the same body as schema 67 because
-- replacing open_risk_lots (new return columns) drops the views that depend on it.

-- ---------------------------------------------------------------- 1. one observation per open equity lot
create table if not exists public.equity_implied_moves (
  lot_id uuid primary key references public.position_episodes (id) on delete cascade,
  symbol text not null,
  report_date date,
  report_timing text,
  reported boolean not null default false,
  straddle_price numeric,
  underlying_price numeric,
  call_price numeric,
  put_price numeric,
  expiry_date date,
  strike numeric,
  observed_at timestamptz not null,
  source text not null,
  missing_reason text,
  meta jsonb not null default '{}'::jsonb,
  recorded_by text not null default current_user,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equity_implied_moves_timing_check check (report_timing is null or report_timing in ('am', 'pm')),
  constraint equity_implied_moves_source_check check (btrim(source) <> ''),
  constraint equity_implied_moves_flag_check check (missing_reason is null or missing_reason = 'implied_move_missing'),
  constraint equity_implied_moves_legs_check check (
    (
      straddle_price is null and underlying_price is null and call_price is null
      and put_price is null and expiry_date is null and strike is null
    )
    or (
      straddle_price > 0 and underlying_price > 0 and call_price > 0 and put_price > 0
      and expiry_date is not null and strike > 0
      and straddle_price = call_price + put_price
    )
  ),
  constraint equity_implied_moves_flag_prices_check check (
    missing_reason is null or straddle_price is null
  ),
  constraint equity_implied_moves_expiry_check check (
    expiry_date is null or report_date is null or expiry_date >= report_date
  )
);

comment on table public.equity_implied_moves is
  'One current earnings observation per open QUANTANAMO equity lot. report_date and report_timing come from the Robinhood earnings calendar. straddle_price is the ATM call mark plus the ATM put mark at the nearest listed expiry on or after the report date; expiry_date is that expiry (no weekly correction). missing_reason implied_move_missing means the straddle was not available and open risk stays the line distance. Written only through public.steward_record_equity_implied_move. No price is invented.';

comment on column public.equity_implied_moves.straddle_price is
  'Call mark_price + put mark_price, both > 0, same strike, expiry_date. Null when the report has passed or the quotes were missing.';
comment on column public.equity_implied_moves.expiry_date is
  'The listed expiry used for the straddle: the nearest expiration on or after report_date. A monthly expiry weeks after the report (EFX, ROL) is stored as listed.';
comment on column public.equity_implied_moves.missing_reason is
  'implied_move_missing when a pre-report lot has no usable straddle. Null when the straddle is stored, the report has passed, or the calendar has no pending report.';

alter table public.equity_implied_moves enable row level security;

revoke all on table public.equity_implied_moves from public, anon, authenticated;
grant select on table public.equity_implied_moves
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker;
grant insert, update on table public.equity_implied_moves to quantanamo_worker;
grant select, insert, update on table public.equity_implied_moves to service_role;

drop policy if exists equity_implied_moves_reader on public.equity_implied_moves;
create policy equity_implied_moves_reader on public.equity_implied_moves
  for select to desk_public_reader using (true);
drop policy if exists equity_implied_moves_operator on public.equity_implied_moves;
create policy equity_implied_moves_operator on public.equity_implied_moves
  for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists equity_implied_moves_worker_select on public.equity_implied_moves;
create policy equity_implied_moves_worker_select on public.equity_implied_moves
  for select to quantanamo_worker using (true);
drop policy if exists equity_implied_moves_worker_insert on public.equity_implied_moves;
create policy equity_implied_moves_worker_insert on public.equity_implied_moves
  for insert to quantanamo_worker with check (true);
drop policy if exists equity_implied_moves_worker_update on public.equity_implied_moves;
create policy equity_implied_moves_worker_update on public.equity_implied_moves
  for update to quantanamo_worker using (true) with check (true);

-- ---------------------------------------------------------------- 2. the risk rule (pure; open_risk_lots calls it)
create or replace function private.equity_report_passed(
  p_report_date date,
  p_report_timing text,
  p_reported boolean,
  p_at timestamptz
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  -- case, not a chain of `timing = 'am' and ...`: a null timing makes those
  -- comparisons null, and null is not false. Before the clock that would drop
  -- the implied move and flag a lot that has a real straddle.
  select coalesce(p_reported, false)
    or (
      p_report_date is not null and p_at is not null and case
        when p_report_timing = 'am' then p_at >= (p_report_date + time '09:30') at time zone 'America/New_York'
        when p_report_timing = 'pm' then p_at >= (p_report_date + time '20:00') at time zone 'America/New_York'
        else p_at >= ((p_report_date + 1)::timestamp) at time zone 'America/New_York'
      end
    );
$$;

comment on function private.equity_report_passed(date, text, boolean, timestamptz) is
  'True when the earnings print is out: the source has an actual EPS, or p_at is at or after 09:30 America/New_York (am), 20:00 (pm), or the next midnight (no timing).';

revoke all on function private.equity_report_passed(date, text, boolean, timestamptz) from public, anon, authenticated;

create or replace function private.equity_lot_open_risk(
  p_quantity numeric,
  p_mark numeric,
  p_invalidation numeric,
  p_report_date date,
  p_report_timing text,
  p_reported boolean,
  p_straddle numeric,
  p_underlying numeric,
  p_expiry date,
  p_has_observation boolean,
  p_missing_reason text,
  p_at timestamptz
)
returns table (line_risk numeric, implied_move numeric, risk numeric, risk_flag text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_line numeric;
  v_implied numeric;
  v_passed boolean;
  v_pending boolean;
  v_priced boolean;
begin
  -- Line distance. Same as the pre-2026-10-19 equity rule. Unmarked is 0.
  v_line := case
    when p_mark is null then 0
    when p_invalidation is null then p_quantity * p_mark
    else p_quantity * greatest(p_mark - p_invalidation, 0)
  end;
  v_passed := p_report_date is not null
    and private.equity_report_passed(p_report_date, p_report_timing, p_reported, p_at);
  v_pending := p_report_date is not null and not v_passed;
  -- Both option marks and the underlying must be real. A null mark cannot invent market value.
  v_priced := p_straddle > 0 and p_underlying > 0 and p_expiry is not null and p_mark is not null and p_quantity is not null;
  v_implied := case
    when v_pending and v_priced then (p_straddle / p_underlying) * (p_quantity * p_mark)
    else null
  end;
  risk_flag := case
    when v_passed then null
    when p_has_observation and p_report_date is null and p_missing_reason is null then null
    when v_implied is not null then null
    else 'implied_move_missing'
  end;
  line_risk := round(v_line, 6);
  implied_move := round(v_implied, 6);
  risk := round(case when v_implied is null then v_line else greatest(v_line, v_implied) end, 6);
  return next;
end;
$$;

comment on function private.equity_lot_open_risk(numeric, numeric, numeric, date, text, boolean, numeric, numeric, date, boolean, text, timestamptz) is
  'QUANTANAMO equity open risk. Before the report: max(line distance, (straddle / underlying) x qty x mark). After the report: line distance. Missing straddle or no observation: line distance and risk_flag implied_move_missing. Mirrors stewards/quantanamo/earnings_implied.py equity_open_risk.';

revoke all on function private.equity_lot_open_risk(numeric, numeric, numeric, date, text, boolean, numeric, numeric, date, boolean, text, timestamptz)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- 3. per-lot risk (return type grows, so drop dependents first)
drop view if exists public.v_ledger_watchdog;
drop view if exists public.v_exposure_usage;
drop view if exists public.v_exposure_lots;
drop function if exists private.steward_open_risk(text);
drop function if exists private.open_risk_lots();

create function private.open_risk_lots()
returns table (
  steward text, lot_table text, lot_id uuid, instrument text, unit text, quantity numeric,
  mark numeric, mark_at timestamptz, invalidation_price numeric, average_cost numeric,
  risk_basis text, risk numeric, unmarked boolean,
  risk_flag text, report_date date, report_timing text, expiry_date date,
  implied_move numeric, straddle_price numeric, underlying_price numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.steward, m.lot_table, m.lot_id, m.instrument, m.unit, m.quantity, m.mark, m.mark_at,
         m.invalidation_price, c.average_cost,
         private.steward_risk_basis(m.steward),
         case
           when m.lot_table = 'position_episodes' then r.risk
           else round(case
             when m.lot_table = 'pm_positions' then m.quantity * coalesce(m.mark, c.average_cost, 0)
             when m.lot_table = 'meme_positions' then m.quantity * coalesce(c.average_cost, m.mark, 0)
             else 0
           end, 6)
         end,
         case
           when m.lot_table = 'pm_positions' then m.mark is null and c.average_cost is null
           when m.lot_table = 'meme_positions' then c.average_cost is null and m.mark is null
           else m.mark is null
         end,
         case when m.lot_table = 'position_episodes' then r.risk_flag end,
         case when m.lot_table = 'position_episodes' then im.report_date end,
         case when m.lot_table = 'position_episodes' then im.report_timing end,
         case when m.lot_table = 'position_episodes' then im.expiry_date end,
         case when m.lot_table = 'position_episodes' then r.implied_move end,
         case when m.lot_table = 'position_episodes' then im.straddle_price end,
         case when m.lot_table = 'position_episodes' then im.underlying_price end
  from public.v_open_lot_marks m
  left join lateral (
    select coalesce(
      (select p.average_cost from public.pm_positions p where m.lot_table = 'pm_positions' and p.id = m.lot_id),
      (select p.average_cost_sol from public.meme_positions p where m.lot_table = 'meme_positions' and p.id = m.lot_id),
      (select p.average_cost from public.position_episodes p where m.lot_table = 'position_episodes' and p.id = m.lot_id)
    ) as average_cost
  ) c on true
  left join public.equity_implied_moves im
    on m.lot_table = 'position_episodes' and im.lot_id = m.lot_id
  left join lateral private.equity_lot_open_risk(
    m.quantity, m.mark, m.invalidation_price,
    im.report_date, im.report_timing, coalesce(im.reported, false),
    im.straddle_price, im.underlying_price, im.expiry_date,
    im.lot_id is not null, im.missing_reason, now()
  ) r on m.lot_table = 'position_episodes';
$$;

comment on function private.open_risk_lots() is
  'Open risk per open lot. ODDSBORNE binaries and BANDIT memes: full notional. QUANTANAMO equities: line distance, or max(line, implied move) until the earnings report is out. Missing straddle: line distance and risk_flag implied_move_missing. docs/rules/portfolio-exposure.md';

revoke all on function private.open_risk_lots() from public, anon;
grant execute on function private.open_risk_lots()
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create function private.steward_open_risk(p_steward text)
returns table (steward text, unit text, book_equity numeric, open_risk numeric, risk_budget_share numeric,
               risk_budget numeric, risk_headroom numeric, used_share numeric, lots integer,
               lots_unmarked integer, lots_without_invalidation integer, risk_basis text)
language sql
stable
security definer
set search_path = ''
as $$
  with e as (select * from private.steward_book_equity(p_steward)),
  l as (select * from private.open_risk_lots() r where r.steward = p_steward)
  select p_steward,
         coalesce((select e.unit from e), case when p_steward = 'bandit' then 'SOL' else 'USD' end),
         (select e.equity from e),
         round(coalesce(sum(l.risk), 0), 6),
         private.risk_budget_share(),
         round(private.risk_budget_share() * (select e.equity from e), 6),
         round(private.risk_budget_share() * (select e.equity from e) - coalesce(sum(l.risk), 0), 6),
         round(coalesce(sum(l.risk), 0) / nullif((select e.equity from e), 0), 4),
         count(*)::int,
         count(*) filter (where l.unmarked)::int,
         count(*) filter (where l.invalidation_price is null)::int,
         private.steward_risk_basis(p_steward)
  from l;
$$;

comment on function private.steward_open_risk(text) is
  'Open risk per book vs a 10%-of-book budget: sum of private.open_risk_lots(). Gap-prone ODDSBORNE / BANDIT lots at full notional. QUANTANAMO equities: max(line, implied move) until the earnings report is out, then the line. docs/rules/portfolio-exposure.md';

revoke all on function private.steward_open_risk(text) from public, anon;
grant execute on function private.steward_open_risk(text)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create view public.v_exposure_usage
with (security_invoker = true)
as
select r.* from unnest(array['quantanamo', 'oddsborne', 'bandit']) s(steward)
cross join lateral private.steward_open_risk(s.steward) r;

grant select on public.v_exposure_usage
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create view public.v_exposure_lots
with (security_invoker = true)
as
select * from private.open_risk_lots();

comment on view public.v_exposure_lots is
  'Per-lot open risk. Equities carry risk_flag (implied_move_missing when the straddle is absent before the report), report_date, expiry_date and implied_move. docs/rules/portfolio-exposure.md';

grant select on public.v_exposure_lots
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- Same body as supabase/schemas/67_breach_escalation_line_after_add.sql.
create view public.v_ledger_watchdog
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

-- ---------------------------------------------------------------- 4. steward writes (steward-rpc allowlist)
create or replace function public.steward_open_equity_lots(p jsonb)
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
    raise exception 'refusal:auth: % may not list equity lots', current_user using errcode = '42501';
  end if;
  if v_steward <> 'quantanamo' then
    raise exception 'refusal:implied_move: equity implied moves are for quantanamo' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'lot_id', pe.id,
      'symbol', pe.symbol,
      'quantity', pe.quantity
    ) order by pe.symbol)
    from public.position_episodes pe
    where pe.status = 'open' and pe.quantity > 0
  ), '[]'::jsonb);
end;
$$;

comment on function public.steward_open_equity_lots(jsonb) is
  'Open QUANTANAMO equity lots (id, symbol, quantity) for the earnings implied-move sweep. Read-only.';

revoke all on function public.steward_open_equity_lots(jsonb) from public, anon, authenticated;
grant execute on function public.steward_open_equity_lots(jsonb) to quantanamo_worker, service_role;

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
    straddle_price = excluded.straddle_price,
    underlying_price = excluded.underlying_price,
    call_price = excluded.call_price,
    put_price = excluded.put_price,
    expiry_date = excluded.expiry_date,
    strike = excluded.strike,
    observed_at = excluded.observed_at,
    source = excluded.source,
    missing_reason = excluded.missing_reason,
    meta = excluded.meta,
    recorded_by = excluded.recorded_by,
    updated_at = pg_catalog.now();

  return jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'lot_id', v_lot,
    'symbol', v_symbol,
    'report_date', v_report,
    'report_timing', v_timing,
    'reported', v_reported,
    'expiry_date', v_expiry,
    'straddle_price', v_straddle,
    'underlying_price', v_underlying,
    'missing_reason', v_reason
  ));
end;
$$;

comment on function public.steward_record_equity_implied_move(jsonb) is
  'Upsert one sourced earnings observation for an open QUANTANAMO lot. Prices are Robinhood option marks and the equity quote used to pick the ATM strike. missing_reason implied_move_missing with no prices flags the lot. A later call replaces the row, including clearing a stale straddle. Nothing is interpolated.';

revoke all on function public.steward_record_equity_implied_move(jsonb) from public, anon, authenticated;
grant execute on function public.steward_record_equity_implied_move(jsonb) to quantanamo_worker, service_role;

-- Mechanism text only. The 10% budget, full notional on the other books, and the ruling stay.
update public.desk_rules
set mechanism = $mech$`private.open_risk_lots()` (per lot, `public.v_exposure_lots`) summed by `private.steward_open_risk` (`public.v_exposure_usage`), in the book unit, `risk_basis` per book. QUANTANAMO equities stay `to_invalidation` on the line. Until the earnings report is out, a lot's open risk is the max of that line distance and the implied-move risk (GRASSHOPPER 2026-10-19). Line distance is qty x max(mark - invalidation_price, 0) (no invalidation: qty x mark; unmarked: 0, flagged). Implied-move risk is (ATM straddle price at the nearest expiry on or after the report date / underlying price) x position market value (qty x mark). The steward stores the report date, the straddle, the underlying and the expiry it used on `public.equity_implied_moves` (Robinhood earnings calendar and option quotes; a name without weeklies keeps that later expiry, no correction). Once the report has passed (an actual EPS, or 09:30 America/New_York on an am date, 20:00 on a pm date, or the next midnight when the source gives no am/pm), open risk is the line distance only. Missing straddle or option data uses the line distance and flags the lot `implied_move_missing`. No price is fabricated. ODDSBORNE binaries and BANDIT memes `full_notional`: every open binary at price x contracts (mark, else average cost) and every meme lot at its full cost basis (qty x average cost, else qty x mark). Budget 10% of book. Guidance sizes a new entry to fit: min(requested, max_stake, cash, headroom / risk fraction), where the fraction is 1 for full_notional books and (entry - invalidation) / entry for equities (1 without p_entry_price); no headroom -> `exposure_cap`. Guidance, v_exposure_usage and the v_ledger_watchdog `exposure` summary carry `risk_basis`.$mech$,
    owner_paths = array[
      'supabase/schemas/41_court_decisions.sql',
      'supabase/schemas/44_exposure_gap_full_notional.sql',
      'supabase/schemas/80_equity_implied_move_risk.sql',
      'stewards/quantanamo/earnings_implied.py',
      'stewards/quantanamo/steward_rpc.py'
    ]::text[],
    updated_at = now()
where rule_id = 'portfolio-exposure';
