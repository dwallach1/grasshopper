-- Horizon and closing-line marks for logged decisions.
--
-- What was wrong: private.resolve_marked_decisions (56) only looks for a meme price in
-- meme_fills, meme_tokens.last_price_sol and meme_positions.mark_sol. All three are written
-- by BANDIT's clip scripts for mints it holds or traded. A pass is a mint BANDIT did not buy,
-- so nothing ever priced it, and every BANDIT pass sat at resolve_status = 'no_mark_yet'
-- once its 4 hours were up. QUANTANAMO's equity passes have the same shape (the mark comes
-- from portfolio_exposure / broker_fills, which only hold tickers it owns or traded).
--
-- public.decision_marks holds one real, sourced price per decision per kind:
--   horizon  BANDIT and QUANTANAMO. The first real price observed at or after the decision's
--            horizon (meme: decided_at + 4h; equity: close of the 5th regular session).
--            horizon_at is computed here, never taken from the caller. Insert once; a replay
--            returns the stored mark. The resolver reads it alongside the ledger prints.
--   close    ODDSBORNE closing-line value. The last mid of the decision's own side on the
--            Polymarket US book, observed after the decision and before the event starts
--            (and before market close). Re-recording keeps the later observation.
-- No price is invented or interpolated. When no source has a price at all (a rugged or
-- delisted coin), the steward records no_price_reason and the decision is flagged
-- unscoreable with that reason instead.

-- ——— table ———

create table if not exists public.decision_marks (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decision_candidates (id) on delete cascade,
  steward text not null,
  mark_kind text not null,
  price numeric not null,
  unit text not null,
  observed_at timestamptz not null,
  horizon_at timestamptz,
  event_start_at timestamptz,
  source text not null,
  meta jsonb not null default '{}'::jsonb,
  recorded_by text not null default current_user,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint decision_marks_one_per_kind unique (decision_id, mark_kind),
  constraint decision_marks_kind_check check (mark_kind in ('horizon', 'close')),
  constraint decision_marks_kind_steward_check check (
    (mark_kind = 'horizon' and steward in ('bandit', 'quantanamo'))
    or (mark_kind = 'close' and steward = 'oddsborne')
  ),
  constraint decision_marks_price_check check (price > 0 and (mark_kind <> 'close' or price < 1)),
  constraint decision_marks_source_check check (btrim(source) <> ''),
  constraint decision_marks_timing_check check (
    (mark_kind = 'horizon' and horizon_at is not null and observed_at >= horizon_at and event_start_at is null)
    or (mark_kind = 'close' and event_start_at is not null and observed_at < event_start_at and horizon_at is null)
  )
);

comment on table public.decision_marks is
  'One real, sourced price per decision per mark_kind. horizon (BANDIT, QUANTANAMO): first price observed at or after the decision horizon, horizon_at computed by the database. close (ODDSBORNE): last mid of the logged side before event start, for closing-line value. Never invented or interpolated. Written through public.steward_record_decision_mark.';
comment on column public.decision_marks.price is
  'horizon: SOL per token (meme) or USD per share (equity). close: mid of the side the decision names (the same terms as decision_candidates.book_price for that side), strictly between 0 and 1.';
comment on column public.decision_marks.observed_at is
  'When the price was observed at the source. horizon: at or after horizon_at. close: after decided_at and before event_start_at.';

create index if not exists decision_marks_decision_idx on public.decision_marks (decision_id);

alter table public.decision_marks enable row level security;

revoke all on table public.decision_marks from public, anon, authenticated;
grant select on table public.decision_marks
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker;
grant select, insert, update on table public.decision_marks to service_role;
grant insert on table public.decision_marks to quantanamo_worker, bandit_worker;
grant insert, update on table public.decision_marks to oddsborne_worker;

drop policy if exists desk_public_reader_select on public.decision_marks;
create policy desk_public_reader_select on public.decision_marks
  for select to desk_public_reader using (true);
drop policy if exists ledger_operator_select on public.decision_marks;
create policy ledger_operator_select on public.decision_marks
  for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists steward_worker_select on public.decision_marks;
