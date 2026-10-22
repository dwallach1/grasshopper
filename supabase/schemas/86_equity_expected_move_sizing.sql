-- Size a print-held equity starter on the wider of the exit line and the expected move.
-- court-ruling: docs/rules/portfolio-exposure.md
--
-- Open risk already counts max(line distance, implied move) until the report is out.
-- Guidance sized from the line only, so a starter held through the print could lose
-- more than the starter risk the line was written for (lesson 146, ROL: 16 shares
-- at $33.05, line $31.06 = 6.021% below, straddle 9.4%).
--
-- p_expected_move is that same fraction (straddle / underlying; 0.094 = a 9.4% move).
-- When it is wider than the line, notional shrinks by line/move so the expected-move
-- loss equals the dollar risk the old (line) size would have taken. Gates, the
-- results multiplier, the 80 score, and the absence of a hard percent-of-book cap
-- are unchanged. The move never blocks an entry. Size is zero only when the shrunk
-- notional is under $1 (below_minimum), with a plain-language size_note.
-- A null move, a non-positive move, or a move no wider than the line leaves the
-- old notional exactly as it was. Full-notional books ignore the argument.
--
-- Declarative copy: supabase/schemas/86_equity_expected_move_sizing.sql.
-- Apply after 20261021180000_retired_strategy_tests_theses.

drop function if exists public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric);

