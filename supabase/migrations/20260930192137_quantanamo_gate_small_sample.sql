-- Court ruling 2026-09-30: the QUANTANAMO 80 gate no longer opens on a small sample
-- (docs/rules/quantanamo-80-gate.md).
-- court-ruling: docs/rules/quantanamo-80-gate.md
-- court-ruling: docs/rules/outcome-rescore-confidence.md
--
-- The shown results score is unchanged: it is still P(expected return per trade > 0), and only the
-- re-score job writes it. The gate was reading that score directly, so a zero-edge thesis opened it at
-- some point before 10 live trades on 31% of paths (earnings_gap_structure scored 92 after 3 trades).
-- Now the gate reads gate_score = round(100 x Phi(z x sqrt(n_live / (n_live + 16)))), a neutral prior of
-- 16 zero-mean trades that fades as live trades accumulate. Backtest weight counts in z and not in the
-- prior, so logging tests can't spend the prior down. No fixed minimum trade count, no position cap,
-- and sizing is untouched.
-- Chosen by Monte Carlo (tools/court/gate80.py, 4,000 paths) over a fixed lower bound and a streak rule:
-- false opens before 10 live trades 31% -> 8.5%; a real edge still gets there (median trades to open,
-- Sharpe 0.2: 9 -> 21, Sharpe 0.4: 6 -> 12). A lower bound tight enough to hit 10% left a Sharpe-0.2
-- thesis unautonomous past 80 trades a third of the time. Requiring four scores in a row landed at 10.7%.

-- Return type gains gate_score, so the function has to be dropped before it is recreated.
drop function private.thesis_results_score(text);

create or replace function private.thesis_results_score(p_thesis_id text)
returns table (score smallint, n_live integer, bt_weight numeric, n_eff numeric, mean_eff numeric,
               sd_eff numeric, z numeric, ucb numeric, demote boolean, kill boolean, gate_score smallint)
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
  v_sd numeric;
  v_z numeric;
  v_ucb numeric;
  v_gate_z numeric;
begin
  select * into st from private.stake_edge_stats(null, p_thesis_id);
  v_n := coalesce(st.n, 0);
  select * into bt from private.thesis_edge_evidence(p_thesis_id, v_n::int);
  v_w := coalesce(bt.weight, 0);
  v_neff := v_n + v_w;
  if v_neff > 0 then
    v_mean := (v_n * coalesce(st.mean_ret, 0) + v_w * coalesce(bt.mean_ret, 0)) / v_neff;
  end if;
  v_sd := greatest(coalesce(st.sd_ret, 0), 0.25);
  -- Scored only with >= 3 live trades; backtest credit can't score a thesis on its own.
  if v_n >= 3 then
    v_z := v_mean / (v_sd / sqrt(v_neff));
    -- Gate only (quantanamo-80-gate): shrink z toward a neutral prior of 16 zero-mean trades.
    -- The prior fades with LIVE trades. Backtest weight is already in v_z and must not spend the prior down.
    v_gate_z := v_z * sqrt(v_n / (v_n + 16));
  end if;
  if v_n >= 2 then
    v_ucb := st.mean_ret + v_sd / sqrt(v_n);
  end if;
  return query select
    case when v_z is not null then round(100 * private.normal_cdf(v_z))::smallint end,
    v_n::int, v_w, v_neff, round(v_mean, 6), round(v_sd, 6), round(v_z, 4), round(v_ucb, 6),
    coalesce(v_ucb < 0, false) or (v_n >= 10 and coalesce(st.mean_ret, 0) < 0),
    v_n >= 10 and coalesce(v_ucb < 0, false),
    case when v_gate_z is not null then round(100 * private.normal_cdf(v_gate_z))::smallint end;
end;
$$;


comment on function private.thesis_results_score(text) is
  'Results score: scored only with >= 3 live trades. n_eff = live trades + backtest weight; mean_eff pools the live mean with the deflated-Sharpe x spread backtest mean; sd_eff = max(live sd, 0.25); score = round(100 x Phi(mean_eff / (sd_eff / sqrt(n_eff)))). gate_score (the QUANTANAMO 80 gate, not the shown score) = round(100 x Phi(z x sqrt(n_live / (n_live + 16)))): the same evidence shrunk toward a neutral prior of 16 zero-mean trades, fading with live trades. demote/kill unchanged, live only.';