create policy steward_worker_select on public.decision_marks
  for select to quantanamo_worker, oddsborne_worker, bandit_worker using (true);
drop policy if exists bandit_worker_insert on public.decision_marks;
create policy bandit_worker_insert on public.decision_marks
  for insert to bandit_worker with check (steward = 'bandit' and mark_kind = 'horizon');
drop policy if exists quantanamo_worker_insert on public.decision_marks;
create policy quantanamo_worker_insert on public.decision_marks
  for insert to quantanamo_worker with check (steward = 'quantanamo' and mark_kind = 'horizon');
drop policy if exists oddsborne_worker_insert on public.decision_marks;
create policy oddsborne_worker_insert on public.decision_marks
  for insert to oddsborne_worker with check (steward = 'oddsborne' and mark_kind = 'close');
drop policy if exists oddsborne_worker_update on public.decision_marks;
create policy oddsborne_worker_update on public.decision_marks
  for update to oddsborne_worker
  using (steward = 'oddsborne' and mark_kind = 'close')
  with check (steward = 'oddsborne' and mark_kind = 'close');

-- ——— horizon of a decision (one definition for the resolver, the guard and the RPCs) ———

create or replace function private.decision_horizon_at(p_venue text, p_decided_at timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_venue = 'meme' then p_decided_at + interval '4 hours'
    when p_venue = 'equity' then private.nth_equity_session_close(p_decided_at, 5)
    else null
  end;
$$;

revoke all on function private.decision_horizon_at(text, timestamptz) from public, anon, authenticated;
grant execute on function private.decision_horizon_at(text, timestamptz)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

comment on function private.decision_horizon_at(text, timestamptz) is
  'Scoring horizon of an equity or meme decision: meme = decided_at + 4h (BANDIT clip time stop); equity = close of the 5th regular NYSE session after the decision. Null for prediction (scored at resolution).';

-- ——— guard: the row's steward, horizon and timing come from the decision, not the caller ———

create or replace function private.decision_marks_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_close timestamptz;
begin
  select c.steward, c.venue, c.decided_at, c.market_id
    into d
  from public.decision_candidates c
  where c.id = new.decision_id;
  if not found then
    raise exception 'refusal:decision_mark: decision % not found', new.decision_id using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and (new.decision_id <> old.decision_id or new.mark_kind <> old.mark_kind) then
    raise exception 'refusal:decision_mark: decision_id and mark_kind are fixed' using errcode = 'P0001';
  end if;
  new.steward := d.steward;
  new.updated_at := pg_catalog.now();
  if new.observed_at > pg_catalog.now() + interval '2 minutes' then
    raise exception 'refusal:decision_mark: observed_at % is in the future', new.observed_at using errcode = 'P0001';
  end if;

  if new.mark_kind = 'horizon' then
    if d.venue not in ('meme', 'equity') then
      raise exception 'refusal:decision_mark: horizon marks are for meme and equity decisions' using errcode = 'P0001';
    end if;
    new.horizon_at := private.decision_horizon_at(d.venue, d.decided_at);
    new.event_start_at := null;
    new.unit := case when d.venue = 'meme' then 'SOL per token' else 'USD per share' end;
    if new.horizon_at is null or new.horizon_at > pg_catalog.now() then
      raise exception 'refusal:decision_mark: horizon % has not passed', new.horizon_at using errcode = 'P0001';
    end if;
    if new.observed_at < new.horizon_at then
      raise exception 'refusal:decision_mark: observed_at % is before the horizon %', new.observed_at, new.horizon_at
        using errcode = 'P0001';
    end if;
  elsif new.mark_kind = 'close' then
    if d.venue <> 'prediction' then
      raise exception 'refusal:decision_mark: close marks are for prediction decisions' using errcode = 'P0001';
    end if;
    new.horizon_at := null;
    new.unit := 'side price (0 to 1)';
    if new.event_start_at is null then
      raise exception 'refusal:decision_mark: a close mark needs event_start_at' using errcode = 'P0001';
    end if;
    if new.observed_at < d.decided_at then
      raise exception 'refusal:decision_mark: observed_at % is before the decision %', new.observed_at, d.decided_at
        using errcode = 'P0001';
    end if;
    if new.observed_at >= new.event_start_at then
      raise exception 'refusal:decision_mark: observed_at % is not before event start %', new.observed_at, new.event_start_at
        using errcode = 'P0001';
    end if;
    if d.market_id is not null then
      select m.close_time into v_close from public.pm_markets m where m.id = d.market_id;
      if v_close is not null and new.observed_at >= v_close then
        raise exception 'refusal:decision_mark: observed_at % is not before market close %', new.observed_at, v_close
          using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.decision_marks_guard() from public, anon, authenticated;

drop trigger if exists decision_marks_guard on public.decision_marks;
create trigger decision_marks_guard
  before insert or update on public.decision_marks
  for each row
  execute function private.decision_marks_guard();

-- ——— resolver: the horizon mark is one more real print ———

create or replace function private.resolve_marked_decisions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched integer := 0;
  marked integer := 0;
  waiting integer := 0;
begin
  -- Equity: earliest real print at or after the 5th session close. One share.
  with marks as (
    select c.id,
      c.side,
      c.book_price,
      mk.price,
      mk.at,
      mk.source,
      mk.mark_id,
      private.nth_equity_session_close(c.decided_at, 5) as horizon_at
    from public.decision_candidates c
    join lateral (
      select s.price, s.at, s.source, s.mark_id
      from (
        select e.last_price as price, e.observed_at as at, 'portfolio_exposure.last_price'::text as source, null::uuid as mark_id
        from public.portfolio_exposure e
        where e.symbol = c.instrument
          and e.last_price is not null
          and e.last_price > 0
          and e.observed_at >= private.nth_equity_session_close(c.decided_at, 5)
        union all
        select f.price, f.executed_at, 'broker_fills.price', null::uuid
        from public.broker_fills f
        join public.trade_intents i on i.id = f.trade_intent_id
        where i.symbol = c.instrument
          and f.price is not null
          and f.price > 0
          and f.executed_at >= private.nth_equity_session_close(c.decided_at, 5)
        union all
        select dm.price, dm.observed_at, 'decision_marks:' || dm.source, dm.id
        from public.decision_marks dm
        where dm.decision_id = c.id
          and dm.mark_kind = 'horizon'
          and dm.observed_at >= private.nth_equity_session_close(c.decided_at, 5)
      ) s
      where s.price is not null
      order by s.at asc
      limit 1
    ) mk on true
    where c.venue = 'equity'
      and c.counterfactual_pnl is null
      and c.side in ('long', 'short')
      and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and private.nth_equity_session_close(c.decided_at, 5) is not null
      and private.nth_equity_session_close(c.decided_at, 5) <= pg_catalog.now()
  )
  update public.decision_candidates c set
    counterfactual_pnl = case
      when m.side = 'long' then m.price - m.book_price
      else m.book_price - m.price
    end,
    resolved_at = coalesce(c.resolved_at, m.at),
    meta = jsonb_strip_nulls(c.meta || jsonb_build_object(
      'horizon', '5 equity sessions',
      'horizon_at', m.horizon_at,
      'resolve_status', 'marked',
      'mark_price', m.price,
      'mark_at', m.at,
      'mark_source', m.source,
      'mark_id', m.mark_id,
      'unit', 'USD per share'
    )),
    updated_at = pg_catalog.now()
  from marks m
  where c.id = m.id
    and m.price is not null;
  get diagnostics marked = row_count;
  touched := touched + marked;

  -- Meme: earliest real print at or after 4 hours. One token.
  with marks as (
    select c.id,
      c.side,
      c.book_price,
      mk.price,
      mk.at,
      mk.source,
      mk.mark_id
    from public.decision_candidates c
    join lateral (
      select s.price, s.at, s.source, s.mark_id
      from (
        select f.price_sol as price, f.executed_at as at, 'meme_fills.price_sol'::text as source, null::uuid as mark_id
        from public.meme_fills f
        join public.meme_orders o on o.id = f.order_id
        join public.meme_tokens t on t.id = o.token_id
        where (t.mint = c.instrument or upper(t.symbol) = upper(c.instrument))
          and f.price_sol is not null
          and f.price_sol > 0
          and f.executed_at >= c.decided_at + interval '4 hours'
        union all
        select t.last_price_sol, t.last_marked_at, 'meme_tokens.last_price_sol', null::uuid
        from public.meme_tokens t
        where (t.mint = c.instrument or upper(t.symbol) = upper(c.instrument))
          and t.last_price_sol is not null
          and t.last_price_sol > 0
          and t.last_marked_at >= c.decided_at + interval '4 hours'
        union all
        select p.mark_sol, p.mark_at, 'meme_positions.mark_sol', null::uuid
        from public.meme_positions p
        join public.meme_tokens t on t.id = p.token_id
        where (t.mint = c.instrument or upper(t.symbol) = upper(c.instrument))
          and p.mark_sol is not null
          and p.mark_sol > 0
          and p.mark_at >= c.decided_at + interval '4 hours'
        union all
        select dm.price, dm.observed_at, 'decision_marks:' || dm.source, dm.id
        from public.decision_marks dm
        where dm.decision_id = c.id
          and dm.mark_kind = 'horizon'
          and dm.observed_at >= c.decided_at + interval '4 hours'
      ) s
      where s.price is not null and s.at is not null
      order by s.at asc
      limit 1
    ) mk on true
    where c.venue = 'meme'
      and c.counterfactual_pnl is null
      and c.side in ('long', 'short')
      and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and c.decided_at + interval '4 hours' <= pg_catalog.now()
  )
  update public.decision_candidates c set
    counterfactual_pnl = case
      when m.side = 'long' then m.price - m.book_price
      else m.book_price - m.price
    end,
    resolved_at = coalesce(c.resolved_at, m.at),
    meta = jsonb_strip_nulls(c.meta || jsonb_build_object(
      'horizon', '4 hours',
      'horizon_at', c.decided_at + interval '4 hours',
      'resolve_status', 'marked',
      'mark_price', m.price,
      'mark_at', m.at,
      'mark_source', m.source,
      'mark_id', m.mark_id,
      'unit', 'SOL per token'
    )),
    updated_at = pg_catalog.now()
  from marks m
  where c.id = m.id;
  get diagnostics marked = row_count;
  touched := touched + marked;

  -- Horizon has passed and nothing has a mark yet. Say so. Do not invent one.
  update public.decision_candidates c set
    meta = c.meta || jsonb_build_object(
      'resolve_status', 'no_mark_yet',
      'horizon', case when c.venue = 'equity' then '5 equity sessions' else '4 hours' end
    ),
    updated_at = pg_catalog.now()
  where c.venue in ('equity', 'meme')
    and c.counterfactual_pnl is null
    and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
    and coalesce(c.meta->>'resolve_status', '') is distinct from 'no_mark_yet'
    and (
      (c.venue = 'meme' and c.decided_at + interval '4 hours' <= pg_catalog.now())
      or (c.venue = 'equity'
          and private.nth_equity_session_close(c.decided_at, 5) is not null
          and private.nth_equity_session_close(c.decided_at, 5) <= pg_catalog.now())
    );
  get diagnostics waiting = row_count;
  return touched + waiting;
end;
$$;

revoke all on function private.resolve_marked_decisions() from public, anon, authenticated;
grant execute on function private.resolve_marked_decisions()
  to service_role, quantanamo_worker, oddsborne_worker, bandit_worker;

drop trigger if exists decision_candidates_on_decision_mark on public.decision_marks;
create trigger decision_candidates_on_decision_mark
  after insert on public.decision_marks
  for each statement
  execute function private.decision_candidates_on_price();

-- ——— no source has a price: flag the decision, with the reason ———

create or replace function private.decision_mark_unpriced(p_decision_id uuid, p_steward text, p_reason text, p_detail jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_horizon timestamptz;
begin
  -- SECURITY DEFINER: current_user is the owner here, so check the login role.
  if session_user::text like '%\_worker' and session_user::text <> p_steward || '_worker' then
    raise exception 'refusal:auth: % may not flag a decision for %', session_user, p_steward using errcode = '42501';
  end if;
  select c.id, c.steward, c.venue, c.decided_at, c.counterfactual_pnl, c.meta
    into d
  from public.decision_candidates c
  where c.id = p_decision_id
  for update;
  if not found then
    raise exception 'refusal:decision_mark: decision % not found', p_decision_id using errcode = 'P0001';
  end if;
  if d.steward is distinct from p_steward then
    raise exception 'refusal:auth: decision % belongs to %', p_decision_id, d.steward using errcode = '42501';
  end if;
  if d.venue not in ('meme', 'equity') then
    raise exception 'refusal:decision_mark: no_price_reason is for meme and equity horizons' using errcode = 'P0001';
  end if;
  v_horizon := private.decision_horizon_at(d.venue, d.decided_at);
  if v_horizon is null or v_horizon > pg_catalog.now() then
    raise exception 'refusal:decision_mark: horizon % has not passed', v_horizon using errcode = 'P0001';
  end if;
  if d.counterfactual_pnl is not null
     or exists (select 1 from public.decision_marks m where m.decision_id = d.id and m.mark_kind = 'horizon') then
    raise exception 'refusal:decision_mark: decision % already has a mark', d.id using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'refusal:decision_mark: no_price_reason must say why no source had a price' using errcode = 'P0001';
  end if;
  update public.decision_candidates c set
    meta = c.meta || jsonb_build_object(
      'unscoreable', 'true',
      'unscoreable_reason', 'no_price: ' || left(btrim(p_reason), 240),
      'resolve_status', 'no_price',
      'horizon_at', v_horizon,
      'no_price_checked_at', pg_catalog.now(),
      'no_price_detail', coalesce(p_detail, '{}'::jsonb)
    ),
    updated_at = pg_catalog.now()
  where c.id = d.id;
  return jsonb_build_object('decision_id', d.id, 'resolve_status', 'no_price', 'unscoreable', true, 'horizon_at', v_horizon);
end;
$$;

revoke all on function private.decision_mark_unpriced(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.decision_mark_unpriced(uuid, text, text, jsonb)
  to quantanamo_worker, bandit_worker, service_role;

-- ——— the RPCs stewards call (steward-rpc allowlist) ———

create or replace function public.steward_pending_decision_marks(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_limit integer := least(greatest(coalesce(private.try_numeric(p->>'limit')::integer, 50), 1), 200);
begin
  if current_user like '%\_worker' and current_user::text <> v_steward || '_worker' then
    raise exception 'refusal:auth: % may not read pending marks for %', current_user, v_steward
      using errcode = '42501';
  end if;
  if v_steward not in ('bandit', 'quantanamo') then
    raise exception 'refusal:decision_mark: horizon marks are for bandit and quantanamo'
      using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'decision_id', x.id,
      'decision', x.decision,
      'instrument', x.instrument,
      'side', x.side,
      'book_price', x.book_price,
      'decided_at', x.decided_at,
      'horizon_at', x.horizon_at,
      'resolve_status', x.meta->>'resolve_status'
    ) order by x.horizon_at)
    from (
      select y.*
      from (
        select c.*, private.decision_horizon_at(c.venue, c.decided_at) as horizon_at
        from public.decision_candidates c
        where c.steward = v_steward
          and c.venue in ('meme', 'equity')
          and c.counterfactual_pnl is null
          and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
          and not exists (
            select 1 from public.decision_marks m where m.decision_id = c.id and m.mark_kind = 'horizon'
          )
      ) y
      where y.horizon_at is not null
        and y.horizon_at <= now()
      order by y.horizon_at
      limit v_limit
    ) x
  ), '[]'::jsonb);
