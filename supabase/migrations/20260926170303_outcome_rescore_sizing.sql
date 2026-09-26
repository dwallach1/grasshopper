-- PR 2: outcome-driven thesis re-scoring + sizing guidance.
-- Sizing decision (David, 2026-09-26): size follows results, hard cap 20% of the
-- steward's book per single position. The cap applies to NEW entries and ADDS only.
-- Sells, trims, closes, kills and time-stop exits are never capped. Existing
-- oversize positions are grandfathered: no forced trims, just no adds.
--
-- Pieces:
--   * theses.stated_confidence = the steward's own last statement. theses.confidence
--     = stated tempered by realized outcomes (Beta prior, k = 10).
--   * private.rescore_thesis_confidence(thesis_id) + rescore_all_thesis_confidence().
--     Fired by trade_outcomes writes; every change is logged to belief_updates
--     with meta.kind = 'outcome_rescore'.
--   * belief_updates -> theses sync, and a BEFORE trigger on theses so a direct
--     steward write is re-tempered instead of silently overriding results.
--   * private.thesis_size_multiplier(thesis_id): half-Kelly, 0.25..1.0, thin (n<5) = 0.5.
--   * public.steward_sizing_guidance(...) / public.thesis_sizing(): what stewards call.
--   * private.reprice_trade_outcomes(steward): re-price existing outcomes from fills.
-- Trigger bodies swallow their own errors so a scoring bug never blocks a steward write.

create schema if not exists private;

-- ——— theses: stated vs outcome-tempered confidence ———

alter table public.theses add column if not exists stated_confidence smallint;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.theses'::regclass and conname = 'theses_stated_confidence_check'
  ) then
    alter table public.theses add constraint theses_stated_confidence_check
      check (stated_confidence is null or stated_confidence between 0 and 100);
  end if;
end $$;
comment on column public.theses.stated_confidence is
  'Steward''s own last stated confidence (0-100). theses.confidence = this tempered by realized trade_outcomes (Beta prior k=10).';

-- ——— belief_updates: one 0-1 scale row, then CHECK 0-100 ———

update public.belief_updates
set prior_confidence = case when prior_confidence is not null then prior_confidence * 100 end,
    new_confidence = case when new_confidence is not null then new_confidence * 100 end,
    meta = meta || jsonb_build_object('scale_normalized', jsonb_build_object('from', '0-1', 'at', '2026-09-26'))
where coalesce(new_confidence, 0) <= 1
  and coalesce(prior_confidence, 0) <= 1
  and (new_confidence > 0 or prior_confidence > 0)
  and not (meta ? 'scale_normalized');

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.belief_updates'::regclass and conname = 'belief_updates_confidence_range'
  ) then
    alter table public.belief_updates add constraint belief_updates_confidence_range
      check ((prior_confidence is null or prior_confidence between 0 and 100)
         and (new_confidence is null or new_confidence between 0 and 100));
  end if;
end $$;

-- ——— outcome stats + math ———

create or replace function private.thesis_outcome_stats(p_thesis_id text)
returns table (n integer, wins integer, losses integer, pnl_sum numeric, avg_win numeric, avg_loss numeric)
language sql
stable
set search_path = ''
as $$
  select
    count(*)::int,
    count(*) filter (where o.realized_pnl > 0)::int,
    count(*) filter (where o.realized_pnl < 0)::int,
    coalesce(sum(o.realized_pnl), 0),
    avg(o.realized_pnl) filter (where o.realized_pnl > 0),
    avg(-o.realized_pnl) filter (where o.realized_pnl < 0)
  from public.trade_outcomes o
  where o.thesis_id = p_thesis_id
    and o.realized_pnl is not null
    and not o.is_paper;
$$;

create or replace function private.steward_outcome_stats(p_steward text)
returns table (n integer, wins integer, losses integer, pnl_sum numeric, avg_win numeric, avg_loss numeric)
language sql
stable
set search_path = ''
as $$
  select
    count(*)::int,
    count(*) filter (where o.realized_pnl > 0)::int,
    count(*) filter (where o.realized_pnl < 0)::int,
    coalesce(sum(o.realized_pnl), 0),
    avg(o.realized_pnl) filter (where o.realized_pnl > 0),
    avg(-o.realized_pnl) filter (where o.realized_pnl < 0)
  from public.trade_outcomes o
  where o.steward = p_steward
    and o.realized_pnl is not null
    and not o.is_paper;
$$;

-- Beta(k*c, k*(1-c)) prior from the stated confidence, updated with wins/trades.
-- n >= 5 with negative summed realized P/L: cap at 60 and demote hardening -> forming.
create or replace function private.outcome_posterior_confidence(
  p_base numeric, p_n integer, p_wins integer, p_pnl numeric, p_k numeric default 10
)
returns table (confidence smallint, capped boolean, demote boolean)
language sql
immutable
set search_path = ''
as $$
  with post as (
    select round(100 * (p_k * least(greatest(coalesce(p_base, 0), 0), 100) / 100 + coalesce(p_wins, 0))
                 / (p_k + coalesce(p_n, 0))) as c
  )
  select
    (case when coalesce(p_n, 0) >= 5 and coalesce(p_pnl, 0) < 0 then least(post.c, 60) else post.c end)::smallint,
    coalesce(p_n, 0) >= 5 and coalesce(p_pnl, 0) < 0 and post.c > 60,
    coalesce(p_n, 0) >= 5 and coalesce(p_pnl, 0) < 0
  from post;
$$;

