-- PR 6: (1) a 'killed' thesis blocks new entries for every steward, like 'rejected'
-- (entry_allowed = false, sized_notional = 0, entry_blocked_reason = 'thesis_killed');
-- (2) "Kill the old rules!" (David, 2026-09-26): the fixed trading rails leave risk_controls.
-- Kept: results-driven sizing, the QUANTANAMO >= 80 gate, rejected/killed blocks, mechanical
-- cash / no-margin / valid-quantity / fresh-quote / session-open checks, the PLTR blacklist,
-- and the protective hard-loss exit and portfolio-drawdown controls.
drop function if exists public.steward_sizing_guidance(text, text, text, numeric);

create or replace function public.steward_sizing_guidance(
  p_steward text, p_thesis_id text default null, p_instrument text default null, p_requested numeric default null
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
  sizing text
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
  th public.theses%rowtype;
  v_basis text;
  v_mult numeric;
  v_gate_applies boolean := p_steward = 'quantanamo';
  v_rejected boolean;
  v_killed boolean;
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
    select * into st from private.thesis_outcome_stats(p_thesis_id);
    v_basis := case when coalesce(st.n, 0) < 5 then 'thesis_thin_default' else 'thesis_half_kelly' end;
  else
    select * into st from private.steward_outcome_stats(p_steward);
    v_basis := case when coalesce(st.n, 0) < 5 then 'steward_thin_default' else 'steward_half_kelly' end;
  end if;
  v_mult := private.half_kelly_multiplier(st.n, st.wins, st.avg_win, st.avg_loss);

  v_rejected := coalesce(th.status = 'rejected', false);
  v_killed := coalesce(th.status = 'killed', false);
  v_blocked := v_rejected or v_killed;
  if v_gate_applies then
    v_gate := case when p_thesis_id is not null then th.status = 'hardening' and coalesce(th.confidence, 0) >= 80 end;
    v_allowed := coalesce(v_gate, false);
    v_reason := case
      when v_rejected then 'thesis_rejected'
      when v_killed then 'thesis_killed'
      when p_thesis_id is null then 'quantanamo_requires_thesis'
      when not coalesce(v_gate, false) then 'quantanamo_confidence_gate'
    end;
  else
    v_gate := not v_blocked;
    v_allowed := not v_blocked;
    v_reason := case when v_rejected then 'thesis_rejected' when v_killed then 'thesis_killed' end;
  end if;

  return query select
    p_steward, p_thesis_id, p_instrument, coalesce(eq.unit, case when p_steward = 'bandit' then 'SOL' else 'USD' end),
    eq.equity, eq.observed_at, eq.source,
    greatest(ca.cash, 0), private.steward_position_value(p_steward, p_instrument),
    p_requested, v_mult, v_basis,
    case
      when p_requested is null then null
      when v_blocked then 0::numeric
      else round(least(p_requested * v_mult, greatest(coalesce(ca.cash, 0), 0)), 6)
    end,
    coalesce(st.n, 0), coalesce(st.wins, 0),
    case when st.n > 0 then round(st.wins::numeric / st.n, 4) end,
    st.avg_win, st.avg_loss,
    private.half_kelly_fraction(st.n, st.wins, st.avg_win, st.avg_loss),
    th.confidence, th.stated_confidence, th.status,
    v_gate_applies, v_gate, v_rejected, v_killed, v_allowed, v_reason,
    case when v_gate_applies
      then 'size = requested x multiplier, limited only by spendable cash (no margin); autonomous equity entries need a hardening thesis at confidence >= 80; a rejected or killed thesis blocks new entries; no per-position cap'
      else 'size = requested x multiplier, limited only by spendable cash (no margin); the multiplier is the throttle (no confidence gate); a rejected or killed thesis blocks new entries; no per-position cap'
    end::text;
end;
$$;

revoke all on function public.steward_sizing_guidance(text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text, numeric)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

update public.risk_controls
set threshold_json = (threshold_json - 'window_start' - 'window_end' - 'window_timezone' - 'max_spread_bps' - 'max_trades_per_day')
      || jsonb_build_object(
        'mechanical', 'spendable cash (no margin), valid quantity, fresh uncrossed quote, US regular session open',
        'guidance_not_blocks', 'wide spreads and the first/last 15 minutes of the session'),
    updated_at = now()
where control_key = 'autonomous-execution';

update public.risk_controls
set threshold_json = (threshold_json - 'max_adds_per_day' - 'max_adds_lifetime' - 'minimum_hours_between_adds'
        - 'max_add_percent_per_review' - 'reduce_percent_min' - 'reduce_percent_max'
        - 'max_reductions_per_day' - 'allow_averaging_down')
      || jsonb_build_object(
        'add_sizing', 'requested % of NAV x thesis outcome multiplier, spendable cash only',
        'reduce_sizing', 'model-requested partial %, no fixed band'),
    updated_at = now()
where control_key = 'autonomous-position-management';

update public.risk_controls
set status = 'retired',
    threshold_json = jsonb_build_object(
      'retired', '2026-09-26 David: Kill the old rules! Spread is guidance, not a block',
      'replaced_by', 'the gateway checks for a fresh, uncrossed quote only'),
    updated_at = now()
where control_key = 'event-liquidity';