end;
$$;

comment on function public.steward_pending_decision_marks(jsonb) is
  'BANDIT / QUANTANAMO: scoreable decisions whose horizon has passed and that have no price yet (no horizon mark, counterfactual_pnl null). Read-only. Args: steward, limit (default 50).';

revoke all on function public.steward_pending_decision_marks(jsonb) from public, anon, authenticated;
grant execute on function public.steward_pending_decision_marks(jsonb) to quantanamo_worker, bandit_worker, service_role;

create or replace function public.steward_record_decision_mark(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_kind text := lower(btrim(coalesce(p->>'kind', p->>'mark_kind', '')));
  v_price numeric := private.try_numeric(p->>'price');
  v_source text := nullif(btrim(coalesce(p->>'source', '')), '');
  v_reason text := nullif(btrim(coalesce(p->>'no_price_reason', '')), '');
  v_decision uuid;
  v_observed timestamptz;
  v_start timestamptz;
  v_owner text;
  v_id uuid;
  v_replayed boolean := false;
  v_mark public.decision_marks;
  v_row public.decision_candidates;
  v_extra jsonb := case when jsonb_typeof(p->'meta') = 'object' then p->'meta' else '{}'::jsonb end;
begin
  if current_user like '%\_worker' and current_user::text <> v_steward || '_worker' then
    raise exception 'refusal:auth: % may not record a mark for %', current_user, v_steward
      using errcode = '42501';
  end if;
  if v_kind = '' then
    v_kind := case when v_steward = 'oddsborne' then 'close' else 'horizon' end;
  end if;
  if not ((v_kind = 'horizon' and v_steward in ('bandit', 'quantanamo'))
          or (v_kind = 'close' and v_steward = 'oddsborne')) then
    raise exception 'refusal:decision_mark: % marks are not for %', v_kind, coalesce(nullif(v_steward, ''), '(no steward)')
      using errcode = 'P0001';
  end if;
  begin
    v_decision := (p->>'decision_id')::uuid;
  exception when others then
    raise exception 'refusal:decision_mark: decision_id is not a uuid' using errcode = 'P0001';
  end;
  if v_decision is null then
    raise exception 'refusal:decision_mark: decision_id is required' using errcode = 'P0001';
  end if;
  select c.steward into v_owner from public.decision_candidates c where c.id = v_decision;
  if v_owner is null then
    raise exception 'refusal:decision_mark: decision % not found', v_decision using errcode = 'P0001';
  end if;
  if v_owner <> v_steward then
    raise exception 'refusal:auth: decision % belongs to %', v_decision, v_owner using errcode = '42501';
  end if;

  -- No source had any price: flag it, with the reason. Never a made-up price.
  if v_reason is not null then
    if v_kind <> 'horizon' or v_price is not null then
      raise exception 'refusal:decision_mark: no_price_reason is for a horizon mark with no price'
        using errcode = 'P0001';
    end if;
    return private.decision_mark_unpriced(v_decision, v_steward, v_reason, v_extra)
      || jsonb_build_object('ok', true, 'kind', v_kind);
  end if;

  if v_price is null or v_price <= 0 or (v_kind = 'close' and v_price >= 1) then
    raise exception 'refusal:decision_mark: price must be a real observed price (close: a side mid between 0 and 1)'
      using errcode = 'P0001';
  end if;
  if v_source is null then
    raise exception 'refusal:decision_mark: name the price source' using errcode = 'P0001';
  end if;
  begin
    v_observed := nullif(btrim(coalesce(p->>'observed_at', '')), '')::timestamptz;
    v_start := nullif(btrim(coalesce(p->>'event_start_at', '')), '')::timestamptz;
  exception when others then
    raise exception 'refusal:decision_mark: observed_at / event_start_at must be timestamps' using errcode = 'P0001';
  end;
  if v_observed is null then
    raise exception 'refusal:decision_mark: observed_at is required (when the source showed this price)'
      using errcode = 'P0001';
  end if;

  if v_kind = 'horizon' then
    insert into public.decision_marks (decision_id, steward, mark_kind, price, unit, observed_at, source, meta)
    values (v_decision, v_steward, 'horizon', v_price, '', v_observed, v_source, v_extra)
    on conflict (decision_id, mark_kind) do nothing
    returning id into v_id;
    if v_id is null then
      v_replayed := true;
    end if;
  else
    insert into public.decision_marks (decision_id, steward, mark_kind, price, unit, observed_at, event_start_at, source, meta)
    values (v_decision, v_steward, 'close', v_price, '', v_observed, v_start, v_source, v_extra)
    on conflict (decision_id, mark_kind) do update set
      price = excluded.price,
      observed_at = excluded.observed_at,
      event_start_at = excluded.event_start_at,
      source = excluded.source,
      meta = excluded.meta,
      recorded_by = excluded.recorded_by
    where excluded.observed_at > public.decision_marks.observed_at
    returning id into v_id;
    if v_id is null then
      v_replayed := true;
    end if;
  end if;

  select * into v_mark from public.decision_marks m where m.decision_id = v_decision and m.mark_kind = v_kind;
  select * into v_row from public.decision_candidates c where c.id = v_decision;
  return jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'kind', v_kind,
    'mark_id', v_mark.id,
    'replayed', v_replayed,
    'decision_id', v_decision,
    'price', v_mark.price,
    'unit', v_mark.unit,
    'observed_at', v_mark.observed_at,
    'horizon_at', v_mark.horizon_at,
    'event_start_at', v_mark.event_start_at,
    'source', v_mark.source,
    'counterfactual_pnl', v_row.counterfactual_pnl,
    'resolve_status', v_row.meta->>'resolve_status',
    'mark_source', v_row.meta->>'mark_source'
  ));