-- Half-Kelly on outcome hit rate and avg win / avg loss, expressed against the
-- 20% single-position cap: multiplier = clamp((f*/2) / 0.20, 0.25, 1.0).
-- Thin samples (n < 5) get 0.5, never 1.0. No edge (f* <= 0) floors at 0.25.
create or replace function private.half_kelly_multiplier(
  p_n integer, p_wins integer, p_avg_win numeric, p_avg_loss numeric, p_cap_pct numeric default 20
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(case
    when coalesce(p_n, 0) < 5 then 0.5
    when coalesce(p_wins, 0) = 0 or coalesce(p_avg_win, 0) <= 0 then 0.25
    when coalesce(p_avg_loss, 0) <= 0 then 1.0
    else least(1.0, greatest(0.25,
      ((p_wins::numeric / p_n) - (1 - p_wins::numeric / p_n) / (p_avg_win / p_avg_loss)) / 2 / (p_cap_pct / 100)
    ))
  end, 4);
$$;

create or replace function private.half_kelly_fraction(p_n integer, p_wins integer, p_avg_win numeric, p_avg_loss numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_n, 0) = 0 or coalesce(p_wins, 0) = 0 or coalesce(p_avg_win, 0) <= 0 then null
    when coalesce(p_avg_loss, 0) <= 0 then 0.5
    else round(((p_wins::numeric / p_n) - (1 - p_wins::numeric / p_n) / (p_avg_win / p_avg_loss)) / 2, 4)
  end;
$$;

create or replace function private.thesis_size_multiplier(p_thesis_id text)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
    when p_thesis_id is null then 0.5
    else (select private.half_kelly_multiplier(s.n, s.wins, s.avg_win, s.avg_loss)
          from private.thesis_outcome_stats(p_thesis_id) s)
  end;
$$;

-- ——— re-score ———

create or replace function private.rescore_thesis_confidence(p_thesis_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  th public.theses%rowtype;
  st record;
  post record;
  v_base numeric;
  v_status text;
begin
  if p_thesis_id is null then
    return null;
  end if;
  select * into th from public.theses where id = p_thesis_id for update;
  if not found then
    return null;
  end if;
  select * into st from private.thesis_outcome_stats(p_thesis_id);
  v_base := coalesce(th.stated_confidence, th.confidence);
  if coalesce(st.n, 0) = 0 then
    return jsonb_build_object('thesis_id', p_thesis_id, 'changed', false, 'reason', 'no_priced_outcomes',
      'confidence', th.confidence);
  end if;
  select * into post from private.outcome_posterior_confidence(v_base, st.n, st.wins, st.pnl_sum);
  v_status := case when post.demote and th.status = 'hardening' then 'forming' else th.status end;

  if post.confidence is not distinct from th.confidence
     and v_status is not distinct from th.status
     and th.stated_confidence is not distinct from v_base::smallint then
    return jsonb_build_object('thesis_id', p_thesis_id, 'changed', false, 'confidence', th.confidence,
      'stated_confidence', v_base, 'trades', st.n, 'wins', st.wins);
  end if;

  perform set_config('grasshopper.outcome_rescore', 'on', true);
  update public.theses
  set confidence = post.confidence,
      stated_confidence = v_base::smallint,
      status = v_status,
      updated_at = now()
  where id = p_thesis_id;
  perform set_config('grasshopper.outcome_rescore', 'off', true);

  if post.confidence is distinct from th.confidence or v_status is distinct from th.status then
    insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, meta)
    values (
      p_thesis_id, th.confidence, post.confidence,
      format('Outcome re-score: %s priced trades, %s wins, realized %s. Stated %s tempered to %s (Beta prior k=10)%s%s.',
        st.n, st.wins, round(st.pnl_sum, 4), v_base, post.confidence,
        case when post.capped then '; capped at 60 (n>=5, negative P/L)' else '' end,
        case when v_status is distinct from th.status then '; demoted ' || th.status || ' -> ' || v_status else '' end),
      jsonb_build_object(
        'kind', 'outcome_rescore',
        'prior_confidence', th.confidence,
        'new_confidence', post.confidence,
        'stated_confidence', v_base,
        'k', 10,
        'trades', st.n,
        'wins', st.wins,
        'realized_pnl', st.pnl_sum,
        'capped_at_60', post.capped,
        'demoted', v_status is distinct from th.status,
        'prior_status', th.status,
        'new_status', v_status
      )
    );
  end if;

  return jsonb_build_object('thesis_id', p_thesis_id, 'changed', true,
    'prior_confidence', th.confidence, 'new_confidence', post.confidence, 'stated_confidence', v_base,
    'trades', st.n, 'wins', st.wins, 'realized_pnl', st.pnl_sum,
    'prior_status', th.status, 'new_status', v_status, 'capped_at_60', post.capped);
end;
$$;

-- Nightly-callable wrapper (no pg_cron here; triggers keep it current, this is the manual sweep).
create or replace function private.rescore_all_thesis_confidence()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
begin
  for r in
    select distinct o.thesis_id
    from public.trade_outcomes o
    join public.theses t on t.id = o.thesis_id
    where o.realized_pnl is not null
    order by o.thesis_id
  loop
    v_out := v_out || jsonb_build_array(private.rescore_thesis_confidence(r.thesis_id));
  end loop;
  return v_out;
end;
$$;

-- A steward write to theses.confidence/stated_confidence is treated as a new statement
-- and re-tempered by outcomes. Explicit stated_confidence = absolute; a change to
-- confidence alone = delta on the stated scale (so read-modify-write never compounds).
create or replace function private.theses_outcome_temper()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  st record;
  post record;
  v_base numeric;
  v_written smallint;
begin
  if coalesce(current_setting('grasshopper.outcome_rescore', true), 'off') = 'on' then
    return new;
  end if;
  v_written := new.confidence;
  begin
    if new.stated_confidence is distinct from old.stated_confidence and new.stated_confidence is not null then
      v_base := new.stated_confidence;
    elsif new.confidence is distinct from old.confidence then
      v_base := case
        when old.stated_confidence is null then new.confidence
        else least(100, greatest(0, old.stated_confidence + (new.confidence - old.confidence)))
      end;
    else
      return new;
    end if;

    select * into st from private.thesis_outcome_stats(new.id);
    new.stated_confidence := v_base::smallint;
    if coalesce(st.n, 0) = 0 then
      new.confidence := v_base::smallint;
      return new;
    end if;
    select * into post from private.outcome_posterior_confidence(v_base, st.n, st.wins, st.pnl_sum);
    new.confidence := post.confidence;
    if post.demote and new.status = 'hardening' then
      new.status := 'forming';
    end if;
    if new.confidence is distinct from old.confidence or new.status is distinct from old.status then
      insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, meta)
      values (
        new.id, old.confidence, new.confidence,
        format('Outcome re-score on steward write: stated %s tempered to %s by %s priced trades (%s wins).',
          v_base, new.confidence, st.n, st.wins),
        jsonb_build_object(
          'kind', 'outcome_rescore', 'trigger', 'theses_write',
          'prior_confidence', old.confidence, 'new_confidence', new.confidence,
          'written_confidence', v_written, 'stated_confidence', v_base, 'k', 10,
          'trades', st.n, 'wins', st.wins, 'realized_pnl', st.pnl_sum,
          'capped_at_60', post.capped, 'demoted', new.status is distinct from old.status,
          'prior_status', old.status, 'new_status', new.status
        )
      );
    end if;
  exception when others then
    raise warning 'theses_outcome_temper(%): %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists theses_outcome_temper on public.theses;
