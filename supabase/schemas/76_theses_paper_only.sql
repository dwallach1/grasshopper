-- theses.paper_only: database-enforced paper-only theses.
-- court-ruling: docs/rules/paper-only-theses.md
-- A thesis can be in forward paper (BANDIT edge2-edge6) while it has a theses row for attribution and
-- scoring. Before this, a forming row was enough for steward_sizing_guidance to hand BANDIT a starter stake
-- (gate_applies is false outside QUANTANAMO), so "paper only" lived only in the scan code. Now:
--   * public.theses gains paper_only boolean not null default false (every existing row stays false);
--   * steward_sizing_guidance: a paper_only thesis is blocked like a rejected/killed one: entry_allowed false,
--     entry_blocked_reason 'paper_only', sized_notional 0 (null when nothing was requested, as for any
--     blocked thesis), max_stake 0, max_stake_reason 'paper_only'. Return shape, SECURITY DEFINER and
--     search_path '' unchanged. Body is supabase/schemas/48 plus the paper_only lines (the reviewed repo text
--     of the sizing note, which the 20260930192137 apply predates);
--   * steward_log_decision: an enter tagged with a paper_only thesis is refused (refusal:paper_only), the same
--     mechanism as refusal:void. Skips are untouched: paper logging stays scoreable. SECURITY INVOKER (the
--     worker roles read public.theses through the #162 select policies). Builds on #160 (schemas/74, applied
--     as version 20261016165531); every other line is unchanged;
--   * meme_orders: a BEFORE INSERT trigger refuses a buy whose thesis is paper_only (refusal:paper_only).
--     Sells are never blocked, so an open lot can always be closed.
-- Grants are restated unchanged (create or replace keeps them).
-- Applied to production (xqungxapqicdmboniezz) 2026-10-17 as version 20261017131644 (theses_paper_only); this file
-- is that SQL plus this line. Theses data (paper_only flags, edge3-5 rows) was written separately, not here.

alter table public.theses add column if not exists paper_only boolean not null default false;

comment on column public.theses.paper_only is
  'Forward paper only: steward_sizing_guidance never allows or sizes an entry (entry_blocked_reason paper_only), steward_log_decision refuses an enter (skips still log and score), and meme_orders refuses a buy. Cleared only by a promotion decision.';

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
  v_killed := coalesce(th.status = 'killed', false);
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
      then 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk to invalidation <= 10% of book (pass p_entry_price); entries need an invalidation_price, a fresh book (<= 6h), and a hardening thesis with gate_score >= 80 (the results score shrunk toward 50 by 16 zero-mean trades; unscored = David approves); an unknown, rejected or killed thesis blocks new entries'
      else 'size = min(requested, max_stake, spendable cash, exposure fit); max_stake = starter (0.03 x book / bet vol) until n_eff >= 10 with a positive LCB (live + discounted out-of-sample backtest), then half-Kelly on the LCB (never below the starter), x the steward drawdown scale; exposure fit keeps open risk <= 10% of book with every open lot and the new entry at full notional (gap-prone: binaries at price x contracts, memes at cost basis); entries need an invalidation_price and a fresh book (<= 6h); an unknown, rejected or killed thesis blocks new entries'
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

