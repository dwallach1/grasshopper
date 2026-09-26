-- Exposure counts gap-prone lots at full notional (court ruling amended 2026-09-26).
-- court-ruling: docs/rules/portfolio-exposure.md
--
-- A Polymarket binary can jump from its mark to 0 on one score, and a meme can rug in one block, so an
-- invalidation line does not bound their loss. ODDSBORNE counts every open binary at price x contracts
-- (mark, else average cost) and BANDIT every meme lot at its full cost basis (qty x average cost, else
-- qty x mark). QUANTANAMO equities keep qty x max(mark - invalidation, 0) (no invalidation: qty x mark).
-- Guidance counts a new gap-prone entry at full notional (risk fraction 1). New `risk_basis`
-- ('full_notional' | 'to_invalidation') on v_exposure_usage, the per-lot view and guidance.

-- ---------------------------------------------------------------- 1. per-lot risk
create or replace function private.steward_risk_basis(p_steward text)
returns text
language sql
immutable
set search_path = ''
as $$ select case when p_steward in ('oddsborne', 'bandit') then 'full_notional' else 'to_invalidation' end $$;

create or replace function private.open_risk_lots()
returns table (steward text, lot_table text, lot_id uuid, instrument text, unit text, quantity numeric,
               mark numeric, mark_at timestamptz, invalidation_price numeric, average_cost numeric,
               risk_basis text, risk numeric, unmarked boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select m.steward, m.lot_table, m.lot_id, m.instrument, m.unit, m.quantity, m.mark, m.mark_at,
         m.invalidation_price, c.average_cost,
         private.steward_risk_basis(m.steward),
         round(case
           -- Gap-prone: full notional. Binaries at price x contracts; memes at cost basis.
           when m.lot_table = 'pm_positions' then m.quantity * coalesce(m.mark, c.average_cost, 0)
           when m.lot_table = 'meme_positions' then m.quantity * coalesce(c.average_cost, m.mark, 0)
           -- Equities: to invalidation, positive part only.
           when m.mark is null then 0
           when m.invalidation_price is null then m.quantity * m.mark
           else m.quantity * greatest(m.mark - m.invalidation_price, 0)
         end, 6),
         case
           when m.lot_table = 'pm_positions' then m.mark is null and c.average_cost is null
           when m.lot_table = 'meme_positions' then c.average_cost is null and m.mark is null
           else m.mark is null
         end
  from public.v_open_lot_marks m
  left join lateral (
    select coalesce(
      (select p.average_cost from public.pm_positions p where m.lot_table = 'pm_positions' and p.id = m.lot_id),
      (select p.average_cost_sol from public.meme_positions p where m.lot_table = 'meme_positions' and p.id = m.lot_id),
      (select p.average_cost from public.position_episodes p where m.lot_table = 'position_episodes' and p.id = m.lot_id)
    ) as average_cost
  ) c on true;
$$;

comment on function private.open_risk_lots() is
  'Open risk per open lot in the book unit. risk_basis full_notional (ODDSBORNE binaries: qty x price; BANDIT memes: qty x cost basis) or to_invalidation (QUANTANAMO: qty x max(mark - invalidation, 0)). docs/rules/portfolio-exposure.md';

revoke all on function private.open_risk_lots() from public, anon;
grant execute on function private.open_risk_lots()
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 2. per-steward totals (+ risk_basis)
drop view if exists public.v_ledger_watchdog;
drop view if exists public.v_exposure_usage;
drop function if exists private.steward_open_risk(text);

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
  'Open risk per book vs a 10%-of-book budget: sum of private.open_risk_lots() (gap-prone ODDSBORNE / BANDIT lots at full notional; QUANTANAMO to invalidation). docs/rules/portfolio-exposure.md';

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

grant select on public.v_exposure_lots
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

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
            from public.v_exposure_usage x), '{}'::jsonb) as exposure;

grant select on public.v_ledger_watchdog to authenticated, quantanamo_worker, desk_public_reader, service_role;

revoke all on function private.steward_risk_basis(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- 3. guidance (+ risk_basis)
drop function if exists public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric);

