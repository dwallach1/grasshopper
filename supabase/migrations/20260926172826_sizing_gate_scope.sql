-- PR 5: the >= 80 autonomous-buy confidence gate applies ONLY to QUANTANAMO equity entries
-- (David, 2026-09-26). For ODDSBORNE and BANDIT the outcome multiplier is the throttle: they
-- may enter at the returned size unless the thesis is 'rejected'. A rejected thesis blocks new
-- entries for every steward. Sizing math is unchanged from 14_no_position_cap.sql.
--   gate_applies             true only for quantanamo
--   thesis_rejected          theses.status = 'rejected' (any steward)
--   autonomous_buy_gate_pass quantanamo: hardening and confidence >= 80 (null without a thesis);
--                            others: not rejected (the gate does not apply)
--   entry_allowed            quantanamo: gate passes; others: not rejected
--   entry_blocked_reason     thesis_rejected | quantanamo_confidence_gate | quantanamo_requires_thesis
--   sized_notional           0 when the thesis is rejected
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
  if v_gate_applies then
    v_gate := case when p_thesis_id is not null then th.status = 'hardening' and coalesce(th.confidence, 0) >= 80 end;
    v_allowed := coalesce(v_gate, false);
    v_reason := case
      when v_rejected then 'thesis_rejected'
      when p_thesis_id is null then 'quantanamo_requires_thesis'
      when not coalesce(v_gate, false) then 'quantanamo_confidence_gate'
    end;
  else
    v_gate := not v_rejected;
    v_allowed := not v_rejected;
    v_reason := case when v_rejected then 'thesis_rejected' end;
  end if;

  return query select
    p_steward, p_thesis_id, p_instrument, coalesce(eq.unit, case when p_steward = 'bandit' then 'SOL' else 'USD' end),
    eq.equity, eq.observed_at, eq.source,
    greatest(ca.cash, 0), private.steward_position_value(p_steward, p_instrument),
    p_requested, v_mult, v_basis,
    case
      when p_requested is null then null
      when v_rejected then 0::numeric
      else round(least(p_requested * v_mult, greatest(coalesce(ca.cash, 0), 0)), 6)
    end,
    coalesce(st.n, 0), coalesce(st.wins, 0),
    case when st.n > 0 then round(st.wins::numeric / st.n, 4) end,
    st.avg_win, st.avg_loss,
    private.half_kelly_fraction(st.n, st.wins, st.avg_win, st.avg_loss),
    th.confidence, th.stated_confidence, th.status,
    v_gate_applies, v_gate, v_rejected, v_allowed, v_reason,
    case when v_gate_applies
      then 'size = requested x multiplier, limited only by spendable cash (no margin); autonomous equity entries need a hardening thesis at confidence >= 80; no per-position cap'
      else 'size = requested x multiplier, limited only by spendable cash (no margin); the multiplier is the throttle (no confidence gate); a rejected thesis blocks new entries; no per-position cap'
    end::text;
end;
$$;

revoke all on function public.steward_sizing_guidance(text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.steward_sizing_guidance(text, text, text, numeric)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
