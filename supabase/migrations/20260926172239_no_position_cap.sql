-- PR 4: size follows results with no hard cap per position (David, 2026-09-26).
-- Reverses the 20%-of-book single-position cap from 11_outcome_rescore_sizing.sql.
-- Kept unchanged: outcome re-scoring, thesis/steward half-Kelly multipliers (0.5 while
-- n < 5, 0.25 with no edge), demotions, and the QUANTANAMO < 80 confidence gate.

-- The 20 in the multiplier is only a scale: a half-Kelly fraction of 20% of book maps to
-- multiplier 1.0. It does not limit order or position size.
comment on function private.half_kelly_multiplier(integer, integer, numeric, numeric, numeric) is
  'clamp((half-Kelly fraction) / (p_cap_pct/100), 0.25, 1.0); 0.5 when n < 5; 0.25 with no edge. p_cap_pct (default 20) is a Kelly scale reference, not a position or order cap.';

-- Cash that can fund a buy without margin, per steward, from the latest ledger snapshot.
create or replace function private.steward_spendable_cash(p_steward text)
returns table (cash numeric, observed_at timestamptz, source text)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_steward = 'quantanamo' then
    return query
    select least(coalesce(s.cash, s.buying_power), coalesce(s.buying_power, s.cash)), s.observed_at,
      'account_snapshots: min(cash, buying_power)'::text
    from public.account_snapshots s
    where s.account_label ~* '7638' and s.total_value > 0
    order by s.observed_at desc limit 1;
  elsif p_steward = 'oddsborne' then
    return query
    select p.cash, p.as_of, 'pm_pnl.cash'::text
    from public.pm_pnl p
    where p.cash is not null
    order by p.as_of desc limit 1;
  elsif p_steward = 'bandit' then
    return query
    select p.cash_sol, p.as_of, 'meme_pnl.cash_sol'::text
    from public.meme_pnl p
    where p.cash_sol is not null
    order by p.as_of desc limit 1;
  end if;
end;
$$;

revoke all on function private.steward_spendable_cash(text) from public, anon, authenticated;

-- Results-driven sizing guidance for a NEW entry or an ADD. No cap field.
--   sized_notional = requested x multiplier, limited only by spendable cash (no margin).
drop function if exists public.steward_sizing_guidance(text, text, text);

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
  autonomous_buy_gate_pass boolean,
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
  return query select
    p_steward, p_thesis_id, p_instrument, coalesce(eq.unit, case when p_steward = 'bandit' then 'SOL' else 'USD' end),
    eq.equity, eq.observed_at, eq.source,
    greatest(ca.cash, 0), private.steward_position_value(p_steward, p_instrument),
    p_requested, v_mult, v_basis,
    case when p_requested is not null then round(least(p_requested * v_mult, greatest(coalesce(ca.cash, 0), 0)), 6) end,
    coalesce(st.n, 0), coalesce(st.wins, 0),
    case when st.n > 0 then round(st.wins::numeric / st.n, 4) end,
    st.avg_win, st.avg_loss,
    private.half_kelly_fraction(st.n, st.wins, st.avg_win, st.avg_loss),
    th.confidence, th.stated_confidence, th.status,
    case when p_thesis_id is not null then th.status = 'hardening' and coalesce(th.confidence, 0) >= 80 end,
    'size = requested x multiplier, limited only by spendable cash (no margin); no per-position cap; sells, trims, closes, kills and time stops are never sized here'::text;
end;
$$;

revoke all on function public.steward_sizing_guidance(text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text, numeric)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- The cap-breach audit view no longer measures anything that is a rule.
drop view if exists public.v_sizing_cap_breaches;

-- risk_controls tell the truth: no per-position cap, no % size rail.
update public.risk_controls
set status = 'retired',
    threshold_json = jsonb_build_object(
      'retired', '2026-09-26 David: size follows results with no hard cap per position',
      'replaced_by', 'results-driven sizing: requested x public.thesis_sizing() multiplier, limited only by spendable cash (no margin)'),
    updated_at = now()
where control_key = 'thesis-notional';

update public.risk_controls
set threshold_json = (threshold_json - 'max_single_trade_percent' - 'max_daily_notional_percent')
      || jsonb_build_object('sizing', 'requested x outcome multiplier; spendable cash only (no margin)'),
    updated_at = now()
where control_key = 'autonomous-execution';

update public.risk_controls
set threshold_json = threshold_json - 'max_total_position_percent',
    updated_at = now()
where control_key = 'autonomous-position-management';
