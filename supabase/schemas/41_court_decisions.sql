-- Court decisions of 2026-09-26 (delegated by David to the parent agent), shipped through the court:
-- court-ruling: docs/rules/starter-stake.md
-- court-ruling: docs/rules/quantanamo-80-gate.md
-- court-ruling: docs/rules/outcome-rescore-confidence.md
-- court-ruling: docs/rules/portfolio-exposure.md
-- court-ruling: docs/rules/new-thesis-escape.md
--
-- 1. Starter = equal risk per bet: 0.03 x book / steward bet volatility (sd of return on stake over the
--    steward's closed priced non-paper trades, floored at 0.25; 1.0 while the steward has < 5 trades).
--    The drawdown scale still applies; a proven thesis keeps half-Kelly on the LCB, never below the starter.
-- 2. QUANTANAMO 80 gate reads the RESULTS score only (theses.results_confidence). A thesis with fewer than
--    3 effective trades is unscored and fails the gate (David approves). Backtest credit counts through
--    the same effective-trade math as the max stake. Stated confidence is display only.
-- 3. Re-scoring on expected return per trade: score = 100 x Phi(mean_eff / (sd_eff / sqrt(n_eff))).
--    Demote hardening -> forming only when the live upper bound (mean + sd/sqrt(n)) < 0 or n >= 10 with
--    mean < 0; kill only when n >= 10 and the upper bound < 0.
-- 4. Portfolio exposure: open risk to invalidation (sum of qty x (mark - invalidation_price), in the book
--    unit) <= 10% of the book. Guidance sizes a new entry down to fit or blocks with `exposure_cap`.

-- ---------------------------------------------------------------- 1. starter
create or replace function private.steward_bet_vol(p_steward text)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when s.n >= 5 and s.sd_ret is not null then greatest(s.sd_ret, 0.25) else 1.0 end
  from private.stake_edge_stats(p_steward, null) s;
$$;

comment on function private.steward_bet_vol(text) is
  'Steward bet volatility: sd of return on stake over closed, priced, non-paper trades, floored at 0.25 (1.0 while n < 5). docs/rules/starter-stake.md';

create or replace function private.steward_starter_share(p_steward text)
returns numeric
language sql
stable
set search_path = ''
as $$
  select round(0.03 / private.steward_bet_vol(p_steward), 5);
$$;

comment on function private.steward_starter_share(text) is
  'Starter max stake as a share of current book = 0.03 / steward bet volatility (equal 3% book risk per unproven bet). docs/rules/starter-stake.md';

-- ---------------------------------------------------------------- 2 + 3. results score
alter table public.theses add column if not exists results_confidence smallint
  check (results_confidence between 0 and 100);
alter table public.theses add column if not exists results_basis jsonb;
alter table public.theses add column if not exists results_scored_at timestamptz;

comment on column public.theses.results_confidence is
  'Results score 0-100 = 100 x P(expected return per trade > 0) from live trades plus discounted out-of-sample backtest credit; null = unscored (< 3 effective trades). The QUANTANAMO autonomous gate reads only this. Written only by private.rescore_thesis_confidence. docs/rules/outcome-rescore-confidence.md';

create or replace function private.normal_cdf(p_z numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  -- tanh approximation of the standard normal CDF (abs error < 3e-4), z clamped to [-8, 8].
  select (0.5 * (1 + tanh(sqrt(2 / pi()) * (z + 0.044715 * z * z * z))))::numeric
  from (select least(8, greatest(-8, p_z))::double precision as z) x;
$$;

create or replace function private.thesis_results_score(p_thesis_id text)
returns table (score smallint, n_live integer, bt_weight numeric, n_eff numeric, mean_eff numeric,
               sd_eff numeric, z numeric, ucb numeric, demote boolean, kill boolean)
language plpgsql
stable
set search_path = ''
as $$
declare
  st record;
  bt record;
  v_n numeric;
  v_w numeric;
  v_neff numeric;
  v_mean numeric;
  v_var numeric;
  v_sd numeric;
  v_z numeric;
  v_ucb numeric;
  v_sd_live numeric;
begin
  select * into st from private.stake_edge_stats(null, p_thesis_id);
  select * into bt from private.thesis_edge_evidence(p_thesis_id);
  v_n := coalesce(st.n, 0);
  v_w := coalesce(bt.weight, 0);
  v_neff := v_n + v_w;
  if v_neff > 0 then
    v_mean := (v_n * coalesce(st.mean_ret, 0) + v_w * 0.5 * coalesce(bt.mean_ret, 0)) / v_neff;
  end if;
  v_var := case
    when v_n >= 2 and st.sd_ret is not null and v_w > 0 then (v_n * st.sd_ret ^ 2 + v_w * bt.sd_ret ^ 2) / v_neff
    when v_n >= 2 and st.sd_ret is not null then st.sd_ret ^ 2
    when v_w > 0 then bt.sd_ret ^ 2
  end;
  v_sd := greatest(coalesce(sqrt(v_var), 0), 0.25);
  if v_neff >= 3 then
    v_z := v_mean / (v_sd / sqrt(v_neff));
  end if;
  if v_n >= 2 then
    v_sd_live := greatest(coalesce(st.sd_ret, 0), 0.25);
    v_ucb := st.mean_ret + v_sd_live / sqrt(v_n);
  end if;
  return query select
    case when v_z is not null then round(100 * private.normal_cdf(v_z))::smallint end,
    v_n::int, v_w, v_neff, round(v_mean, 6), round(v_sd, 6), round(v_z, 4), round(v_ucb, 6),
    coalesce(v_ucb < 0, false) or (v_n >= 10 and coalesce(st.mean_ret, 0) < 0),
    v_n >= 10 and coalesce(v_ucb < 0, false);
end;
$$;

comment on function private.thesis_results_score(text) is
  'Results score for a thesis: n_eff = live trades + min(0.5 x backtest n, 20); mean_eff pools live mean with the backtest mean haircut 50%; sd_eff = max(pooled sd, 0.25); score = round(100 x Phi(mean_eff / (sd_eff / sqrt(n_eff)))) when n_eff >= 3, else null (unscored). demote: live UCB < 0 or (n >= 10 and mean < 0); kill: n >= 10 and UCB < 0.';

create or replace function private.rescore_thesis_confidence(p_thesis_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  th public.theses%rowtype;
  sc record;
  v_stated smallint;
  v_conf smallint;
  v_status text;
  v_basis jsonb;
begin
  if p_thesis_id is null then
    return null;
  end if;
  select * into th from public.theses where id = p_thesis_id for update;
  if not found then
    return null;
  end if;
  select * into sc from private.thesis_results_score(p_thesis_id);
  v_stated := coalesce(th.stated_confidence, th.confidence);
  v_conf := coalesce(sc.score, v_stated);
  v_status := case
    when th.status in ('killed', 'rejected') then th.status
    when sc.kill then 'killed'
    when sc.demote and th.status = 'hardening' then 'forming'
    else th.status
  end;
  v_basis := jsonb_build_object('rule', 'results_score_v2', 'n_live', sc.n_live, 'backtest_weight', sc.bt_weight,
    'n_eff', sc.n_eff, 'mean_eff', sc.mean_eff, 'sd_eff', sc.sd_eff, 'z', sc.z, 'ucb_live', sc.ucb,
    'demote', sc.demote, 'kill', sc.kill);

  if th.results_confidence is not distinct from sc.score
     and th.confidence is not distinct from v_conf
     and th.status is not distinct from v_status
     and th.stated_confidence is not distinct from v_stated
     and th.results_basis is not distinct from v_basis then
    return jsonb_build_object('thesis_id', p_thesis_id, 'changed', false, 'results_confidence', sc.score,
      'confidence', v_conf, 'status', v_status);
  end if;

  perform set_config('grasshopper.outcome_rescore', 'on', true);
  update public.theses
  set results_confidence = sc.score,
      results_basis = v_basis,
      results_scored_at = now(),
      confidence = v_conf,
      stated_confidence = v_stated,
      status = v_status,
      updated_at = now()
  where id = p_thesis_id;
  perform set_config('grasshopper.outcome_rescore', 'off', true);

  if th.results_confidence is distinct from sc.score or th.confidence is distinct from v_conf
     or th.status is distinct from v_status then
    insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, meta)
    values (
      p_thesis_id, th.confidence, v_conf,
      format('Results re-score: %s live trades%s, expected return per trade %s%%, score %s%s.',
        sc.n_live, case when sc.bt_weight > 0 then format(' + %s backtest-weighted', sc.bt_weight) else '' end,
        coalesce(round(sc.mean_eff * 100, 2)::text, 'n/a'), coalesce(sc.score::text, 'unscored (< 3 effective trades)'),
        case when v_status is distinct from th.status then '; ' || th.status || ' -> ' || v_status else '' end),
      jsonb_build_object('kind', 'outcome_rescore', 'prior_confidence', th.confidence, 'new_confidence', v_conf,
        'prior_results_confidence', th.results_confidence, 'results_confidence', sc.score,
        'stated_confidence', v_stated, 'prior_status', th.status, 'new_status', v_status) || v_basis
    );
  end if;

  return jsonb_build_object('thesis_id', p_thesis_id, 'changed', true,
    'prior_confidence', th.confidence, 'new_confidence', v_conf,
    'prior_results_confidence', th.results_confidence, 'results_confidence', sc.score,
    'prior_status', th.status, 'new_status', v_status) || v_basis;
end;
$$;

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
  for r in select t.id from public.theses t order by t.id loop
    v_out := v_out || jsonb_build_array(private.rescore_thesis_confidence(r.id));
  end loop;
  return v_out;
end;
$$;

-- Steward writes to confidence / stated_confidence set the stated (display) view; the displayed
-- confidence is the results score when scored. Status is never changed on a steward write.
create or replace function private.theses_outcome_temper()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base numeric;
begin
  if coalesce(current_setting('grasshopper.outcome_rescore', true), 'off') = 'on' then
    return new;
  end if;
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
    new.stated_confidence := v_base::smallint;
    new.confidence := coalesce(old.results_confidence, v_base::smallint);
  exception when others then
    raise warning 'theses_outcome_temper(%): %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- Only the re-score writes the results columns.
create or replace function private.theses_results_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('grasshopper.outcome_rescore', true), 'off') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.results_confidence := null;
    new.results_basis := null;
    new.results_scored_at := null;
  else
    new.results_confidence := old.results_confidence;
    new.results_basis := old.results_basis;
    new.results_scored_at := old.results_scored_at;
  end if;
  return new;
end;
$$;

drop trigger if exists theses_results_guard on public.theses;
create trigger theses_results_guard
  before insert or update on public.theses
  for each row execute function private.theses_results_guard();

create or replace function private.backtest_evidence_rescore()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.rescore_thesis_confidence(new.thesis_id);
    if tg_op = 'UPDATE' and old.thesis_id is distinct from new.thesis_id then
      perform private.rescore_thesis_confidence(old.thesis_id);
    end if;
  exception when others then
    raise warning 'backtest_evidence_rescore(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists thesis_backtest_evidence_rescore on public.thesis_backtest_evidence;
create trigger thesis_backtest_evidence_rescore
  after insert or update on public.thesis_backtest_evidence
  for each row execute function private.backtest_evidence_rescore();

-- ---------------------------------------------------------------- 4. exposure
create or replace function private.risk_budget_share()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 0.10::numeric $$;

create or replace function private.steward_open_risk(p_steward text)
returns table (steward text, unit text, book_equity numeric, open_risk numeric, risk_budget_share numeric,
               risk_budget numeric, risk_headroom numeric, used_share numeric, lots integer,
               lots_unmarked integer, lots_without_invalidation integer)
language sql
stable
security definer
set search_path = ''
as $$
  with e as (select * from private.steward_book_equity(p_steward)),
  l as (
    select m.quantity, m.mark, m.invalidation_price,
           case
             when m.mark is null then 0
             when m.invalidation_price is null then m.quantity * m.mark
             else m.quantity * greatest(m.mark - m.invalidation_price, 0)
           end as risk
    from public.v_open_lot_marks m
    where m.steward = p_steward
  )
  select p_steward,
         coalesce((select e.unit from e), case when p_steward = 'bandit' then 'SOL' else 'USD' end),
         (select e.equity from e),
         round(coalesce(sum(l.risk), 0), 6),
         private.risk_budget_share(),
         round(private.risk_budget_share() * (select e.equity from e), 6),
         round(private.risk_budget_share() * (select e.equity from e) - coalesce(sum(l.risk), 0), 6),
         round(coalesce(sum(l.risk), 0) / nullif((select e.equity from e), 0), 4),
         count(*)::int,
         count(*) filter (where l.mark is null)::int,
         count(*) filter (where l.invalidation_price is null)::int
  from l;
$$;

comment on function private.steward_open_risk(text) is
  'Open risk to invalidation per book: sum over open lots of qty x max(mark - invalidation_price, 0) in the book unit (a lot with no invalidation counts at full qty x mark; an unmarked lot counts 0 and is flagged). Budget = 10% of book. docs/rules/portfolio-exposure.md';

revoke all on function private.steward_open_risk(text) from public, anon;
grant execute on function private.steward_open_risk(text)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create or replace view public.v_exposure_usage
with (security_invoker = true)
as
select r.* from unnest(array['quantanamo', 'oddsborne', 'bandit']) s(steward)
cross join lateral private.steward_open_risk(s.steward) r;

grant select on public.v_exposure_usage
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

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
              'risk_budget', x.risk_budget, 'used_share', x.used_share, 'headroom', x.risk_headroom))
            from public.v_exposure_usage x), '{}'::jsonb) as exposure;