create function public.steward_sizing_guidance(
  p_steward text,
  p_thesis_id text default null,
  p_instrument text default null,
  p_requested numeric default null,
  p_invalidation_price numeric default null,
  p_entry_price numeric default null,
  p_expected_move numeric default null
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
  risk_basis text,
  risk_distance text,
  expected_move numeric,
  size_note text
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
  v_line_frac numeric;
  v_move numeric;
  v_risk_frac numeric;
  v_govern text;
  v_base numeric;
  v_old numeric;
  v_sized numeric;
  v_note text;
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
    v_unknown := th.id is null;
    select * into st from private.thesis_outcome_stats(p_thesis_id);
  else
    select * into st from private.steward_outcome_stats(p_steward);
  end if;
  select * into ms from private.edge_max_stake(p_steward, p_thesis_id, eq.equity);
  select * into ex from private.steward_open_risk(p_steward);

  -- Line fraction, same as before. Full-notional books count the whole position.
  -- Equities use (entry - invalidation) / entry; without a usable line, 1.
  v_line_frac := case
    when ex.risk_basis = 'full_notional' then 1
    when p_entry_price > 0 and p_invalidation_price > 0 and p_invalidation_price < p_entry_price
      then (p_entry_price - p_invalidation_price) / p_entry_price
    else 1 end;
  -- Expected move is a fraction of price, the same unit as straddle / underlying.
  -- Ignored on a full-notional book (the whole position is already the risk) and
  -- when it is missing or not positive. It never raises.
  v_move := case
    when ex.risk_basis = 'full_notional' then null
    when p_expected_move > 0 then p_expected_move
    else null end;
  v_risk_frac := case when v_move is null then v_line_frac else greatest(v_line_frac, v_move) end;
  v_govern := case
    when v_move is not null and v_move > v_line_frac then 'expected_move'
    when ex.risk_basis is distinct from 'full_notional'
      and p_entry_price > 0 and p_invalidation_price > 0 and p_invalidation_price < p_entry_price
      then 'line'
    else null end;

  -- Old notional: min(requested, max stake, cash, headroom / line fraction).
  -- When the expected move is wider, shrink so move loss = that notional's line risk.
  v_base := least(
    coalesce(p_requested, 0),
    coalesce(ms.max_stake, 0),
    greatest(coalesce(ca.cash, 0), 0));
  v_old := least(v_base, greatest(coalesce(ex.risk_headroom, 0), 0) / v_line_frac);
  v_sized := case
    when p_requested is null then null
    when v_govern = 'expected_move' then v_old * v_line_frac / v_move
    else v_old end;
  v_exposure := coalesce(ex.risk_headroom, 0) <= 0;

  if ca.observed_at is not null and eq.observed_at is not null then
    v_book_age := floor(extract(epoch from (now() - least(ca.observed_at, eq.observed_at))) / 60);
  end if;
  v_stale := v_book_age is null or v_book_age > 360;

  v_rejected := coalesce(th.status = 'rejected', false);
  v_killed := coalesce(th.status in ('killed', 'retired'), false);
  v_paper := coalesce(th.paper_only, false);
  v_blocked := v_rejected or v_killed or v_unknown or v_paper;
  if v_gate_applies then
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

  v_note := null;
  if v_allowed and v_govern = 'expected_move' and v_sized is not null
     and round(v_old, 6) >= 1 and round(v_sized, 6) < 1
     and coalesce(eq.unit, case when p_steward = 'bandit' then 'SOL' else 'USD' end) = 'USD' then
    v_allowed := false;
    v_reason := 'below_minimum';
    v_note := 'The earnings move leaves less than $1. That is below the minimum, so the size is zero.';
    v_sized := 0;
  elsif v_allowed and v_govern = 'expected_move' and v_sized is not null then
    v_note := format(
      'Sized for a %s%% earnings move, not the %s%% line.',
      pg_catalog.to_char(pg_catalog.round(v_move * 100, 1), 'FM999990.0'),
      pg_catalog.to_char(pg_catalog.round(v_line_frac * 100, 1), 'FM999990.0'));
  end if;

  return query select
    p_steward, p_thesis_id, p_instrument, coalesce(eq.unit, case when p_steward = 'bandit' then 'SOL' else 'USD' end),
    eq.equity, eq.observed_at, eq.source,
    greatest(ca.cash, 0), private.steward_position_value(p_steward, p_instrument),
    p_requested,
    case
      when v_unknown then 0::numeric
      when p_requested is null then null
      when not v_allowed then 0::numeric
      else round(v_sized, 6)
    end,
    coalesce(st.n, 0), coalesce(st.wins, 0),
    case when st.n > 0 then round(st.wins::numeric / st.n, 4) end,
    st.avg_win, st.avg_loss,
    th.confidence, th.stated_confidence, th.status,
    v_gate_applies, v_gate, v_rejected, v_killed, v_allowed, v_reason,
    case when v_gate_applies
      then 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk to invalidation <= 10% of book (pass p_entry_price); a wider p_expected_move shrinks the notional so that loss fits the same starter risk (risk_distance expected_move) and does not block, except below $1 (below_minimum); entries need an invalidation_price, a fresh book (<= 6h), and a hardening thesis with gate_score >= 80 (the results score shrunk toward 50 by 16 zero-mean trades; unscored = David approves); an unknown, rejected, killed or retired thesis blocks new entries'
      else 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk <= 10% of book with every open lot and the new entry at full notional (gap-prone: binaries at price x contracts, memes at cost basis); p_expected_move is ignored on a full-notional book; entries need an invalidation_price and a fresh book (<= 6h); an unknown, rejected, killed or retired thesis blocks new entries'
    end::text,
    case when v_no_inval then null else p_invalidation_price end,
    case when v_unknown or v_rejected or v_killed or v_paper then 0::numeric else ms.max_stake end,
    case when v_paper then 'paper_only' when v_unknown or v_rejected or v_killed then 'blocked thesis' else ms.reason end,
    ms.trades, ms.lcb, v_book_age,
    th.results_confidence, ex.open_risk, ex.risk_budget, ex.risk_headroom, round(v_risk_frac, 6), ex.risk_basis,
    v_govern,
    case when v_move is not null then round(v_move, 6) end,
    v_note;
end;
$$;

comment on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric, numeric) is
  'Size a new entry. Optional p_expected_move is a fraction of price (straddle/underlying). When it is wider than the exit line, risk per share is that move and the notional shrinks so the loss fits the line-sized starter risk. Returns risk_distance line or expected_move. Under $1 returns sized_notional 0, entry_blocked_reason below_minimum, and a plain size_note. Does not block otherwise. Null move leaves the old size.';

