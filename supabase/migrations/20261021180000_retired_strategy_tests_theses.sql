-- Retired status for strategy_tests and theses.
-- court-ruling: docs/rules/thesis-status-blocks.md
-- court-ruling: docs/rules/outcome-rescore-confidence.md
-- court-ruling: docs/rules/backtest-evidence-credit.md
--
-- strategy_tests.status had no check. Live values on 2026-10-21, before this
-- file: placeholder, queued, survived, killed, lookahead_invalid. Code also
-- orders a 'running' test (apps/dashboard/lib/ledger.ts), so the check allows
-- it. 'retired' is new.
--
-- The watchdog stale-queued count already requires status = 'queued'
-- (public.strategy_test_is_stale_queued). A retired row is not queued, so it
-- stays out of v_stale_queued_tests. Lesson waits on the desk already ignore
-- any test that is not queued. Tests 39, 41 and 43 are left queued.
--
-- A retired thesis blocks a new entry the same way a killed thesis does
-- (steward_sizing_guidance: thesis_killed, sized_notional 0). Rescore keeps
-- the status. thesis_max_stakes hides it. A retired strategy test is not a
-- kill and not a survival: backtest evidence does not verify it, and it does
-- not count in thesis_trials (it was a placeholder, which was already excluded).
--
-- Backfill: the 15 tests QUANTANAMO retired on 2026-10-20, plus test 33.
-- Test 33's failure_reason does not contain 'retired 2026-10-20' (it still
-- says it is awaiting day-0 bars). QUANTANAMO named it, so it is included.
-- meme_flush_rebound was killed as a stand-in on 2026-10-21; this moves it
-- to retired and writes one belief_updates row. failure_reason is kept.
--
-- Declarative copy: supabase/schemas/85_retired_strategy_tests_theses.sql.
-- Apply after 20261020180000_stale_queued_lesson_tests.

alter table public.strategy_tests drop constraint if exists strategy_tests_status_check;
alter table public.strategy_tests add constraint strategy_tests_status_check
  check (status in (
    'placeholder', 'queued', 'running', 'survived', 'killed', 'lookahead_invalid', 'retired'
  ));

comment on constraint strategy_tests_status_check on public.strategy_tests is
  'placeholder, queued, running, survived, killed, lookahead_invalid, retired. Retired is terminal and is not a kill.';

alter table public.theses drop constraint if exists theses_status_check;
alter table public.theses add constraint theses_status_check
  check (status in ('forming', 'hardening', 'rejected', 'killed', 'retired'));

comment on constraint theses_status_check on public.theses is
  'forming, hardening, rejected, killed, retired. Retired blocks new entries the same way killed does, and rescore does not move it.';

-- Rescore first, so a later status write cannot be flipped back.
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
    when th.status in ('killed', 'rejected', 'retired') then th.status
    when sc.kill then 'killed'
    when sc.demote and th.status = 'hardening' then 'forming'
    else th.status
  end;
  v_basis := jsonb_build_object('rule', 'results_score_v2', 'n_live', sc.n_live, 'backtest_weight', sc.bt_weight,
    'n_eff', sc.n_eff, 'mean_eff', sc.mean_eff, 'sd_eff', sc.sd_eff, 'z', sc.z, 'ucb_live', sc.ucb,
    'demote', sc.demote, 'kill', sc.kill, 'gate_score', sc.gate_score, 'gate_prior', 16);

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