end;
$$;

comment on function public.steward_record_decision_mark(jsonb) is
  'Record one real, sourced mark for a logged decision. horizon (bandit, quantanamo): decision_id, price, observed_at (at or after the horizon the database computes), source, meta; insert-once, then the resolver scores the pass. close (oddsborne): decision_id, price = mid of the logged side, observed_at (after the decision, before event_start_at and market close), event_start_at, source; a later observation replaces an earlier one. no_price_reason instead of price flags a past-horizon decision unscoreable with that reason. Nothing is interpolated.';

revoke all on function public.steward_record_decision_mark(jsonb) from public, anon, authenticated;
grant execute on function public.steward_record_decision_mark(jsonb) to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— closing-line value (ODDSBORNE), separate from settlement hit rate ———
-- Prices are in the terms of the side the decision names: steward_log_decision rows carry the
-- logged side's price and probability, and a yes-side row is the same in either convention.
-- Rows that are no-side and came from a pm_notes split (yes-terms) are left out rather than guessed.

create or replace view public.v_decision_clv
with (security_invoker = true)
as
select c.id as decision_id,
  c.steward,
  c.decision,
  c.instrument,
  c.side,
  c.decided_at,
  c.book_price as entry_price,
  c.my_probability,
  m.price as close_mid,
  m.observed_at as close_observed_at,
  m.event_start_at,
  m.source as close_source,
  m.price - c.book_price as clv,
  c.my_probability - m.price as fair_minus_close,
  abs(c.my_probability - m.price) < abs(c.book_price - m.price) as fair_closer_than_entry,
  c.resolved_outcome,
  c.counterfactual_pnl