create trigger theses_outcome_temper
  before update of confidence, stated_confidence on public.theses
  for each row execute function private.theses_outcome_temper();

-- Latest numeric belief update (not an outcome re-score) becomes the stated confidence.
create or replace function private.belief_update_sync_thesis()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if coalesce(new.meta->>'kind', '') = 'outcome_rescore' then
      return null;
    end if;
    if new.new_confidence > 0 and new.new_confidence < 1 then
      raise warning 'belief_update_sync_thesis(%): ambiguous 0-1 confidence %, not synced', new.id, new.new_confidence;
      return null;
    end if;
    if exists (
      select 1 from public.belief_updates b
      where b.thesis_id = new.thesis_id and b.id <> new.id
        and b.new_confidence is not null
        and coalesce(b.meta->>'kind', '') <> 'outcome_rescore'
        and b.observed_at > new.observed_at
    ) then
      return null;
    end if;
    update public.theses
    set stated_confidence = round(new.new_confidence)::smallint,
        updated_at = now()
    where id = new.thesis_id
      and stated_confidence is distinct from round(new.new_confidence)::smallint;
  exception when others then
    raise warning 'belief_update_sync_thesis(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists belief_update_sync_thesis on public.belief_updates;
create trigger belief_update_sync_thesis
  after insert on public.belief_updates
  for each row when (new.new_confidence is not null)
  execute function private.belief_update_sync_thesis();

-- Every priced outcome write re-scores its thesis.
create or replace function private.trade_outcome_rescore()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if new.thesis_id is not null then
      perform private.rescore_thesis_confidence(new.thesis_id);
    end if;
    if tg_op = 'UPDATE' and old.thesis_id is not null and old.thesis_id is distinct from new.thesis_id then
      perform private.rescore_thesis_confidence(old.thesis_id);
    end if;
  exception when others then
    raise warning 'trade_outcome_rescore(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists trade_outcome_rescore_ins on public.trade_outcomes;
create trigger trade_outcome_rescore_ins
  after insert on public.trade_outcomes
  for each row execute function private.trade_outcome_rescore();
drop trigger if exists trade_outcome_rescore_upd on public.trade_outcomes;
create trigger trade_outcome_rescore_upd
  after update of realized_pnl, thesis_id, is_paper on public.trade_outcomes
  for each row
  when (old.realized_pnl is distinct from new.realized_pnl
     or old.thesis_id is distinct from new.thesis_id
     or old.is_paper is distinct from new.is_paper)
  execute function private.trade_outcome_rescore();

-- ——— re-pricing from fills (re-runnable once steward fill backfills land) ———