create function public.steward_sizing_guidance(
  p_steward text, p_thesis_id text default null, p_instrument text default null, p_requested numeric default null,
  p_invalidation_price numeric default null, p_entry_price numeric default null
)
returns table (
  steward text, thesis_id text, instrument text, unit text,
  book_equity numeric, book_equity_at timestamptz, book_source text,
  spendable_cash numeric, current_position_value numeric,
  requested numeric, sized_notional numeric,
  sample_trades integer, sample_wins integer, hit_rate numeric, avg_win numeric, avg_loss numeric,
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
  book_age_minutes integer,
  results_confidence smallint,
  open_risk numeric,
  risk_budget numeric,
  risk_headroom numeric,
  entry_risk_fraction numeric,
  risk_basis text
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
  ex record;
  v_frac numeric;
  v_fit numeric;
  v_exposure boolean;
  th public.theses%rowtype;
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
  else
    -- Null thesis: QUANTANAMO requires one (below); ODDSBORNE / BANDIT size untagged
    -- entries at the steward-level max stake (sample stats are steward-level).
    select * into st from private.steward_outcome_stats(p_steward);
  end if;
  select * into ms from private.edge_max_stake(p_steward, p_thesis_id, eq.equity);
  -- Portfolio exposure: open risk stays <= 10% of the book. Gap-prone books (ODDSBORNE binaries,
  -- BANDIT memes) count the new entry at full notional (a score or a rug jumps past the line), so the
  -- risk fraction is 1. Equities count (entry - invalidation) / entry; without an entry price, 1.
  select * into ex from private.steward_open_risk(p_steward);
  v_frac := case
    when ex.risk_basis = 'full_notional' then 1
    when p_entry_price > 0 and p_invalidation_price > 0 and p_invalidation_price < p_entry_price
      then (p_entry_price - p_invalidation_price) / p_entry_price
    else 1 end;
  v_fit := greatest(ex.risk_headroom, 0) / v_frac;
  v_exposure := coalesce(ex.risk_headroom, 0) <= 0;

  -- Mechanical freshness: size only from a book observation <= 6 hours old.
  if ca.observed_at is not null and eq.observed_at is not null then
    v_book_age := floor(extract(epoch from (now() - least(ca.observed_at, eq.observed_at))) / 60);
  end if;
  v_stale := v_book_age is null or v_book_age > 360;

  v_rejected := coalesce(th.status = 'rejected', false);
  v_killed := coalesce(th.status = 'killed', false);
  v_blocked := v_rejected or v_killed or v_unknown;
  if v_gate_applies then
    -- The gate reads the RESULTS score only; an unscored thesis (< 3 effective trades) fails (David approves).
    v_gate := case when p_thesis_id is not null then th.status = 'hardening' and coalesce(th.results_confidence, 0) >= 80 end;
    v_allowed := coalesce(v_gate, false) and not v_blocked and not v_no_inval and not v_stale and not v_exposure;
    v_reason := case
      when v_unknown then 'unknown_thesis'
      when v_rejected then 'thesis_rejected'
      when v_killed then 'thesis_killed'
      when p_thesis_id is null then 'quantanamo_requires_thesis'
      when th.results_confidence is null and th.status = 'hardening' then 'quantanamo_unscored'
      when not coalesce(v_gate, false) then 'quantanamo_confidence_gate'
      when v_no_inval then 'missing_invalidation'
      when v_stale then 'stale_book'
      when v_exposure then 'exposure_cap'
    end;
  else
    v_gate := not v_blocked;
    v_allowed := not v_blocked and not v_no_inval and not v_stale and not v_exposure;
    v_reason := case
      when v_unknown then 'unknown_thesis'
      when v_rejected then 'thesis_rejected'
      when v_killed then 'thesis_killed'
      when v_no_inval then 'missing_invalidation'
      when v_stale then 'stale_book'
      when v_exposure then 'exposure_cap'
    end;
  end if;

  return query select
    p_steward, p_thesis_id, p_instrument, coalesce(eq.unit, case when p_steward = 'bandit' then 'SOL' else 'USD' end),
    eq.equity, eq.observed_at, eq.source,
    greatest(ca.cash, 0), private.steward_position_value(p_steward, p_instrument),
    p_requested,
    case
      when v_unknown then 0::numeric
      when p_requested is null then null
      when v_blocked or v_no_inval or v_stale or v_exposure then 0::numeric
      else round(least(p_requested, ms.max_stake, greatest(coalesce(ca.cash, 0), 0), v_fit), 6)
    end,
    coalesce(st.n, 0), coalesce(st.wins, 0),
    case when st.n > 0 then round(st.wins::numeric / st.n, 4) end,
    st.avg_win, st.avg_loss,
    th.confidence, th.stated_confidence, th.status,
    v_gate_applies, v_gate, v_rejected, v_killed, v_allowed, v_reason,
    case when v_gate_applies
      then 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk to invalidation <= 10% of book (pass p_entry_price); entries need an invalidation_price, a fresh book (<= 6h), and a hardening thesis with results_confidence >= 80 (unscored = David approves); an unknown, rejected or killed thesis blocks new entries'
      else 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk <= 10% of book with every open lot and the new entry at full notional (gap-prone: binaries at price x contracts, memes at cost basis); entries need an invalidation_price and a fresh book (<= 6h); an unknown, rejected or killed thesis blocks new entries'
    end::text,
    case when v_no_inval then null else p_invalidation_price end,
    case when v_unknown or v_rejected or v_killed then 0::numeric else ms.max_stake end,
    case when v_unknown or v_rejected or v_killed then 'blocked thesis' else ms.reason end,
    ms.trades, ms.lcb, v_book_age,
    th.results_confidence, ex.open_risk, ex.risk_budget, ex.risk_headroom, round(v_frac, 6), ex.risk_basis;
end;
$$;

revoke all on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
