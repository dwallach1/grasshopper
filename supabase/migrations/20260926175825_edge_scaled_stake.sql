-- Edge-scaled max stake, required invalidation on entry, fresh-book check (2026-09-26,
-- David: "Fix all holes"). Replaces the unbounded `requested x multiplier` size.
--
-- max_stake (per thesis; the steward's whole book when the thesis is null), in the book's unit:
--   r_i  = realized_pnl / cost for each priced, non-paper closed trade (return on stake)
--   n, mean(r), sd(r); LCB = mean - sd / sqrt(n)            (one-sigma lower bound)
--   unproven (n < 10, or LCB <= 0): max_stake = starter
--   proven   (n >= 10 and LCB > 0): max_stake = max(starter,
--              min(book_equity x 0.5 x LCB / sd^2,             -- half-Kelly on the LCB
--                  starter x 2^(1 + (n - 10) / 5)))            -- doubles every 5 proven trades
--   after losses: x 0.5 per consecutive most-recent loss (at most 2, so >= 0.25 x)
-- Starters (about 5% of each book on 2026-09-26; see private.steward_starter_stake):
--   QUANTANAMO $250 (book ~$5,500), ODDSBORNE $15 (~$277), BANDIT 0.10 SOL (~1.79 SOL).
-- sized_notional = min(requested x multiplier, max_stake, spendable cash).
-- This is results-driven (it grows with measured edge and n and shrinks after losses),
-- not a fixed % rail. Confidence re-scoring was already sample-size aware (Beta prior k=10).
--
-- Entry also needs p_invalidation_price > 0 (reason 'missing_invalidation') and a book
-- observation no older than 6 hours (reason 'stale_book'). New open lots without an
-- invalidation_price are rejected at the table (private.require_lot_invalidation).

create or replace function private.steward_starter_stake(p_steward text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case p_steward
    when 'quantanamo' then 250::numeric   -- USD
    when 'oddsborne' then 15::numeric     -- USD
    when 'bandit' then 0.10::numeric      -- SOL
  end;
$$;

comment on function private.steward_starter_stake(text) is
  'Starter max stake for an unproven thesis, in the book unit (about 5% of each book on 2026-09-26): quantanamo $250, oddsborne $15, bandit 0.10 SOL.';

create or replace function private.stake_edge_stats(p_steward text, p_thesis_id text)
returns table (n integer, wins integer, mean_ret numeric, sd_ret numeric, loss_streak integer)
language sql
stable
set search_path = ''
as $$
  with o as (
    select t.realized_pnl, t.cost, t.closed_at, t.created_at,
           t.realized_pnl / nullif(t.cost, 0) as r
    from public.trade_outcomes t
    where t.realized_pnl is not null
      and not t.is_paper
      and t.cost > 0
      and case when p_thesis_id is not null then t.thesis_id = p_thesis_id else t.steward = p_steward end
  ),
  ordered as (
    select o.realized_pnl,
           row_number() over (order by o.closed_at desc nulls last, o.created_at desc) as rn
    from o
  ),
  streak as (
    select coalesce(min(rn) - 1, (select count(*) from ordered)) as k
    from ordered where realized_pnl >= 0
  )
  select count(*)::int,
         count(*) filter (where o.realized_pnl > 0)::int,
         avg(o.r),
         stddev_samp(o.r),
         (select k from streak)::int
  from o;
$$;

create or replace function private.edge_max_stake(p_steward text, p_thesis_id text, p_book_equity numeric)
returns table (max_stake numeric, reason text, trades integer, lcb numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  st record;
  v_starter numeric := private.steward_starter_stake(p_steward);
  v_haircut numeric;
  v_lcb numeric;
  v_kelly numeric;
  v_growth numeric;
  v_stake numeric;
  v_reason text;
  v_digits int := case when p_steward = 'bandit' then 4 else 2 end;
begin
  select * into st from private.stake_edge_stats(p_steward, p_thesis_id);
  v_haircut := power(0.5::numeric, least(coalesce(st.loss_streak, 0), 2));
  if coalesce(st.n, 0) >= 2 and st.sd_ret is not null then
    v_lcb := st.mean_ret - st.sd_ret / sqrt(st.n::numeric);
  end if;

  if coalesce(st.n, 0) >= 10 and v_lcb > 0 then
    v_growth := v_starter * power(2::numeric, 1 + (st.n - 10) / 5.0);
    v_kelly := case when st.sd_ret > 0 and p_book_equity > 0
      then p_book_equity * 0.5 * v_lcb / (st.sd_ret * st.sd_ret) end;
    v_stake := greatest(v_starter, least(coalesce(v_kelly, v_growth), v_growth));
    v_reason := format('proven edge: n=%s, LCB %s%% per trade; min(half-Kelly on LCB x book, starter x 2^(1+(n-10)/5))',
      st.n, round(v_lcb * 100, 2));
  else
    v_stake := v_starter;
    v_reason := case
      when coalesce(st.n, 0) < 10 then format('unproven: %s priced trades (< 10); starter %s', coalesce(st.n, 0), v_starter)
      else format('no measured edge: LCB %s%% <= 0 over %s trades; starter %s', round(v_lcb * 100, 2), st.n, v_starter)
    end;
  end if;
  if v_haircut < 1 then
    v_stake := v_stake * v_haircut;
    v_reason := v_reason || format('; x%s after %s straight losses', v_haircut, st.loss_streak);
  end if;
  return query select round(v_stake, v_digits), v_reason, coalesce(st.n, 0), round(v_lcb, 6);
end;
$$;

revoke all on function private.steward_starter_stake(text) from public, anon, authenticated;
revoke all on function private.stake_edge_stats(text, text) from public, anon, authenticated;
revoke all on function private.edge_max_stake(text, text, numeric) from public, anon, authenticated;

drop function if exists public.steward_sizing_guidance(text, text, text, numeric);

create or replace function public.steward_sizing_guidance(
  p_steward text, p_thesis_id text default null, p_instrument text default null, p_requested numeric default null,
  p_invalidation_price numeric default null
)
returns table (
  steward text, thesis_id text, instrument text, unit text,
  book_equity numeric, book_equity_at timestamptz, book_source text,
  spendable_cash numeric, current_position_value numeric,
  requested numeric, multiplier numeric, multiplier_basis text, sized_notional numeric,
  sample_trades integer, sample_wins integer, hit_rate numeric, avg_win numeric, avg_loss numeric,
  half_kelly_fraction numeric,
  thesis_confidence smallint, stated_confidence smallint, thesis_status text,
  gate_applies boolean,
  autonomous_buy_gate_pass boolean,
  thesis_rejected boolean,
  thesis_killed boolean,
  entry_allowed boolean,
  entry_blocked_reason text,
  sizing text,
  invalidation_price numeric,
  max_stake numeric,
  max_stake_reason text,
  edge_trades integer,
  edge_lcb numeric,
  book_age_minutes integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  eq record;
  st record;
  ca record;
  ms record;
  th public.theses%rowtype;
  v_basis text;
  v_mult numeric;
  v_gate_applies boolean := p_steward = 'quantanamo';
  v_rejected boolean;
  v_killed boolean;
  v_unknown boolean := false;
  v_no_inval boolean := p_invalidation_price is null or p_invalidation_price <= 0;
  v_book_age integer;
  v_stale boolean;
  v_blocked boolean;
  v_gate boolean;
  v_allowed boolean;
  v_reason text;
begin
  if p_steward not in ('quantanamo', 'oddsborne', 'bandit') then
    raise exception 'unknown steward %', p_steward;
  end if;
  if p_requested is not null and p_requested <= 0 then
    raise exception 'requested size must be positive';
  end if;
  select * into eq from private.steward_book_equity(p_steward);
  select * into ca from private.steward_spendable_cash(p_steward);
  if p_thesis_id is not null then
    select * into th from public.theses where id = p_thesis_id;
    -- A thesis id that names no thesis never sizes an entry, for any steward.
    v_unknown := th.id is null;
    select * into st from private.thesis_outcome_stats(p_thesis_id);
    v_basis := case
      when v_unknown then 'unknown_thesis'
      when coalesce(st.n, 0) < 5 then 'thesis_thin_default'
      else 'thesis_half_kelly'
    end;
  else
    -- Null thesis: QUANTANAMO requires one (below); ODDSBORNE / BANDIT size untagged
    -- entries at the steward-level multiplier and the steward-level max stake.
    select * into st from private.steward_outcome_stats(p_steward);
    v_basis := case when coalesce(st.n, 0) < 5 then 'steward_thin_default' else 'steward_half_kelly' end;
  end if;
  v_mult := case when v_unknown then 0::numeric
    else private.half_kelly_multiplier(st.n, st.wins, st.avg_win, st.avg_loss) end;
  select * into ms from private.edge_max_stake(p_steward, p_thesis_id, eq.equity);

  -- Mechanical freshness: size only from a book observation <= 6 hours old.
  if ca.observed_at is not null and eq.observed_at is not null then
    v_book_age := floor(extract(epoch from (now() - least(ca.observed_at, eq.observed_at))) / 60);
  end if;
  v_stale := v_book_age is null or v_book_age > 360;

  v_rejected := coalesce(th.status = 'rejected', false);
  v_killed := coalesce(th.status = 'killed', false);
  v_blocked := v_rejected or v_killed or v_unknown;
  if v_gate_applies then
    v_gate := case when p_thesis_id is not null then th.status = 'hardening' and coalesce(th.confidence, 0) >= 80 end;
    v_allowed := coalesce(v_gate, false) and not v_blocked and not v_no_inval and not v_stale;
    v_reason := case
      when v_unknown then 'unknown_thesis'
      when v_rejected then 'thesis_rejected'
      when v_killed then 'thesis_killed'
      when p_thesis_id is null then 'quantanamo_requires_thesis'
      when not coalesce(v_gate, false) then 'quantanamo_confidence_gate'
      when v_no_inval then 'missing_invalidation'
      when v_stale then 'stale_book'
    end;
  else
    v_gate := not v_blocked;
    v_allowed := not v_blocked and not v_no_inval and not v_stale;
    v_reason := case
      when v_unknown then 'unknown_thesis'
      when v_rejected then 'thesis_rejected'
      when v_killed then 'thesis_killed'
      when v_no_inval then 'missing_invalidation'
      when v_stale then 'stale_book'
    end;
  end if;

  return query select
    p_steward, p_thesis_id, p_instrument, coalesce(eq.unit, case when p_steward = 'bandit' then 'SOL' else 'USD' end),
    eq.equity, eq.observed_at, eq.source,
    greatest(ca.cash, 0), private.steward_position_value(p_steward, p_instrument),
    p_requested, v_mult, v_basis,
    case
      when v_unknown then 0::numeric
      when p_requested is null then null
      when v_blocked or v_no_inval or v_stale then 0::numeric
      else round(least(p_requested * v_mult, ms.max_stake, greatest(coalesce(ca.cash, 0), 0)), 6)
    end,
    coalesce(st.n, 0), coalesce(st.wins, 0),
    case when st.n > 0 then round(st.wins::numeric / st.n, 4) end,
    st.avg_win, st.avg_loss,
    private.half_kelly_fraction(st.n, st.wins, st.avg_win, st.avg_loss),
    th.confidence, th.stated_confidence, th.status,
    v_gate_applies, v_gate, v_rejected, v_killed, v_allowed, v_reason,
    case when v_gate_applies
      then 'size = min(requested x multiplier, max_stake, spendable cash); max_stake is edge-scaled (starter until n >= 10 with a positive LCB); entries need an invalidation_price, a fresh book (<= 6h), and a hardening thesis at confidence >= 80; an unknown, rejected or killed thesis blocks new entries'
      else 'size = min(requested x multiplier, max_stake, spendable cash); max_stake is edge-scaled (starter until n >= 10 with a positive LCB); entries need an invalidation_price and a fresh book (<= 6h); an unknown, rejected or killed thesis blocks new entries'
    end::text,
    case when v_no_inval then null else p_invalidation_price end,
    case when v_unknown or v_rejected or v_killed then 0::numeric else ms.max_stake end,
    case when v_unknown or v_rejected or v_killed then 'blocked thesis' else ms.reason end,
    ms.trades, ms.lcb, v_book_age;
end;
$$;

revoke all on function public.steward_sizing_guidance(text, text, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text, numeric, numeric)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- Per-thesis max stake, for the desk and the stewards (measurement; no size decision).
create or replace function public.thesis_max_stakes()
returns table (
  steward text, thesis_id text, name text, status text, confidence smallint,
  max_stake numeric, unit text, trades integer, lcb numeric, reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.steward, t.id, t.name, t.status, t.confidence,
         m.max_stake, case s.steward when 'bandit' then 'SOL' else 'USD' end,
         m.trades, m.lcb, m.reason
  from public.theses t
  cross join lateral (
    select coalesce(
      (select o.steward from public.trade_outcomes o where o.thesis_id = t.id
        group by o.steward order by count(*) desc limit 1),
      (select a.slug from public.thesis_domains td
         join public.desk_domain_stewards ds on ds.domain_id = td.domain_id and ds.ended_at is null
         join public.desk_agents a on a.id = ds.agent_id
        where td.thesis_id = t.id and a.slug in ('quantanamo', 'oddsborne', 'bandit')
        order by ds.is_primary desc limit 1),
      'quantanamo') as steward
  ) s
  cross join lateral private.edge_max_stake(s.steward, t.id,
    (select e.equity from private.steward_book_equity(s.steward) e)) m
  where t.status not in ('rejected', 'killed');
$$;

revoke all on function public.thesis_max_stakes() from public, anon;
grant execute on function public.thesis_max_stakes()
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create or replace view public.v_thesis_max_stake
with (security_invoker = true)
as select * from public.thesis_max_stakes();

grant select on public.v_thesis_max_stake
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- New open lots must carry the steward's invalidation (grandfathered: existing open rows).
create or replace function private.require_lot_invalidation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'open' and new.invalidation_price is null
     and (tg_op = 'INSERT' or old.status is distinct from 'open' or old.invalidation_price is not null) then
    raise exception 'missing_invalidation: a new open lot on % needs invalidation_price', tg_table_name
      using errcode = 'check_violation',
            hint = 'Pass the invalidation price you gave steward_sizing_guidance (and invalidation_note).';
  end if;
  return new;
end;
$$;

drop trigger if exists require_lot_invalidation on public.position_episodes;
create trigger require_lot_invalidation before insert or update of status, invalidation_price
  on public.position_episodes for each row execute function private.require_lot_invalidation();
drop trigger if exists require_lot_invalidation on public.pm_positions;
create trigger require_lot_invalidation before insert or update of status, invalidation_price
  on public.pm_positions for each row execute function private.require_lot_invalidation();
drop trigger if exists require_lot_invalidation on public.meme_positions;
create trigger require_lot_invalidation before insert or update of status, invalidation_price
  on public.meme_positions for each row execute function private.require_lot_invalidation();
