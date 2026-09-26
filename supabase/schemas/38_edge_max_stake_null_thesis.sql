-- Fix for 37_court_rulings: private.edge_max_stake read the backtest-evidence record only when a
-- thesis id was given, so a null-thesis (untagged ODDSBORNE / BANDIT) sizing call raised
-- "record bt is not assigned yet". The evidence lookup now always runs; a null thesis matches no row.
-- court-ruling: docs/rules/edge-max-stake.md
-- court-ruling: docs/rules/backtest-evidence-credit.md

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
  -- Always assign bt (a null thesis matches no evidence row, leaving its fields null).
  select * into bt from private.thesis_edge_evidence(p_thesis_id);
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

revoke all on function private.edge_max_stake(text, text, numeric) from public, anon, authenticated;
