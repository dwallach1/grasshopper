-- Rules-court rulings, 2026-09-26 (docs/rules/, docs/rules/SIMULATION.md). Implements the clear
-- verdicts; the needs_david rulings (starter level, 80 gate, rescore, portfolio budget) are not shipped.
-- court-ruling: docs/rules/starter-stake.md
-- court-ruling: docs/rules/loss-streak-halving.md
-- court-ruling: docs/rules/drawdown-scaling.md
-- court-ruling: docs/rules/new-thesis-escape.md
-- court-ruling: docs/rules/confidence-multiplier.md
-- court-ruling: docs/rules/backtest-evidence-credit.md
-- court-ruling: docs/rules/edge-max-stake.md
--
-- 1. Starter = share of the CURRENT book (today's dollar starters re-expressed, so no change at
--    today's book): quantanamo 0.04545, oddsborne 0.05418, bandit 0.05546.
-- 2. Per-thesis consecutive-loss halving is struck. Replaced by steward-level drawdown scaling:
--    x1 at <= 10% below the closing high-water mark, linear to x0.5 at >= 40%. It applies to every
--    thesis (proven or new), which also closes the new-thesis escape.
-- 3. Out-of-sample backtest evidence (public.thesis_backtest_evidence) adds min(0.5 x n, 20)
--    effective trades with its mean haircut 50%.
-- 4. The half-Kelly outcome multiplier no longer scales size: sized = min(requested, max_stake, cash).

create or replace function private.steward_starter_share(p_steward text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case p_steward
    when 'quantanamo' then 0.04545::numeric  -- $250 / $5,500.65 book on 2026-09-26
    when 'oddsborne' then 0.05418::numeric   -- $15 / $276.87
    when 'bandit' then 0.05546::numeric      -- 0.10 SOL / 1.8032 SOL
  end;
$$;

comment on function private.steward_starter_share(text) is
  'Starter max stake for an unproven thesis as a share of current book equity (docs/rules/starter-stake.md). The level is a David decision; these are the 2026-09-26 dollar starters re-expressed.';

create or replace function private.steward_starter_stake(p_steward text)
returns numeric
language sql
stable
set search_path = ''
as $$
  select round(private.steward_starter_share(p_steward) * e.equity, case when p_steward = 'bandit' then 4 else 2 end)
  from private.steward_book_equity(p_steward) e;
$$;

comment on function private.steward_starter_stake(text) is
  'Starter max stake in the book unit = steward_starter_share x current book equity.';

-- Closing high-water mark: the max over UTC days of each day's LAST book observation (intraday
-- observations taken at entry time can double-count cash and the new lot), plus the latest value.
create or replace function private.steward_drawdown(p_steward text)
returns table (hwm numeric, hwm_day date, equity numeric, drawdown numeric, scale numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_eq numeric;
begin
  select e.equity into v_eq from private.steward_book_equity(p_steward) e;
  return query
  with obs as (
    select s.observed_at as at, s.total_value as v from public.account_snapshots s
     where p_steward = 'quantanamo' and s.account_label ~* '7638' and s.total_value > 0
    union all
    select p.as_of, p.equity from public.pm_pnl p where p_steward = 'oddsborne' and p.equity > 0
    union all
    select m.as_of, m.equity_sol from public.meme_pnl m where p_steward = 'bandit' and m.equity_sol > 0
  ),
  closes as (
    select (o.at at time zone 'UTC')::date as d, (array_agg(o.v order by o.at desc))[1] as v
    from obs o group by 1
  ),
  peak as (
    select c.v, c.d from closes c order by c.v desc, c.d limit 1
  )
  select greatest(pk.v, v_eq), case when v_eq > pk.v then (now() at time zone 'UTC')::date else pk.d end,
         v_eq, dd.x,
         round(case when dd.x <= 0.10 then 1.0
                    when dd.x >= 0.40 then 0.5
                    else 1.0 - 0.5 * (dd.x - 0.10) / 0.30 end, 4)
  from peak pk
  cross join lateral (select greatest(0, 1 - v_eq / nullif(greatest(pk.v, v_eq), 0)) as x) dd;
end;
$$;

comment on function private.steward_drawdown(text) is
  'Steward drawdown from its closing high-water mark and the size scale (x1 at <= 10%, linear to x0.5 at >= 40%). docs/rules/drawdown-scaling.md';

-- Out-of-sample backtest evidence per thesis (docs/rules/backtest-evidence-credit.md).
create table if not exists public.thesis_backtest_evidence (
  id bigint generated always as identity primary key,
  thesis_id text not null references public.theses(id) on delete cascade,
  strategy_test_id bigint not null references public.strategy_tests(id) on delete cascade,
  n_trades integer not null check (n_trades > 0),
  mean_ret numeric not null check (mean_ret > -1 and mean_ret < 10),
  sd_ret numeric not null check (sd_ret > 0),
  out_of_sample boolean not null,
  costs_included boolean not null,
  window_start date,
  window_end date,
  method text not null,
  notes text,
  recorded_by text not null,
  recorded_at timestamptz not null default now(),
  active boolean not null default true
);

comment on table public.thesis_backtest_evidence is
  'Backtest evidence per thesis: return on stake per trade (mean, sd, n). Only an active, out_of_sample, costs_included row linked to a survived strategy_tests row with deflated_sharpe > 0 counts toward the edge-scaled max stake: min(0.5 x n, 20) effective trades, mean haircut 50%.';

create unique index if not exists thesis_backtest_evidence_one_active
  on public.thesis_backtest_evidence (thesis_id) where active;

alter table public.thesis_backtest_evidence enable row level security;
grant select on public.thesis_backtest_evidence
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker;
grant insert, update on public.thesis_backtest_evidence to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
grant select, delete on public.thesis_backtest_evidence to service_role;

drop policy if exists evidence_read on public.thesis_backtest_evidence;
create policy evidence_read on public.thesis_backtest_evidence
  for select to desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker using (true);
drop policy if exists ledger_operator_select on public.thesis_backtest_evidence;
create policy ledger_operator_select on public.thesis_backtest_evidence
  for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists evidence_worker_insert on public.thesis_backtest_evidence;
create policy evidence_worker_insert on public.thesis_backtest_evidence
  for insert to quantanamo_worker, oddsborne_worker, bandit_worker with check (true);
drop policy if exists evidence_worker_update on public.thesis_backtest_evidence;
create policy evidence_worker_update on public.thesis_backtest_evidence
  for update to quantanamo_worker, oddsborne_worker, bandit_worker using (true) with check (true);

create or replace function private.thesis_edge_evidence(p_thesis_id text)
returns table (n_backtest integer, weight numeric, mean_ret numeric, sd_ret numeric, evidence_id bigint)
language sql
stable
set search_path = ''
as $$
  select b.n_trades, least(0.5 * b.n_trades, 20)::numeric, b.mean_ret, b.sd_ret, b.id
  from public.thesis_backtest_evidence b
  join public.strategy_tests t on t.id = b.strategy_test_id
  where b.thesis_id = p_thesis_id and b.active and b.out_of_sample and b.costs_included
    and t.status = 'survived' and t.deflated_sharpe > 0
  order by b.recorded_at desc
  limit 1;
$$;

create or replace function private.edge_max_stake(p_steward text, p_thesis_id text, p_book_equity numeric)
returns table (max_stake numeric, reason text, trades integer, lcb numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  st record;
  bt record;
  dd record;
  v_starter numeric;
  v_n numeric;
  v_w numeric := 0;
  v_neff numeric;
  v_mean numeric;
  v_var numeric;
  v_sd numeric;
  v_lcb numeric;
  v_kelly numeric;
  v_growth numeric;
  v_stake numeric;
  v_reason text;
  v_ev text := '';
  v_digits int := case when p_steward = 'bandit' then 4 else 2 end;
begin
  v_starter := case when p_book_equity > 0
    then round(private.steward_starter_share(p_steward) * p_book_equity, v_digits)
    else private.steward_starter_stake(p_steward) end;
  select * into st from private.stake_edge_stats(p_steward, p_thesis_id);
  v_n := coalesce(st.n, 0);
  if p_thesis_id is not null then
    select * into bt from private.thesis_edge_evidence(p_thesis_id);
    v_w := coalesce(bt.weight, 0);
  end if;
  v_neff := v_n + v_w;
  if v_neff > 0 then
    v_mean := (v_n * coalesce(st.mean_ret, 0) + v_w * 0.5 * coalesce(bt.mean_ret, 0)) / v_neff;
  end if;
  v_var := case
    when v_n >= 2 and st.sd_ret is not null and v_w > 0 then (v_n * st.sd_ret ^ 2 + v_w * bt.sd_ret ^ 2) / v_neff
    when v_n >= 2 and st.sd_ret is not null then st.sd_ret ^ 2
    when v_w > 0 then bt.sd_ret ^ 2
  end;
  v_sd := sqrt(v_var);
  if v_neff >= 2 and v_sd is not null then
    v_lcb := v_mean - v_sd / sqrt(v_neff);
  end if;
  if v_w > 0 then
    v_ev := format(' (%s live + %s backtest-weighted, backtest mean %s%% haircut 50%%)',
      v_n, trim_scale(round(v_w, 1)), round(bt.mean_ret * 100, 2));
  end if;

  if v_neff >= 10 and v_lcb > 0 then
    v_growth := v_starter * power(2::numeric, 1 + (v_neff - 10) / 5.0);
    v_kelly := case when v_sd > 0 and p_book_equity > 0
      then p_book_equity * 0.5 * v_lcb / (v_sd * v_sd) end;
    v_stake := greatest(v_starter, least(coalesce(v_kelly, v_growth), v_growth));
    v_reason := format('proven edge: n_eff=%s%s, LCB %s%% per trade; min(half-Kelly on LCB x book, starter x 2^(1+(n-10)/5))',
      trim_scale(round(v_neff, 1)), v_ev, round(v_lcb * 100, 2));
  else
    v_stake := v_starter;
    v_reason := case
      when v_neff < 10 then format('unproven: %s effective trades (< 10)%s; starter %s (%s%% of book)',
        trim_scale(round(v_neff, 1)), v_ev, v_starter, round(private.steward_starter_share(p_steward) * 100, 2))
      else format('no measured edge: LCB %s%% <= 0 over %s effective trades%s; starter %s (%s%% of book)',
        round(v_lcb * 100, 2), trim_scale(round(v_neff, 1)), v_ev, v_starter, round(private.steward_starter_share(p_steward) * 100, 2))
    end;
  end if;

  select * into dd from private.steward_drawdown(p_steward);
  if dd.scale is not null and dd.scale < 1 then
    v_stake := v_stake * dd.scale;
    v_reason := v_reason || format('; x%s steward drawdown scale (book %s%% below its closing high %s)',
      trim_scale(dd.scale), round(dd.drawdown * 100, 1), trim_scale(round(dd.hwm, v_digits)));
  end if;
  return query select round(v_stake, v_digits), v_reason, v_n::int, round(v_lcb, 6);
end;
$$;

revoke all on function private.steward_starter_share(text) from public, anon, authenticated;
revoke all on function private.steward_starter_stake(text) from public, anon, authenticated;
revoke all on function private.steward_drawdown(text) from public, anon, authenticated;
revoke all on function private.thesis_edge_evidence(text) from public, anon, authenticated;
revoke all on function private.edge_max_stake(text, text, numeric) from public, anon, authenticated;

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
      else round(least(p_requested, ms.max_stake, greatest(coalesce(ca.cash, 0), 0)), 6)
    end,
    coalesce(st.n, 0), coalesce(st.wins, 0),
    case when st.n > 0 then round(st.wins::numeric / st.n, 4) end,
    st.avg_win, st.avg_loss,
    private.half_kelly_fraction(st.n, st.wins, st.avg_win, st.avg_loss),
    th.confidence, th.stated_confidence, th.status,
    v_gate_applies, v_gate, v_rejected, v_killed, v_allowed, v_reason,
    case when v_gate_applies
      then 'size = min(requested, max_stake, spendable cash) (the multiplier is informational); max_stake = starter (share of book) until n_eff >= 10 with a positive LCB (live trades + discounted out-of-sample backtest), then half-Kelly on the LCB, all x the steward drawdown scale; entries need an invalidation_price, a fresh book (<= 6h), and a hardening thesis at confidence >= 80; an unknown, rejected or killed thesis blocks new entries'
      else 'size = min(requested, max_stake, spendable cash) (the multiplier is informational); max_stake = starter (share of book) until n_eff >= 10 with a positive LCB (live trades + discounted out-of-sample backtest), then half-Kelly on the LCB, all x the steward drawdown scale; entries need an invalidation_price and a fresh book (<= 6h); an unknown, rejected or killed thesis blocks new entries'
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

-- Registry: rulings enacted by this migration (docs/rules/).
update public.desk_rules set status = 'repealed', updated_at = now() where rule_id = 'loss-streak-halving';
update public.desk_rules set status = 'in_force', updated_at = now() where rule_id = 'drawdown-scaling';
update public.desk_rules set status = 'repealed', updated_at = now() where rule_id = 'new-thesis-escape';
update public.desk_rules set status = 'repealed', updated_at = now() where rule_id = 'confidence-multiplier';
update public.desk_rules set status = 'in_force', updated_at = now() where rule_id = 'backtest-evidence-credit';