from public.decision_candidates c
join public.decision_marks m on m.decision_id = c.id and m.mark_kind = 'close'
where c.venue = 'prediction'
  and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
  and (c.side = 'yes' or coalesce(c.meta->>'origin', '') = 'steward_log_decision');

comment on view public.v_decision_clv is
  'Closing-line value per ODDSBORNE decision with a close mark. clv = close_mid - entry_price, both in the logged side''s terms: positive means the line moved toward the steward''s side after the decision (good for an enter; for a skip, value passed up). fair_minus_close = my_probability - close_mid. fair_closer_than_entry = the steward''s probability was nearer the close than the entry price was. Separate from settlement (resolved_outcome, counterfactual_pnl, brier).';

create or replace view public.v_decision_clv_summary
with (security_invoker = true)
as
select v.steward,
  v.decision,
  count(*)::int as n,
  avg(v.clv) as mean_clv,
  count(*) filter (where v.clv > 0)::int as beat_entry,
  count(*) filter (where v.clv < 0)::int as worse_than_entry,
  avg(v.fair_minus_close) as mean_fair_minus_close,
  count(*) filter (where v.fair_closer_than_entry)::int as fair_closer_than_entry,
  max(v.close_observed_at) as last_close_observed_at
from public.v_decision_clv v
group by v.steward, v.decision;

comment on view public.v_decision_clv_summary is
  'CLV by steward and decision kind (enter / skip). Not a hit rate: settlement lives in v_steward_scorecard.';

grant select on public.v_decision_clv, public.v_decision_clv_summary
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

select private.resolve_marked_decisions();