-- Equity round trip from broker_fills. Episode-linked intents first; otherwise the
-- same symbol on the canonical account inside [opened - 6h, closed + 6h]. Only a
-- balanced round trip (buy qty = sell qty) counts; anything else returns priced=false.
create or replace function private.equity_round_trip_fills(
  p_account_key text, p_symbol text, p_opened timestamptz, p_closed timestamptz, p_episode_id uuid
)
returns table (
  priced boolean, match text, fills integer, cost numeric, proceeds numeric, fees numeric,
  first_buy_at timestamptz, last_sell_at timestamptz, placeholder_policy_intents integer
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_match text;
begin
  for v_match in select unnest(array['episode', 'symbol_window']) loop
    if v_match = 'episode' and p_episode_id is null then
      continue;
    end if;
    return query
    with f as (
      select i.side, fl.quantity, fl.price, fl.executed_at, i.gate_results, i.policy_sha256,
        coalesce(private.try_numeric(fl.payload->>'fees'), private.try_numeric(fl.payload->'raw'->>'fees'), 0) as fee
      from public.broker_fills fl
      join public.trade_intents i on i.id = fl.trade_intent_id
      where case
        when v_match = 'episode' then i.position_episode_id = p_episode_id
        else upper(i.symbol) = upper(p_symbol)
          and private.canonical_account_key('equity', i.account_key) = private.canonical_account_key('equity', p_account_key)
          and fl.executed_at between coalesce(p_opened, p_closed) - interval '6 hours' and p_closed + interval '6 hours'
      end
    ),
    agg as (
      select
        coalesce(sum(f.quantity) filter (where f.side = 'buy'), 0) as bq,
        coalesce(sum(f.quantity) filter (where f.side = 'sell'), 0) as sq,
        coalesce(sum(f.quantity * f.price) filter (where f.side = 'buy'), 0) as bc,
        coalesce(sum(f.quantity * f.price) filter (where f.side = 'sell'), 0) as sp,
        coalesce(sum(f.fee), 0) as fe,
        count(*)::int as n,
        min(f.executed_at) filter (where f.side = 'buy') as fb,
        max(f.executed_at) filter (where f.side = 'sell') as ls,
        count(*) filter (where f.gate_results ? 'backfilled' or f.gate_results ? 'backfill'
          or coalesce(f.gate_results->>'policy', '') ilike '%placeholder%')::int as ph
      from f
    )
    select true, v_match, a.n, a.bc, a.sp, a.fe, a.fb, a.ls, a.ph
    from agg a
    where a.bq > 0 and abs(a.bq - a.sq) <= greatest(a.bq, 1) * 0.000001;
    if found then
      return;
    end if;
  end loop;
  return query select false, null::text, 0, null::numeric, null::numeric, null::numeric,
    null::timestamptz, null::timestamptz, 0;
end;
$$;

-- Re-price one outcome row. Trigger-origin rows re-run their writer. Backfill rows
-- are upgraded only when real fills now cover the round trip (pnl_source = 'fills');
-- the previous numbers are kept in meta.repriced_from. Never invents a number.
create or replace function private.reprice_trade_outcome(p_outcome_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.trade_outcomes%rowtype;
  ep public.position_episodes%rowtype;
  rt record;
  v_episode uuid;
  pm record;
  meme record;
  v_before numeric;
begin
  select * into o from public.trade_outcomes where id = p_outcome_id;
  if not found then
    return 'missing';
  end if;
  v_before := o.realized_pnl;

  if o.source_table = 'meme_positions' then
    if coalesce(o.meta->>'origin', '') = 'trigger' then
      perform private.trade_outcome_from_meme(o.source_id::uuid);
      -- The writer rebuilds meta; keep the backfill tag and record what changed.
      update public.trade_outcomes t
      set meta = t.meta
        || jsonb_strip_nulls(jsonb_build_object('backfilled', o.meta->>'backfilled'))
        || case
             when t.realized_pnl is distinct from o.realized_pnl or t.fees is distinct from o.fees
               then jsonb_build_object('repriced_at', now(), 'repriced_from',
                 jsonb_build_object('realized_pnl', o.realized_pnl, 'fees', o.fees, 'pnl_source', o.pnl_source))
             else coalesce(jsonb_strip_nulls(jsonb_build_object(
               'repriced_at', o.meta->'repriced_at', 'repriced_from', o.meta->'repriced_from')), '{}'::jsonb)
           end
      where t.id = o.id;
      return 'meme_writer';
    end if;
    return 'skipped';
  end if;

  if o.source_table = 'pm_positions' then
    if coalesce(o.meta->>'origin', '') = 'trigger' then
      perform private.trade_outcome_from_pm(o.source_id::uuid);
      return 'pm_writer';
    end if;
    -- Backfill row: upgrade only if pm_fills now cover buys and sells (or buys + settlement).
    select
      coalesce(sum(f.quantity) filter (where f.side = 'buy'), 0) as bq,
      coalesce(sum(f.quantity) filter (where f.side = 'sell'), 0) as sq,
      coalesce(sum(f.quantity * f.price) filter (where f.side = 'buy'), 0) as bc,
      coalesce(sum(f.quantity * f.price) filter (where f.side = 'sell'), 0) as sp,
      coalesce(sum(f.fee), 0) as fe,
      count(*)::int as n
    into pm
    from public.pm_fills f
    where f.position_id = o.source_id::uuid;
    if pm.n = 0 or pm.bq <= 0 then
      return 'no_fills';
    end if;
    if abs(pm.bq - pm.sq) <= greatest(pm.bq, 1) * 0.000001 then
      update public.trade_outcomes
      set cost = pm.bc, proceeds = pm.sp, fees = case when pm.fe > 0 then pm.fe end,
          realized_pnl = pm.sp - pm.bc - pm.fe, pnl_source = 'fills',
          meta = meta - 'basis' || jsonb_build_object(
            'repriced_at', now(), 'fills', pm.n, 'fill_match', 'position',
            'repriced_from', jsonb_build_object('cost', o.cost, 'proceeds', o.proceeds, 'fees', o.fees,
              'realized_pnl', o.realized_pnl, 'pnl_source', o.pnl_source)),
          updated_at = now()
      where id = o.id;
      return 'pm_fills';
    end if;
    return 'fills_incomplete';
  end if;

  if o.steward = 'quantanamo' and o.source_table in ('position_episodes', 'manual_backfill') then
    if o.source_table = 'position_episodes' then
      v_episode := o.source_id::uuid;
      select * into ep from public.position_episodes where id = v_episode;
    end if;
    select * into rt
    from private.equity_round_trip_fills(o.account_key, o.instrument, o.opened_at, o.closed_at, v_episode);
    if not rt.priced then
      if o.source_table = 'position_episodes' and coalesce(o.meta->>'origin', '') = 'trigger' then
        perform private.trade_outcome_from_episode(v_episode);
        return 'episode_writer';
      end if;
      return 'fills_incomplete';
    end if;
    update public.trade_outcomes
    set account_key = private.canonical_account_key('equity', account_key),
        opened_at = coalesce(rt.first_buy_at, opened_at),
        closed_at = coalesce(rt.last_sell_at, closed_at),
        cost = round(rt.cost, 4),
        proceeds = round(rt.proceeds, 4),
        fees = rt.fees,
        realized_pnl = round(rt.proceeds - rt.cost - rt.fees, 4),
        pnl_source = 'fills',
        meta = (meta - 'basis' - 'needs_pricing') || jsonb_strip_nulls(jsonb_build_object(
          'repriced_at', now(),
          'fills', rt.fills,
          'fill_match', rt.match,
          'placeholder_policy_intents', nullif(rt.placeholder_policy_intents, 0),
          'repriced_from', jsonb_build_object('cost', o.cost, 'proceeds', o.proceeds, 'fees', o.fees,
            'realized_pnl', o.realized_pnl, 'pnl_source', o.pnl_source,
            'opened_at', o.opened_at, 'closed_at', o.closed_at))),
        updated_at = now()
    where id = o.id
      and (realized_pnl is distinct from round(rt.proceeds - rt.cost - rt.fees, 4)
        or pnl_source is distinct from 'fills'
        or fees is distinct from rt.fees
        or closed_at is distinct from coalesce(rt.last_sell_at, closed_at));
    return 'equity_fills:' || rt.match;
  end if;

  return 'skipped';
end;
$$;

create or replace function private.reprice_trade_outcomes(p_steward text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_result text;
  v_out jsonb := '{}'::jsonb;
begin
  for r in
    select id from public.trade_outcomes
    where p_steward is null or steward = p_steward
    order by closed_at
  loop
    v_result := private.reprice_trade_outcome(r.id);
    v_out := jsonb_set(v_out, array[v_result], to_jsonb(coalesce((v_out->>v_result)::int, 0) + 1));
  end loop;
  return v_out;
end;
$$;

-- Equity episodes: late broker fills re-price. Fee edits on meme/pm fills re-price too.
create or replace function private.trade_outcome_fill_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  begin
    if tg_table_name = 'broker_fills' then
      for r in
        select o.id
        from public.trade_intents i
        join public.trade_outcomes o
          on o.steward = 'quantanamo'
         and upper(o.instrument) = upper(i.symbol)
         and new.executed_at between coalesce(o.opened_at, o.closed_at) - interval '6 hours' and o.closed_at + interval '6 hours'
        where i.id = new.trade_intent_id
      loop
        perform private.reprice_trade_outcome(r.id);
      end loop;
    elsif tg_table_name = 'meme_fills' and new.position_id is not null then
      perform private.trade_outcome_from_meme(new.position_id);
    elsif tg_table_name = 'pm_fills' and new.position_id is not null then
      perform private.trade_outcome_from_pm(new.position_id);
    end if;
  exception when others then
    raise warning 'trade_outcome_fill_changed(%): %', tg_table_name, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists trade_outcome_on_fill on public.broker_fills;
create trigger trade_outcome_on_fill
  after insert on public.broker_fills
  for each row execute function private.trade_outcome_fill_changed();
drop trigger if exists trade_outcome_on_fill_update on public.meme_fills;
create trigger trade_outcome_on_fill_update
  after update of fee_sol, price_sol, quantity, position_id on public.meme_fills
  for each row execute function private.trade_outcome_fill_changed();
drop trigger if exists trade_outcome_on_fill_update on public.pm_fills;
create trigger trade_outcome_on_fill_update
  after update of fee, price, quantity, position_id on public.pm_fills
  for each row execute function private.trade_outcome_fill_changed();

-- ——— book equity + sizing guidance ———

create or replace function private.steward_book_equity(p_steward text)
returns table (equity numeric, unit text, observed_at timestamptz, source text)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_steward = 'quantanamo' then
    return query
    select s.total_value, 'USD'::text, s.observed_at, 'account_snapshots.total_value'::text
    from public.account_snapshots s
    where s.account_label ~* '7638' and s.total_value > 0
    order by s.observed_at desc limit 1;
  elsif p_steward = 'oddsborne' then
    return query
    select p.equity, 'USD'::text, p.as_of, 'pm_pnl.equity'::text
    from public.pm_pnl p
    where p.equity > 0
    order by p.as_of desc limit 1;
  elsif p_steward = 'bandit' then
    return query
    select p.equity_sol, 'SOL'::text, p.as_of, 'meme_pnl.equity_sol'::text
    from public.meme_pnl p
    where p.equity_sol > 0
    order by p.as_of desc limit 1;
  end if;
end;
$$;

create or replace function private.steward_position_value(p_steward text, p_instrument text)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v numeric;
begin
  if p_instrument is null or btrim(p_instrument) = '' then
    return null;
  end if;
  if p_steward = 'quantanamo' then
    select sum(e.quantity * coalesce(e.last_price, e.average_buy_price)) into v
    from public.portfolio_exposure e
    where e.account_last4 = '7638' and upper(e.symbol) = upper(p_instrument) and e.quantity > 0
      and e.observed_at = (select max(x.observed_at) from public.portfolio_exposure x where x.account_last4 = '7638');
  elsif p_steward = 'oddsborne' then
    select sum(p.quantity * coalesce(p.mark, p.average_cost)) into v
    from public.pm_positions p
    join public.pm_markets m on m.id = p.market_id
    where p.status = 'open' and (m.slug = p_instrument or m.id::text = p_instrument);
  elsif p_steward = 'bandit' then
    select sum(p.quantity * coalesce(p.mark_sol, p.average_cost_sol)) into v
    from public.meme_positions p
    join public.meme_tokens t on t.id = p.token_id
    where p.status = 'open' and (t.mint = p_instrument or upper(t.symbol) = upper(p_instrument));
  end if;
  return coalesce(v, 0);
end;
$$;

-- What every steward calls before sizing a NEW entry or an ADD.
--   size = requested x multiplier, then min(size, add_headroom).
--   add_headroom = 20% of book - current position value (0 = grandfathered oversize: no add).
-- Never applies to sells, trims, closes, kills or time stops.
create or replace function public.steward_sizing_guidance(
  p_steward text, p_thesis_id text default null, p_instrument text default null
)
returns table (
  steward text, thesis_id text, instrument text, unit text,
  book_equity numeric, book_equity_at timestamptz, book_source text,
  cap_pct numeric, cap_notional numeric, current_position_value numeric, add_headroom numeric,
  multiplier numeric, multiplier_basis text,
  sample_trades integer, sample_wins integer, hit_rate numeric, avg_win numeric, avg_loss numeric,
  half_kelly_fraction numeric,
  thesis_confidence smallint, stated_confidence smallint, thesis_status text,
  applies_to text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  eq record;
  st record;
  th public.theses%rowtype;
  v_basis text;
  v_mult numeric;
  v_pos numeric;
  v_cap numeric;
begin
  if p_steward not in ('quantanamo', 'oddsborne', 'bandit') then
    raise exception 'unknown steward %', p_steward;
  end if;
  select * into eq from private.steward_book_equity(p_steward);
  if p_thesis_id is not null then
    select * into th from public.theses where id = p_thesis_id;
    select * into st from private.thesis_outcome_stats(p_thesis_id);
    v_basis := case when coalesce(st.n, 0) < 5 then 'thesis_thin_default' else 'thesis_half_kelly' end;
  else
    select * into st from private.steward_outcome_stats(p_steward);
    v_basis := case when coalesce(st.n, 0) < 5 then 'steward_thin_default' else 'steward_half_kelly' end;
  end if;
  v_mult := private.half_kelly_multiplier(st.n, st.wins, st.avg_win, st.avg_loss);
  v_cap := case when eq.equity > 0 then round(eq.equity * 0.20, 6) end;
  v_pos := private.steward_position_value(p_steward, p_instrument);
  return query select
    p_steward, p_thesis_id, p_instrument, coalesce(eq.unit, case when p_steward = 'bandit' then 'SOL' else 'USD' end),
    eq.equity, eq.observed_at, eq.source,
    20::numeric, v_cap, v_pos,
    case when v_cap is null then null else greatest(v_cap - coalesce(v_pos, 0), 0) end,
    v_mult, v_basis,
    coalesce(st.n, 0), coalesce(st.wins, 0),
    case when st.n > 0 then round(st.wins::numeric / st.n, 4) end,
    st.avg_win, st.avg_loss,
    private.half_kelly_fraction(st.n, st.wins, st.avg_win, st.avg_loss),
    th.confidence, th.stated_confidence, th.status,
    'new entries and adds only; sells, trims, closes, kills and time stops are never capped; oversize positions are grandfathered (no forced trims, no adds)'::text;
end;
$$;

-- One row per thesis with priced-outcome sizing inputs (QUANTANAMO research worker reads this).
create or replace function public.thesis_sizing()
returns table (
  thesis_id text, confidence smallint, stated_confidence smallint, status text,
  multiplier numeric, multiplier_basis text, sample_trades integer, sample_wins integer,
  realized_pnl numeric, half_kelly_fraction numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.confidence, t.stated_confidence, t.status,
    private.half_kelly_multiplier(s.n, s.wins, s.avg_win, s.avg_loss),
    case when s.n < 5 then 'thin_default' else 'half_kelly' end,
    s.n, s.wins, s.pnl_sum,
    private.half_kelly_fraction(s.n, s.wins, s.avg_win, s.avg_loss)
  from public.theses t
  cross join lateral private.thesis_outcome_stats(t.id) s
  order by t.id;
$$;

-- Buys that exceeded 20% of book at the time (audit only; nothing is blocked here).
-- ODDSBORNE and BANDIT record orders after the venue accepts them, so a DB reject
-- would drop the ledger row of a real trade without preventing it.
create or replace view public.v_sizing_cap_breaches
with (security_invoker = true)
as
select 'oddsborne'::text as steward, o.id as order_id, o.created_at, o.account_key,
  m.slug as instrument, o.size * o.price as notional, 'USD'::text as unit,
  b.equity as book_equity, round(100 * o.size * o.price / nullif(b.equity, 0), 2) as pct_of_book
from public.pm_orders o
left join public.pm_markets m on m.id = o.market_id
cross join lateral (
  select p.equity from public.pm_pnl p where p.as_of <= o.created_at and p.equity > 0 order by p.as_of desc limit 1
) b
where o.side = 'buy' and o.mode = 'live' and o.status not in ('cancelled', 'expired')
  and o.size * o.price > 0.20 * b.equity
union all
select 'bandit', o.id, o.created_at, o.account_key,
  coalesce(t.symbol, t.mint), o.size_sol, 'SOL',
  b.equity_sol, round(100 * o.size_sol / nullif(b.equity_sol, 0), 2)
from public.meme_orders o
left join public.meme_tokens t on t.id = o.token_id
cross join lateral (
  select p.equity_sol from public.meme_pnl p where p.as_of <= o.created_at and p.equity_sol > 0 order by p.as_of desc limit 1
) b
where o.side = 'buy' and o.mode = 'live' and o.status = 'filled'
  and o.size_sol > 0.20 * b.equity_sol;

comment on view public.v_sizing_cap_breaches is
  'Audit: live buys above 20% of the steward book at order time (pre-policy rows included). Nothing is blocked.';

-- ——— grants ———

revoke all on function private.thesis_outcome_stats(text) from public, anon, authenticated;
revoke all on function private.steward_outcome_stats(text) from public, anon, authenticated;
revoke all on function private.outcome_posterior_confidence(numeric, integer, integer, numeric, numeric) from public, anon, authenticated;
revoke all on function private.half_kelly_multiplier(integer, integer, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function private.half_kelly_fraction(integer, integer, numeric, numeric) from public, anon, authenticated;
revoke all on function private.thesis_size_multiplier(text) from public, anon, authenticated;
revoke all on function private.rescore_thesis_confidence(text) from public, anon, authenticated;
revoke all on function private.rescore_all_thesis_confidence() from public, anon, authenticated;
revoke all on function private.theses_outcome_temper() from public, anon, authenticated;
revoke all on function private.belief_update_sync_thesis() from public, anon, authenticated;
revoke all on function private.trade_outcome_rescore() from public, anon, authenticated;
revoke all on function private.equity_round_trip_fills(text, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function private.reprice_trade_outcome(uuid) from public, anon, authenticated;
revoke all on function private.reprice_trade_outcomes(text) from public, anon, authenticated;
revoke all on function private.trade_outcome_fill_changed() from public, anon, authenticated;
revoke all on function private.steward_book_equity(text) from public, anon, authenticated;
revoke all on function private.steward_position_value(text, text) from public, anon, authenticated;
grant execute on function private.rescore_thesis_confidence(text) to service_role;
grant execute on function private.rescore_all_thesis_confidence() to service_role;
grant execute on function private.reprice_trade_outcomes(text) to service_role;
grant execute on function private.thesis_size_multiplier(text) to service_role;

revoke all on function public.steward_sizing_guidance(text, text, text) from public, anon, authenticated;
revoke all on function public.thesis_sizing() from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
grant execute on function public.thesis_sizing()
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

revoke all on table public.v_sizing_cap_breaches from public, anon, authenticated;
grant select on table public.v_sizing_cap_breaches
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— risk_controls tell the truth: 20% of book per single position ———

update public.risk_controls
set threshold_json = jsonb_build_object(
      'percent_of_portfolio_value', 20,
      'basis', 'steward_book',
      'applies_to', jsonb_build_array('open', 'add'),
      'never_blocks', jsonb_build_array('sell', 'trim', 'close', 'kill', 'time_stop'),
      'grandfathered', 'existing oversize positions: no forced trims, no adds',
      'enforced', jsonb_build_object(
        'quantanamo', 'code: research approvedCandidate, position-decision add, broker gateway policy',
        'oddsborne', 'guidance: public.steward_sizing_guidance (agent-side)',
        'bandit', 'guidance: public.steward_sizing_guidance (agent-side)'),
      'decided', '2026-09-26 David: size follows results, hard cap 20%'),
    updated_at = now()
where control_key = 'thesis-notional';

update public.risk_controls
set threshold_json = threshold_json || jsonb_build_object('max_single_trade_percent', 20),
    updated_at = now()
where control_key = 'autonomous-execution';

update public.risk_controls
set threshold_json = threshold_json || jsonb_build_object('max_total_position_percent', 20),
    updated_at = now()
where control_key = 'autonomous-position-management';

-- ——— scorecard: BANDIT fees line from meme_fills.fee_sol (appends two columns) ———

create or replace view public.v_steward_scorecard
with (security_invoker = true)
as
with stewards(steward, venue, unit, sort_order) as (
  values ('quantanamo', 'equity', 'USD', 1), ('oddsborne', 'prediction', 'USD', 2), ('bandit', 'meme', 'SOL', 3)
),
o as (
  select * from public.trade_outcomes where not is_paper
),
agg as (
  select o.steward,
    count(*)::int as trades,
    count(o.realized_pnl)::int as priced_trades,
    count(*) filter (where o.realized_pnl > 0)::int as wins,
    count(*) filter (where o.realized_pnl < 0)::int as losses,
    sum(o.realized_pnl) as realized_pnl,
    avg(o.realized_pnl) filter (where o.realized_pnl > 0) as avg_win,
    avg(o.realized_pnl) filter (where o.realized_pnl < 0) as avg_loss,
    avg(o.realized_pnl) as expectancy,
    sum(o.fees) as fees_recorded,
    count(*) filter (where o.fees is null)::int as fees_missing,
    count(*) filter (where o.pnl_source = 'fills' and o.realized_pnl is not null)::int as from_fills,
    count(*) filter (where o.pnl_source = 'cash_delta')::int as from_cash_delta,
    count(*) filter (where o.pnl_source = 'settlement')::int as from_settlement,
    count(*) filter (where o.pnl_source = 'manual')::int as from_manual,
    count(*) filter (where o.realized_pnl is null)::int as unpriced,
    min(o.closed_at) as first_closed_at,
    max(o.closed_at) as last_closed_at
  from o
  group by o.steward
),
qnt_marks as (
  select e.quantity, e.average_buy_price, e.last_price, e.observed_at
  from public.portfolio_exposure e
  where e.account_last4 = '7638'
    and e.observed_at = (select max(x.observed_at) from public.portfolio_exposure x where x.account_last4 = '7638')
    and e.quantity > 0
),
unreal as (
  select 'quantanamo'::text as steward,
    count(*)::int as open_positions,
    sum(q.quantity * (q.last_price - q.average_buy_price)) as unrealized_pnl,
    max(q.observed_at) as marked_at
  from qnt_marks q
  union all
  select 'oddsborne', count(*)::int, sum(p.quantity * (p.mark - p.average_cost)), max(p.mark_at)
  from public.pm_positions p where p.status = 'open'
  union all
  select 'bandit', count(*)::int, sum(p.quantity * (p.mark_sol - p.average_cost_sol)), max(p.mark_at)
  from public.meme_positions p where p.status = 'open'
),
dec as (
  select c.steward,
    count(*) filter (where c.decision = 'skip')::int as skips_logged,
    count(*) filter (where c.decision = 'skip' and c.resolved_outcome is not null)::int as skips_resolved,
    count(*) filter (where c.decision = 'skip' and c.counterfactual_pnl is not null)::int as skips_scored,
    count(*) filter (where c.decision = 'skip' and c.counterfactual_pnl > 0)::int as skips_would_have_won,
    sum(c.counterfactual_pnl) filter (where c.decision = 'skip') as skip_counterfactual_pnl,
    count(*) filter (where c.decision = 'enter')::int as enters_logged,
    avg(c.brier) as brier_mean,
    count(c.brier)::int as brier_n
  from public.decision_candidates c
  group by c.steward
),
fill_fees as (
  -- BANDIT fees line: every meme fill's fee_sol (open lots included), not meme_pnl.fees.
  select 'bandit'::text as steward,
    sum(f.fee_sol) as fees_from_fills,
    count(*) filter (where f.fee_sol is null)::int as fills_missing_fee
  from public.meme_fills f
)
select
  s.steward,
  s.venue,
  s.unit,
  s.sort_order,
  coalesce(a.trades, 0) as trades,
  coalesce(a.priced_trades, 0) as priced_trades,
  coalesce(a.wins, 0) as wins,
  coalesce(a.losses, 0) as losses,
  round(a.wins::numeric / nullif(a.priced_trades, 0), 4) as hit_rate,
  a.realized_pnl,
  a.avg_win,
  a.avg_loss,
  a.expectancy,
  coalesce(a.priced_trades, 0) < 10 as thin,
  a.fees_recorded,
  coalesce(a.fees_missing, 0) as fees_missing,
  coalesce(a.from_fills, 0) as from_fills,
  coalesce(a.from_cash_delta, 0) as from_cash_delta,
  coalesce(a.from_settlement, 0) as from_settlement,
  coalesce(a.from_manual, 0) as from_manual,
  coalesce(a.unpriced, 0) as unpriced,
  coalesce(a.trades, 0) - coalesce(a.from_fills, 0) as not_from_fills,
  a.first_closed_at,
  a.last_closed_at,
  coalesce(u.open_positions, 0) as open_positions,
  case when coalesce(u.open_positions, 0) = 0 then 0 else u.unrealized_pnl end as unrealized_pnl,
  u.marked_at as unrealized_marked_at,
  coalesce(d.skips_logged, 0) as skips_logged,
  coalesce(d.skips_resolved, 0) as skips_resolved,
  coalesce(d.skips_scored, 0) as skips_scored,
  coalesce(d.skips_would_have_won, 0) as skips_would_have_won,
  d.skip_counterfactual_pnl,
  coalesce(d.enters_logged, 0) as enters_logged,
  d.brier_mean,
  coalesce(d.brier_n, 0) as brier_n,
  ff.fees_from_fills,
  ff.fills_missing_fee
from stewards s
left join agg a on a.steward = s.steward
left join unreal u on u.steward = s.steward
left join dec d on d.steward = s.steward
left join fill_fees ff on ff.steward = s.steward;

comment on view public.v_steward_scorecard is
  'Per-steward realized scorecard from trade_outcomes (live only). thin = priced_trades < 10. not_from_fills = data-quality count. fees_from_fills = BANDIT sum(meme_fills.fee_sol).';

-- Equity episode closes: after the writer, re-price from broker fills (fees included,
-- symbol-window match when the sell intent is not episode-linked).
create or replace function private.trade_outcome_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  begin
    if tg_table_name = 'meme_positions' then
      perform private.trade_outcome_from_meme(new.id);
    elsif tg_table_name = 'pm_positions' then
      perform private.trade_outcome_from_pm(new.id);
    elsif tg_table_name = 'position_episodes' then
      perform private.trade_outcome_from_episode(new.id);
      select o.id into v_id from public.trade_outcomes o
      where o.source_table = 'position_episodes' and o.source_id = new.id::text;
      if v_id is not null then
        perform private.reprice_trade_outcome(v_id);
      end if;
    elsif tg_table_name = 'meme_fills' and new.position_id is not null then
      perform private.trade_outcome_from_meme(new.position_id);
    elsif tg_table_name = 'pm_fills' and new.position_id is not null then
      perform private.trade_outcome_from_pm(new.position_id);
    end if;
  exception when others then
    raise warning 'trade_outcome_capture(%): %', tg_table_name, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.trade_outcome_capture() from public, anon, authenticated;
