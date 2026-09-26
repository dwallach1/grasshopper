-- Close the "new thesis" escape (2026-09-26). An UNPROVEN thesis (n < 10 or LCB <= 0) used to
-- start at the full starter cap even when its steward was loss-reduced overall, so a steward
-- could register a fresh thesis to get back to the full starter. Now an unproven thesis is
-- capped at min(its own unproven cap, the steward-wide cap over all of the steward's priced
-- trades, including the steward-wide consecutive-loss halvings). The thesis's own halvings are
-- not applied twice: the result is the smaller of the two caps, not a product.
-- Proven theses (n >= 10 and LCB > 0) keep their own edge-based cap.
-- The steward-level (null thesis) cap is unchanged.

create or replace function private.edge_max_stake(p_steward text, p_thesis_id text, p_book_equity numeric)
returns table (max_stake numeric, reason text, trades integer, lcb numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  st record;
  sw record;
  v_starter numeric := private.steward_starter_stake(p_steward);
  v_haircut numeric;
  v_lcb numeric;
  v_kelly numeric;
  v_growth numeric;
  v_stake numeric;
  v_reason text;
  v_proven boolean := false;
  v_digits int := case when p_steward = 'bandit' then 4 else 2 end;
begin
  select * into st from private.stake_edge_stats(p_steward, p_thesis_id);
  v_haircut := power(0.5::numeric, least(coalesce(st.loss_streak, 0), 2));
  if coalesce(st.n, 0) >= 2 and st.sd_ret is not null then
    v_lcb := st.mean_ret - st.sd_ret / sqrt(st.n::numeric);
  end if;

  if coalesce(st.n, 0) >= 10 and v_lcb > 0 then
    v_proven := true;
    v_growth := v_starter * power(2::numeric, 1 + (st.n - 10) / 5.0);
    v_kelly := case when st.sd_ret > 0 and p_book_equity > 0
      then p_book_equity * 0.5 * v_lcb / (st.sd_ret * st.sd_ret) end;
    v_stake := greatest(v_starter, least(coalesce(v_kelly, v_growth), v_growth));
    v_reason := format('proven edge: n=%s, LCB %s%% per trade; min(half-Kelly on LCB x book, starter x 2^(1+(n-10)/5))',
      st.n, round(v_lcb * 100, 2));
  else
    v_stake := v_starter;
    v_reason := case
      when coalesce(st.n, 0) < 10 then format('unproven: %s priced trades (< 10); starter %s', coalesce(st.n, 0), v_starter)
      else format('no measured edge: LCB %s%% <= 0 over %s trades; starter %s', round(v_lcb * 100, 2), st.n, v_starter)
    end;
  end if;
  if v_haircut < 1 then
    v_stake := v_stake * v_haircut;
    v_reason := v_reason || format('; x%s after %s straight %s', trim_scale(v_haircut), st.loss_streak,
      case when st.loss_streak = 1 then 'loss' else 'losses' end);
  end if;

  -- Unproven thesis: never above the steward-wide cap (no escape by registering a new thesis).
  if p_thesis_id is not null and not v_proven then
    select * into sw from private.edge_max_stake(p_steward, null, p_book_equity);
    if sw.max_stake is not null and sw.max_stake < v_stake then
      v_stake := sw.max_stake;
      v_reason := v_reason || format('; capped at steward-wide %s (%s)', trim_scale(sw.max_stake), sw.reason);
    end if;
  end if;

  return query select round(v_stake, v_digits), v_reason, coalesce(st.n, 0), round(v_lcb, 6);
end;
$$;

revoke all on function private.edge_max_stake(text, text, numeric) from public, anon, authenticated;