revoke all on function private.thesis_results_score(text) from public, anon, authenticated;

-- The re-score job is the only writer of the score and of gate_score (the results guard already rejects
-- any other writer of these columns).
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
    -- The gate reads the prior-shrunk gate_score, not the shown results score (quantanamo-80-gate).
    -- An unscored thesis (< 3 live trades, no gate_score) fails and David approves.
    v_gate := case when p_thesis_id is not null then th.status = 'hardening'
      and coalesce((th.results_basis ->> 'gate_score')::int, 0) >= 80 end;
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
      then 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk to invalidation <= 10% of book (pass p_entry_price); entries need an invalidation_price, a fresh book (<= 6h), and a hardening thesis with gate_score >= 80 (the results score shrunk toward 50 by 16 zero-mean trades; unscored = David approves); an unknown, rejected or killed thesis blocks new entries'
      else 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk <= 10% of book with every open lot and the new entry at full notional (gap-prone: binaries at price x contracts, memes at cost basis); entries need an invalidation_price and a fresh book (<= 6h); an unknown, rejected or killed thesis blocks new entries'
    end::text,
    case when v_no_inval then null else p_invalidation_price end,
    case when v_unknown or v_rejected or v_killed then 0::numeric else ms.max_stake end,
    case when v_unknown or v_rejected or v_killed then 'blocked thesis' else ms.reason end,
    ms.trades, ms.lcb, v_book_age,
    th.results_confidence, ex.open_risk, ex.risk_budget, ex.risk_headroom, round(v_frac, 6), ex.risk_basis;
end;
$$;


-- Re-score every thesis so results_basis.gate_score exists before guidance reads it. Scores that don't
-- move write no belief_updates row.
select private.rescore_all_thesis_confidence();