create or replace function public.steward_log_decision(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_decision text := lower(btrim(coalesce(p->>'decision', '')));
  v_instrument text := nullif(btrim(coalesce(p->>'instrument', '')), '');
  v_side text := lower(btrim(coalesce(p->>'side', '')));
  v_price numeric := private.try_numeric(p->>'price');
  v_prob numeric := private.try_numeric(p->>'probability');
  v_move numeric := private.try_numeric(p->>'expected_move');
  v_venue text;
  v_horizon text;
  v_status text;
  v_market uuid;
  v_source text := nullif(btrim(coalesce(p->>'source_id', '')), '');
  v_at timestamptz;
  v_id uuid;
  v_owner text;
  v_replayed boolean := false;
  v_edge numeric;
  v_close timestamptz;
  v_terms text;
  -- a priceless SKIP record (meme only): price omitted with an explicit no_price_reason (e.g. a voided paper
  -- entry whose coin has no quote). Stored unscoreable, so it is never marked, scored, or counted as a pass.
  v_no_price text := nullif(btrim(coalesce(p->>'no_price_reason', '')), '');
  v_priceless boolean := false;
  -- a void is not a decision: a paper entry that was never logged in time (blocked_by paper_void_stale). Only a
  -- meme skip with that tag is a void; it is tagged unscoreable here, from blocked_by, so the caller can't forget
  -- and the horizon marks never score it as a skip. An enter carrying the tag is refused.
  v_void_tag boolean := lower(btrim(coalesce(p->>'blocked_by', ''))) = 'paper_void_stale';
  v_void boolean := false;
  -- paper only: an enter tagged with a theses.paper_only thesis is refused (refusal:paper_only). Skips (paper
  -- logging) are unchanged and stay scoreable.
  v_thesis text := nullif(btrim(coalesce(p->>'thesis_id', '')), '');
  v_paper_only boolean := false;
  v_extra jsonb := case
    when jsonb_typeof(p->'meta') = 'object' then p->'meta'
    else '{}'::jsonb
  end;
begin
  if current_user like '%\_worker' and current_user::text <> v_steward || '_worker' then
    raise exception 'refusal:auth: % may not log a decision for %', current_user, v_steward
      using errcode = '42501';
  end if;
  if v_steward = 'quantanamo' then
    v_venue := 'equity';
  elsif v_steward = 'oddsborne' then
    v_venue := 'prediction';
  elsif v_steward = 'bandit' then
    v_venue := 'meme';
  else
    raise exception 'refusal:unscoreable: steward must be quantanamo, oddsborne, or bandit'
      using errcode = 'P0001';
  end if;
  if v_decision not in ('enter', 'skip') then
    raise exception 'refusal:unscoreable: decision must be enter or skip'
      using errcode = 'P0001';
  end if;
  if v_void_tag and v_decision <> 'skip' then
    raise exception 'refusal:void: blocked_by paper_void_stale marks a void, which is not a decision; only a skip may carry it'
      using errcode = 'P0001';
  end if;
  if v_decision <> 'skip' and v_thesis is not null then
    select coalesce(t.paper_only, false) into v_paper_only from public.theses t where t.id = v_thesis;
    if coalesce(v_paper_only, false) then
      raise exception 'refusal:paper_only: thesis % is paper only; log a skip (blocked_by paper_only), not an enter', v_thesis
        using errcode = 'P0001';
    end if;
  end if;
  v_void := v_void_tag and v_decision = 'skip' and v_venue = 'meme';
  if v_instrument is null then
    raise exception 'refusal:unscoreable: name the market or the ticker'
      using errcode = 'P0001';
  end if;
  if v_venue = 'equity' then
    v_instrument := upper(v_instrument);
  end if;

  if v_venue = 'prediction' and v_side not in ('yes', 'no') then
    raise exception 'refusal:unscoreable: side must be yes or no'
      using errcode = 'P0001';
  elsif v_venue <> 'prediction' and v_side not in ('long', 'short') then
    raise exception 'refusal:unscoreable: side must be long or short'
      using errcode = 'P0001';
  end if;

  if v_price is null and v_decision = 'skip' and v_venue = 'meme' and v_no_price is not null then
    v_priceless := true;
  elsif v_price is null or v_price <= 0 or (v_venue = 'prediction' and v_price > 1) then
    raise exception 'refusal:unscoreable: price must be the price at decision time (a prediction price is between 0 and 1, exclusive of 0)'
      using errcode = 'P0001';
  end if;
  if v_venue = 'prediction' and (v_prob is null or v_prob < 0 or v_prob > 1) then
    raise exception 'refusal:unscoreable: a prediction decision needs your probability between 0 and 1'
      using errcode = 'P0001';
  end if;
  if v_venue <> 'prediction'
     and nullif(btrim(coalesce(p->>'probability', '')), '') is not null
     and (v_prob is null or v_prob < 0 or v_prob > 1) then
    raise exception 'refusal:unscoreable: probability must be between 0 and 1'
      using errcode = 'P0001';
  end if;
  if p ? 'expected_move' and nullif(btrim(p->>'expected_move'), '') is not null and v_move is null then
    raise exception 'refusal:unscoreable: expected_move must be a fraction of price, such as 0.08 for +8%%'
      using errcode = 'P0001';
  end if;

  begin
    v_at := nullif(btrim(coalesce(p->>'decided_at', '')), '')::timestamptz;
  exception when others then
    raise exception 'refusal:unscoreable: decided_at is not a timestamp'
      using errcode = 'P0001';
  end;
  v_at := coalesce(v_at, now());
  begin
    v_close := nullif(btrim(coalesce(p->>'close_time', '')), '')::timestamptz;
  exception when others then
    raise exception 'refusal:unscoreable: close_time is not a timestamp'
      using errcode = 'P0001';
  end;

  if v_venue = 'prediction' then
    v_horizon := 'market resolution';
    if nullif(btrim(coalesce(p->>'market_id', '')), '') is not null then
      v_market := (p->>'market_id')::uuid;
    end if;
    if v_market is null then
      -- A pass on a market nobody holds still needs a row to resolve against (59).
      v_market := private.ensure_pm_market(v_instrument, p->>'question', v_close, 'steward_log_decision');
    end if;
    v_status := case when v_market is null then 'no_market' else 'awaiting_resolution' end;
    -- price and probability are the named side's own (Dolphins NO at 0.2375, fair 0.2517)
    -- unless the caller says they are YES terms; the resolver converts before scoring.
    v_terms := case when lower(coalesce(v_extra->>'price_terms', '')) = 'yes' then 'yes' else 'side' end;
    v_edge := v_prob - v_price;
  elsif v_venue = 'equity' then
    v_horizon := '5 equity sessions';
    v_status := 'awaiting_mark';
    v_edge := null;
  else
    v_horizon := '4 hours';
    v_status := case when v_void then 'void' when v_priceless then 'no_price' else 'awaiting_mark' end;
    v_edge := null;
  end if;

  if v_source is null then
    v_source := gen_random_uuid()::text;
  end if;

  insert into public.decision_candidates (
    steward, venue, decided_at, decision, market_id, instrument, thesis_id, side,
    my_probability, book_price, edge, expected_move, reason, source_table, source_id, meta
  ) values (
    v_steward, v_venue, v_at, v_decision, v_market, v_instrument,
    v_thesis, v_side,
    v_prob, v_price, v_edge, v_move,
    left(nullif(btrim(coalesce(p->>'reason', '')), ''), 280),
    'direct', v_source,
    jsonb_strip_nulls(
      (v_extra - 'unscoreable' - 'superseded' - 'legacy_probability_absent') || jsonb_build_object(
        'origin', 'steward_log_decision',
        'horizon', v_horizon,
        'resolve_status', v_status,
        'price_terms', v_terms,
        'blocked_by', nullif(btrim(coalesce(p->>'blocked_by', '')), '')
      ) || case
        when v_void then jsonb_build_object(
          'unscoreable', 'true', 'unscoreable_reason', 'void: paper_void_stale, not a decision'
            || case when v_priceless then '; no_price: ' || left(v_no_price, 200) else '' end)
        when v_priceless then jsonb_build_object(
          'unscoreable', 'true', 'unscoreable_reason', 'no_price: ' || left(v_no_price, 240))
        else '{}'::jsonb end
    )
  )
  on conflict (source_table, source_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id, steward into v_id, v_owner
    from public.decision_candidates
    where source_table = 'direct' and source_id = v_source;
    if v_owner is distinct from v_steward then
      raise exception 'refusal:unscoreable: source_id already belongs to %', coalesce(v_owner, 'another row')
        using errcode = 'P0001';
    end if;
    v_replayed := true;
  elsif v_venue = 'prediction' and v_market is not null then
    perform private.resolve_decision_candidates(v_market);
  elsif v_venue <> 'prediction' then
    perform private.resolve_marked_decisions();
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'replayed', v_replayed,
    'horizon', v_horizon,
    'resolve_status', v_status,
    'market_id', v_market,
    'price_terms', v_terms
  );
exception
  when invalid_text_representation then
    raise exception 'refusal:unscoreable: market_id is not a uuid'
      using errcode = 'P0001';
end;
$$;

comment on function public.steward_log_decision(jsonb) is
  'Log one enter or skip that can be scored later. Refuses (refusal:unscoreable) when the market, side, price, or (for prediction) probability is missing, except a meme SKIP that omits the price and gives no_price_reason: it is stored unscoreable (resolve_status no_price) and never scored. A meme skip with blocked_by paper_void_stale is a void, not a decision: stored unscoreable (resolve_status void), so it is never marked or scored; an enter carrying that tag is refused (refusal:void). An enter tagged with a paper-only thesis (theses.paper_only) is refused (refusal:paper_only); skips on it are logged and scored as before. Does not size a trade. Equity resolves after 5 regular sessions, memes after 4 hours, prediction markets at resolution. Prediction: price and probability are the named side''s own (meta.price_terms = ''side''; pass meta.price_terms = ''yes'' for YES terms); a slug with no pm_markets row gets a ''watch'' stub so it can resolve (optional question, close_time). No price is invented.';

revoke all on function public.steward_log_decision(jsonb) from public, anon, authenticated;
grant execute on function public.steward_log_decision(jsonb)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create or replace function private.refuse_paper_only_meme_buy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.side = 'buy' and new.thesis_id is not null
     and exists (select 1 from public.theses t where t.id = new.thesis_id and t.paper_only) then
    raise exception 'refusal:paper_only: thesis % is paper only; no real-money buy', new.thesis_id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.refuse_paper_only_meme_buy() from public, anon, authenticated;

drop trigger if exists refuse_paper_only_meme_buy on public.meme_orders;
create trigger refuse_paper_only_meme_buy
  before insert on public.meme_orders
  for each row execute function private.refuse_paper_only_meme_buy();