revoke all on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text, numeric, numeric, numeric, numeric)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- jsonb path used by the HTTPS stewards. Absent expected_move stays null.
create or replace function public.steward_entry_guidance(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_steward text := p->>'steward';
  r jsonb;
begin
  if current_user like '%\_worker' and current_user::text <> coalesce(v_steward, '') || '_worker' then
    raise exception 'refusal:auth: % may not request guidance for steward %', current_user, v_steward
      using errcode = '42501';
  end if;
  select to_jsonb(g) into r
  from public.steward_sizing_guidance(
    v_steward,
    p->>'thesis_id',
    p->>'instrument',
    (p->>'requested')::numeric,
    (p->>'invalidation_price')::numeric,
    (p->>'entry_price')::numeric,
    (p->>'expected_move')::numeric
  ) g
  limit 1;
  return r;
end;
$$;

comment on function public.steward_entry_guidance(jsonb) is
  'jsonb wrapper over steward_sizing_guidance(steward, thesis_id, instrument, requested, invalidation_price, entry_price, expected_move). expected_move is optional: a fraction of price when the lot will be held through a print. Same gates; a worker can only ask for its own steward.';

revoke all on function public.steward_entry_guidance(jsonb) from public, anon, authenticated;
grant execute on function public.steward_entry_guidance(jsonb) to oddsborne_worker, bandit_worker, service_role;

update public.desk_rules
set mechanism = $mech$`private.open_risk_lots()` (per lot, `public.v_exposure_lots`) summed by `private.steward_open_risk` (`public.v_exposure_usage`), in the book unit, `risk_basis` per book. QUANTANAMO equities stay `to_invalidation` on the line. Until the earnings report is out, a lot's open risk is the max of that line distance and the implied-move risk (GRASSHOPPER 2026-10-19). Line distance is qty x max(mark - invalidation_price, 0) (no invalidation: qty x mark; unmarked: 0, flagged). Implied-move risk is (ATM straddle price at the nearest expiry on or after the report date / underlying price) x position market value (qty x mark). The steward stores the report date, the straddle, the underlying and the expiry it used on `public.equity_implied_moves` (Robinhood earnings calendar and option quotes; a name without weeklies keeps that later expiry, no correction). Once the report has passed (an actual EPS, or 09:30 America/New_York on an am date, 20:00 on a pm date, or the next midnight when the source gives no am/pm), open risk is the line distance only. Missing straddle or option data uses the line distance and flags the lot `implied_move_missing`. No price is fabricated. ODDSBORNE binaries and BANDIT memes `full_notional`: every open binary at price x contracts (mark, else average cost) and every meme lot at its full cost basis (qty x average cost, else qty x mark). Budget 10% of book. Guidance sizes a new entry to fit: min(requested, max_stake, cash, headroom / risk fraction), where the fraction is 1 for full_notional books and (entry - invalidation) / entry for equities (1 without p_entry_price); no headroom -> `exposure_cap`. Guidance, v_exposure_usage and the v_ledger_watchdog `exposure` summary carry `risk_basis`. A new equity entry held through a scheduled print passes `p_expected_move`, that same straddle/underlying fraction (0.094 means a 9.4% move). Risk per share is the larger of the line distance and that move, and the notional shrinks so the expected-move loss equals the starter risk the line would have taken. It does not block the trade. The size is zero only when the result is under $1 (`below_minimum`, with a plain-language note). Guidance returns `risk_distance` (`line` or `expected_move`). No expected move, or a move no wider than the line, sizes exactly as before.$mech$,
    owner_paths = array[
      'supabase/schemas/41_court_decisions.sql',
      'supabase/schemas/44_exposure_gap_full_notional.sql',
      'supabase/schemas/80_equity_implied_move_risk.sql',
      'supabase/schemas/82_equity_earnings_score.sql',
      'supabase/schemas/86_equity_expected_move_sizing.sql',
      'stewards/quantanamo/earnings_implied.py',
      'stewards/quantanamo/steward_rpc.py'
    ]::text[],
    updated_at = now()
where rule_id = 'portfolio-exposure';