revoke all on function private.steward_bet_vol(text) from public, anon, authenticated;
revoke all on function private.steward_starter_share(text) from public, anon, authenticated;
revoke all on function private.normal_cdf(numeric) from public, anon, authenticated;
revoke all on function private.thesis_results_score(text) from public, anon, authenticated;
revoke all on function private.rescore_thesis_confidence(text) from public, anon, authenticated;
revoke all on function private.rescore_all_thesis_confidence() from public, anon, authenticated;
revoke all on function private.theses_results_guard() from public, anon, authenticated;
revoke all on function private.backtest_evidence_rescore() from public, anon, authenticated;
revoke all on function private.risk_budget_share() from public, anon, authenticated;

-- ---------------------------------------------------------------- guidance
-- Adds p_entry_price (6th, optional) and the results-score gate, exposure fit and new output columns.
drop function if exists public.steward_sizing_guidance(text, text, text, numeric, numeric);

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
  entry_risk_fraction numeric
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
  -- Portfolio exposure: open risk to invalidation stays <= 10% of the book. The new entry's risk per
  -- unit notional is (entry - invalidation) / entry; without an entry price the whole notional counts.
  select * into ex from private.steward_open_risk(p_steward);
  v_frac := case
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
      else 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk to invalidation <= 10% of book (pass p_entry_price); entries need an invalidation_price and a fresh book (<= 6h); an unknown, rejected or killed thesis blocks new entries'
    end::text,
    case when v_no_inval then null else p_invalidation_price end,
    case when v_unknown or v_rejected or v_killed then 0::numeric else ms.max_stake end,
    case when v_unknown or v_rejected or v_killed then 'blocked thesis' else ms.reason end,
    ms.trades, ms.lcb, v_book_age,
    th.results_confidence, ex.open_risk, ex.risk_budget, ex.risk_headroom, round(v_frac, 6);
end;
$$;

revoke all on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- Re-score every thesis under the new rule (status changes are logged in belief_updates).
select private.rescore_all_thesis_confidence();