create or replace function public.steward_sizing_guidance(
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
  -- paper only (theses.paper_only): a forward-paper thesis never sizes a real-money entry, for any steward.
  v_paper boolean := false;
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
  v_killed := coalesce(th.status in ('killed', 'retired'), false);
  v_paper := coalesce(th.paper_only, false);
  v_blocked := v_rejected or v_killed or v_unknown or v_paper;
  if v_gate_applies then
    -- The gate reads the prior-shrunk gate_score, not the shown results score (quantanamo-80-gate).
    -- An unscored thesis (< 3 live trades, no gate_score) fails and David approves.
    v_gate := case when p_thesis_id is not null then th.status = 'hardening'
      and coalesce((th.results_basis ->> 'gate_score')::int, 0) >= 80 end;
    v_allowed := coalesce(v_gate, false) and not v_blocked and not v_no_inval and not v_stale and not v_exposure;
    v_reason := case
      when v_unknown then 'unknown_thesis'
      when v_rejected then 'thesis_rejected'
      when v_killed then 'thesis_killed'
      when v_paper then 'paper_only'
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
      when v_paper then 'paper_only'
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
      then 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk to invalidation <= 10% of book (pass p_entry_price); entries need an invalidation_price, a fresh book (<= 6h), and a hardening thesis with gate_score >= 80 (the results score shrunk toward 50 by 16 zero-mean trades; unscored = David approves); an unknown, rejected, killed or retired thesis blocks new entries'
      else 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk <= 10% of book with every open lot and the new entry at full notional (gap-prone: binaries at price x contracts, memes at cost basis); entries need an invalidation_price and a fresh book (<= 6h); an unknown, rejected, killed or retired thesis blocks new entries'
    end::text,
    case when v_no_inval then null else p_invalidation_price end,
    case when v_unknown or v_rejected or v_killed or v_paper then 0::numeric else ms.max_stake end,
    case when v_paper then 'paper_only' when v_unknown or v_rejected or v_killed then 'blocked thesis' else ms.reason end,
    ms.trades, ms.lcb, v_book_age,
    th.results_confidence, ex.open_risk, ex.risk_budget, ex.risk_headroom, round(v_frac, 6), ex.risk_basis;
end;
$$;

revoke all on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

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
         case when t.paper_only then 0::numeric else m.max_stake end,
         case s.steward when 'bandit' then 'SOL' else 'USD' end,
         m.trades, m.lcb,
         case when t.paper_only then 'paper_only' else m.reason end
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
  where t.status not in ('rejected', 'killed', 'retired')
    -- A signed-in caller must be a ledger operator (advisor 0029); worker roles,
    -- desk_public_reader and direct Postgres are unchanged.
    and (coalesce((select auth.role()), '') <> 'authenticated' or (select public.is_ledger_operator()));
$$;

revoke all on function public.thesis_max_stakes() from public, anon;
grant execute on function public.thesis_max_stakes()
  to authenticated, service_role, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader;

create or replace function private.backtest_evidence_derive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  v_f numeric;
  v_other boolean;
  v_pit text;
  v_parent bigint;
begin
  -- The linked strategy test (and its research cycle) is the record of what was tested, for which thesis,
  -- when the rules were locked and when results came in. Stewards can't back-date a lock or move a test.
  select st.status, st.tested_at, st.params_json, st.price_source, st.window_start, st.window_end,
         st.deflated_sharpe, rc.thesis_id as rc_thesis, rc.preregistered_at as rc_prereg,
         case when st.params_json ->> 'parent_test_id' ~ '^[0-9]+$' then (st.params_json ->> 'parent_test_id')::bigint end as parent_id
    into t
  from public.strategy_tests st
  left join public.research_cycles rc on rc.id = st.cycle_id
  where st.id = new.strategy_test_id;
  if not found then
    raise exception 'backtest evidence needs a strategy_tests row (strategy_test_id %)', new.strategy_test_id;
  end if;
  if tg_op = 'INSERT' and t.status not in ('survived', 'killed') then
    raise exception 'strategy test % is %, not completed', new.strategy_test_id, t.status;
  end if;
  v_other := coalesce(t.params_json ->> 'thesis_id', t.rc_thesis) is distinct from new.thesis_id;
  if tg_op = 'INSERT' and v_other then
    raise exception 'strategy test % belongs to thesis %, not %', new.strategy_test_id,
      coalesce(t.params_json ->> 'thesis_id', t.rc_thesis), new.thesis_id;
  end if;
  -- Point-in-time inputs marked unverified (e.g. estimate_point_in_time = unverified).
  select string_agg(e.key, ', ' order by e.key) into v_pit
  from jsonb_each_text(coalesce(t.params_json, '{}'::jsonb)) e
  where e.key ~ '(^|_)point_in_time$' and lower(coalesce(e.value, '')) <> 'true';
  -- A filtered subset of another test on the same thesis re-uses that test's events.
  select p.id into v_parent
  from public.strategy_tests p
  left join public.research_cycles pr on pr.id = p.cycle_id
  where p.id = t.parent_id and p.id <> new.strategy_test_id
    and coalesce(p.params_json ->> 'thesis_id', pr.thesis_id) = new.thesis_id;
  if tg_op = 'INSERT' and v_pit is not null then
    raise exception 'strategy test % has unverified point-in-time inputs (%): no evidence row', new.strategy_test_id, v_pit;
  end if;
  if tg_op = 'INSERT' and v_parent is not null then
    raise exception 'strategy test % is a subset of test % on the same thesis (events already counted there): no evidence row',
      new.strategy_test_id, v_parent;
  end if;
  if tg_op = 'INSERT' then
    new.rules_locked_at := coalesce((t.params_json ->> 'preregistered_at')::timestamptz, t.rc_prereg, new.rules_locked_at);
    new.results_at := coalesce(t.tested_at, new.results_at);
  end if;
  if t.params_json ? 'trial_number' then
    new.trials := greatest(coalesce(new.trials, 1), (t.params_json ->> 'trial_number')::int);
  end if;
  -- The thesis's trial count when the results came in: every non-placeholder test on its research cycles.
  new.thesis_trials := (
    select count(*)::int
    from public.strategy_tests s2
    join public.research_cycles r2 on r2.id = s2.cycle_id
    where r2.thesis_id = new.thesis_id and s2.status not in ('placeholder', 'retired') and s2.tested_at <= new.results_at);
  new.deflated_sharpe := t.deflated_sharpe;
  new.test_status := t.status;
  new.passed := t.status = 'survived';
  new.ineligible_reason := case
    when v_other then 'test belongs to another thesis'
    when t.status = 'retired' then 'retired: not a kill and not a survival; no backtest credit'
    when t.status not in ('survived', 'killed') then 'test ' || t.status
    when v_pit is not null then 'unverified: point-in-time inputs not verified (' || v_pit || ')'
    when v_parent is not null then format('subset of test %s (events already counted there)', v_parent)
    when t.price_source is null or t.window_start is null or t.window_end is null
      then 'unverified: no price source or date window'
    when new.rules_locked_at is null or new.results_at is null or new.rules_locked_at >= new.results_at
      then 'unverified: rules not locked before results'
    when t.deflated_sharpe is null then 'unverified: no deflated Sharpe'
    when new.trials < coalesce(new.thesis_trials, 1)
      then format('unverified: deflated at %s trials, thesis had run %s', new.trials, new.thesis_trials)
    when not new.out_of_sample then 'not out of sample'
    when not new.costs_included then 'costs not included'
    when not new.active then 'inactive'
  end;
  new.verified := new.ineligible_reason is null;
  v_f := case when new.survivors_only then 1 - coalesce(new.missing_share, 0.5) else 1 end;
  new.weight := round(least(0.5 * new.n_trades, 5) * v_f, 4);
  new.mean_ret_deflated := round(t.deflated_sharpe::numeric * new.sd_ret, 8);
  new.trial_deflation := round(new.mean_ret - new.mean_ret_deflated, 8);
  return new;
end;
$$;

update public.desk_rules
   set mechanism = mechanism || ' A retired thesis blocks new entries the same way a killed thesis does.',
       updated_at = now()
 where rule_id = 'thesis-status-blocks'
   and mechanism not like '%retired thesis blocks new entries%';

update public.strategy_tests
   set status = 'retired'
 where id in (5, 13, 14, 17, 18, 19, 21, 22, 23, 25, 26, 27, 28, 29, 33)
   and status = 'placeholder';

insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
select t.id, t.confidence, t.confidence,
  'Status retired. meme_flush_rebound was marked killed on 2026-10-21 because there was no retired status. Retired is terminal: new entries stay blocked the way a killed thesis is blocked, and a re-score will not move it back to forming or hardening.',
  now(),
  jsonb_build_object(
    'kind', 'status_retired',
    'prior_status', 'killed',
    'new_status', 'retired',
    'tagged_by', 'GRASSHOPPER'
  )
from public.theses t
where t.id = 'meme_flush_rebound' and t.status = 'killed';

update public.theses
   set status = 'retired', updated_at = now()
 where id = 'meme_flush_rebound' and status = 'killed';