-- ---------------------------------------------------------------- registry
insert into public.desk_rules (rule_id, title, purpose, mechanism, owner_paths, status, verdict, ruling_summary, growth_cost, ruin_risk_reduction, statistics_note, gaming_analysis, interactions, needs_david, ruling_file, ruling_date, next_review_date) values
  ('outcome-rescore-confidence', 'Results re-score of thesis confidence (expected return per trade)', 'Tempers a steward''s stated confidence with realized outcomes. Feeds the QUANTANAMO >= 80 gate and hardening/forming status.', '`private.thesis_results_score`: scored only with >= 3 live trades (else null, unscored). n_eff = live trades + the backtest weight (backtest-evidence-credit: verified tests, pass or fail, none below 3 live trades, then min(sum 0.5 x n, 5, live / 2) x survivor factor); mean_eff pools the live mean return on stake with the backtest deflated Sharpe x spread; sd_eff = max(live sd, 0.25); results_confidence = round(100 x Phi(mean_eff / (sd_eff / sqrt(n_eff)))). Demote hardening -> forming only when the live upper bound mean + max(sd, 0.25)/sqrt(n) < 0, or n >= 10 with mean < 0; kill only when n >= 10 and the upper bound < 0 (live only). theses.confidence (display) = results_confidence when scored, else the stated number. Only the re-score writes the results columns (guard trigger). The QUANTANAMO 80 gate does not read this score directly: it reads gate_score, the same z shrunk by sqrt(n_live / (n_live + 16)) (quantanamo-80-gate, migration 48). Was: Beta on hit rate, cap 60 and demote at n >= 5 with negative P/L.', array['supabase/schemas/11_outcome_rescore_sizing.sql', 'supabase/schemas/41_court_decisions.sql', 'supabase/schemas/47_backtest_credit_live_gated.sql', 'supabase/schemas/48_quantanamo_gate_small_sample.sql']::text[], 'in_force', 'amend', 'Amend (shipped in migration 41; decided 2026-09-26 by the parent agent under David''s delegation). Status changes on the 2026-09-26 re-run: none (no thesis has a negative upper bound or n >= 10). Amendment: Score on expected return per trade (above). Stated confidence is display only.', 'Removes the permanent block on asymmetric theses.', 'Demotion/kill now needs real evidence of negative edge.', 'Five trades can''t tell a Sharpe-0.1 thesis from zero: P(sum < 0) = Phi(-0.1 sqrt 5) = 41%. A hit-rate Beta prior ignores payoff asymmetry.', 'Pushes a steward toward high-hit-rate, low-payoff trades (take profits early, let losers run) just to keep confidence high: the opposite of what compounds.', 'quantanamo-80-gate, edge-max-stake, backtest-evidence-credit.', false, 'docs/rules/outcome-rescore-confidence.md', '2026-09-26'::date, '2026-10-26'::date),
  ('quantanamo-80-gate', 'QUANTANAMO autonomous-entry gate: hardening thesis with results score >= 80', 'David approves anything below 80; autonomy only for strong theses.', '`steward_sizing_guidance`: QUANTANAMO entry_allowed needs status = hardening and `results_basis.gate_score` >= 80 (reason `quantanamo_unscored` when unscored, else `quantanamo_confidence_gate`). gate_score = round(100 x Phi(z x sqrt(n_live / (n_live + 16)))), where z is the results-score z (outcome-rescore-confidence). A neutral prior of 16 zero-mean trades: at 3 live trades the gate needs a raw score near 98, at 40 trades near 84, and it fades toward the raw 80. The shown results_confidence is unchanged, and only the re-score writes either number. Backtests count in z but not in the prior, and still can''t open the gate alone: no score below 3 live trades (migration 47).', array['supabase/schemas/22_edge_scaled_stake.sql', 'supabase/schemas/41_court_decisions.sql', 'supabase/schemas/48_quantanamo_gate_small_sample.sql', 'docs/scheduled-run-prompt.md']::text[], 'in_force', 'amend', 'Amend (2026-09-30, migration 48): the 80 threshold stays, but the gate reads a small-sample-shrunk score, not the shown results score. False opens before 10 live trades 31% -> 8.5%, and a real edge still reaches autonomy near when its expected evidence would have cleared 80 (Sharpe 0.2 median 21 live trades, Sharpe 0.4 median 12). No live score moves and no thesis opens the gate. Was (migration 41): gate on the raw results score, which a zero-edge thesis cleared on luck with 3-9 trades. Amendment: private.thesis_results_score gains gate_score = round(100 x Phi(z x sqrt(n_live / (n_live + 16)))). The re-score stores it on results_basis (gate_score, gate_prior 16) and still writes results_confidence as the unshrunk score. steward_sizing_guidance opens the QUANTANAMO gate on status = hardening and gate_score >= 80. Shown scores are not rewritten except to add the new basis keys.', 'None on the book: the gate does not size the bet, so P(2x) is unchanged (Sharpe 0.2: 54.1%, median 1.87x; Sharpe 0.4: 99.5%, median 53.9x). Autonomy is later, not smaller: median trades to open 9 -> 21 at Sharpe 0.2 and 6 -> 12 at Sharpe 0.4.', 'False opens before 10 live trades 31.0% -> 8.5% (inside the 10% target). Book ruin stays 0, since size is unchanged.', 'The shown score stays P(expected return per trade > 0) >= 0.8 (z >= 0.84). Reading it straight made a small sample look sure: with the spread floored at 0.25, three lucky trades clear z = 0.84 far too often, and the gate is re-checked after every trade, so the chance it has opened at some point before 10 live trades is 31% at zero edge (4,000 paths; earnings_gap_structure itself scored 92 after 3 trades with no backtest). The gate now uses z x sqrt(n_live / (n_live + 16)), the posterior z under a normal prior of 16 zero-mean trades with the same spread. That is not a fixed rail: the bar falls toward 80 as live trades accumulate (about 98 at n = 3, 84 at n = 40, 82 at n = 100). A fixed lower bound (z - 0.84, gate only) also got under 10% false opens but left a Sharpe-0.2 thesis unautonomous past 80 trades 36% of the time. Requiring the raw score to hold for 4 re-scores in a row landed at 10.7%.', 'Stated confidence still can''t open the gate, and neither can the shown score on its own. gate_score is written only by the re-score, into results_basis, which the results guard already protects. Logging backtests can''t spend the prior down: the fade uses n_live, while backtest weight only enters z, and a fake +0.2 Sharpe backtest cuts false opens further (26.9% -> 5.8%) rather than reopening the hole. There is no minimum trade count to wait out and no cap to route around.', 'outcome-rescore-confidence, new-thesis-escape, backtest-evidence-credit.', false, 'docs/rules/quantanamo-80-gate.md', '2026-09-26'::date, '2026-11-30'::date),
  ('backtest-evidence-credit', 'Out-of-sample backtest evidence counts both ways, as a small correction to live results', 'Lets real out-of-sample evidence move a thesis''s score and proof a little either way, pass or fail, without letting backtests stand in for live trades or rewarding a steward for logging only winners.', '`public.thesis_backtest_evidence`, append-only for stewards, one row per (thesis, test). A trigger copies from the linked `strategy_tests` row and its research cycle: rules_locked_at (preregistered_at), results_at (tested_at), deflated_sharpe, test_status, thesis_trials (non-placeholder tests the thesis had run by then), and sets verified / ineligible_reason. A row is verified when its test is survived or killed (placeholder, lookahead_invalid, queued and unverified earn nothing), has a price source and a date window, rules_locked_at < results_at, a stored deflated Sharpe, trials >= thesis_trials, out_of_sample and costs_included. A change to the test row re-derives it. A test whose params mark point-in-time data unverified (any `*point_in_time` key not ''true'', e.g. test 32''s estimate_point_in_time = unverified), or that is a filtered subset of another test on the same thesis (`parent_test_id`, e.g. test 32 of test 31), gets no row at all: the insert is refused. `private.thesis_edge_evidence(thesis, n_live)` gives no credit below 3 live trades; otherwise weight = min(sum 0.5 x n, 5, n_live / 2) x the pooled survivor factor (1 - missing_share for a survivors-only test, 0.5 if unknown) and credited mean = deflated Sharpe x spread, pooled by 0.5 x n x factor, pass or fail. `private.edge_max_stake` and `private.thesis_results_score` add it to the live trades with no further shrink; the spread stays the live spread. `v_thesis_backtest_evidence` lists every row (verified, why not, for/against); `v_backtest_tests_unlogged` lists completed thesis tests (thesis named in the test params) with no row, leaving out the point-in-time-unverified and subset tests; `v_thesis_scorecard` shows the weight the re-score applied.', array['supabase/schemas/37_court_rulings.sql', 'supabase/schemas/46_backtest_evidence_symmetric.sql', 'supabase/schemas/47_backtest_credit_live_gated.sql']::text[], 'in_force', 'amend', 'Amend (2026-09-27, migration 47, following 46): pass or fail still counts, but backtest credit is live-gated and small. No credit or score below 3 live trades; weight min(5, live / 2) x (1 - missing share) for survivors-only; credited mean = deflated Sharpe x spread; unverified tests earn nothing. 47 re-derives test 31, logs test 30, leaves test 32 out (point-in-time unverified, and a subset of test 31), and re-scores: earnings_gap_structure 52 -> 54 (56 before 46); no other score moves. Was (46): up to 20 effective trades from before the first live trade, emax-deflated mean shrunk 50%; (37): survivors only. Amendment: thesis_backtest_evidence gains test_status, thesis_trials, verified, ineligible_reason (trigger-derived); weight = min(0.5 x n, 5) x survivor factor; mean_ret_deflated = deflated Sharpe x sd. private.thesis_edge_evidence(text) is replaced by (text, integer) with the live gate and cap; edge_max_stake and thesis_results_score drop the 50% shrink and use the live spread; the score needs >= 3 live trades. A strategy_tests update (including params_json) re-derives its evidence. Point-in-time-unverified tests and filtered subsets of another test on the same thesis get no row (the insert is refused; v_backtest_tests_unlogged leaves them out). v_thesis_backtest_evidence stops reading strategy_tests; 46''s strategy_tests read grant to oddsborne_worker / bandit_worker stays (v_backtest_tests_unlogged still reads strategy_tests as the invoker).', 'Close to none: QUANTANAMO Sharpe-0.2 P(2x) 53.7% vs 55.0% with no backtests (46: 48.5%); with a real live edge and a no-edge backtest, 51.2% vs 46''s 41.5%.', 'Neutral: ruin 0 in every cell; gives back part of 46''s cut in zero-edge false proofs (QUANTANAMO 29.6% -> 41.2%, no backtests 47.5%) in exchange for not letting backtests outweigh live trades.', 'Every completed, preregistered test counts whichever way it came out, so logging only winners buys nothing. The credited mean is the deflated Sharpe times the spread: the mean left after subtracting what the best of the thesis''s N tries would show by luck (test 31: -0.1228 x 6.20% = -0.76% per trade, vs its raw -0.35%). Deflation already corrects selection, so there''s no extra 50% shrink, and it treats a pass and a fail the same way. The weight is capped because a backtest of a mechanical rule isn''t the thesis as traded (test 31 skips the discretionary selection the live book does), survivors-only samples are biased, and correlated same-night events overstate n: 714 trades count as at most 5 effective trades, and never more than half the live count. The backtest spread (6.2%) never narrows the live spread (floored at 0.25). Subsets aren''t new evidence: test 32 re-used test 31''s 714 events filtered to 249 serial EPS beaters, so logging it would count those 249 trades twice and would let a steward pile up weight by slicing one sample. A test with a parent_test_id on the same thesis counts as a trial (it raises the thesis''s trial count, which deflates later tests), never as another row. Overlap that isn''t declared (a DJIA name can sit in both test 30 and test 31, under different exit rules) is bounded by the pooled cap of 5. The small-sample hole this note flagged (the raw score opens the 80 gate at some point on 31% of zero-edge paths, and earnings_gap_structure scored 92 after 3 trades with no backtest) is closed by quantanamo-80-gate, migration 48: the gate reads a score shrunk toward 50 by 16 zero-mean trades, and the shown score is unchanged. Backtest credit was the wrong tool for it.', 'Can''t be gamed for more than a nudge. With a fake +0.2 Sharpe backtest on a zero-edge thesis, false proofs are 47.7% vs 47.5% with no backtest (QUANTANAMO) and 62.3% vs 61.3% (BANDIT), and the 80 gate opens less often, not more (26.6% vs 31.2%), because every test is deflated by the thesis''s trial count. Backtests alone can''t score a thesis or open the gate: no credit and no score below 3 live trades. Lock time, results time, deflated Sharpe, test status and the thesis''s trial count come from the test record, not the steward. Under-counting trials, skipping preregistration, a missing source or window, or a voided test (lookahead_invalid, placeholder) all make a row unverified and worth zero. A disputed point-in-time input gets no row at all (test 32''s EPS estimates have no as-of timestamp), and slicing one sample into filtered subsets buys nothing (a parent_test_id on the same thesis is refused). Logging many tests doesn''t add up: the pooled weight is capped at 5. Rows are append-only for stewards, and `v_backtest_tests_unlogged` shows any completed thesis test that should have been logged and wasn''t.', 'edge-max-stake, outcome-rescore-confidence, quantanamo-80-gate.', false, 'docs/rules/backtest-evidence-credit.md', '2026-09-27'::date, '2026-11-27'::date)
on conflict (rule_id) do update set title = excluded.title, purpose = excluded.purpose, mechanism = excluded.mechanism, owner_paths = excluded.owner_paths, status = excluded.status, verdict = excluded.verdict, ruling_summary = excluded.ruling_summary, growth_cost = excluded.growth_cost, ruin_risk_reduction = excluded.ruin_risk_reduction, statistics_note = excluded.statistics_note, gaming_analysis = excluded.gaming_analysis, interactions = excluded.interactions, needs_david = excluded.needs_david, ruling_file = excluded.ruling_file, ruling_date = excluded.ruling_date, next_review_date = excluded.next_review_date, updated_at = now();
