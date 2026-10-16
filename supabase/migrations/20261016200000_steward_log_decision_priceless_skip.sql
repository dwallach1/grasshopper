-- steward_log_decision: allow a priceless meme SKIP record when the caller gives no_price_reason.
-- Used by BANDIT's edge5 scan to log a voided paper entry (blocked_by paper_void_stale) for a coin that has no
-- quote and no stored signal-time price. Never invents a price: the row is stored with book_price null,
-- meta.unscoreable = 'true', meta.unscoreable_reason = 'no_price: <reason>', resolve_status 'no_price', so the
-- decision_candidates_must_be_scoreable check accepts it and it is never marked, scored, or counted as a pass.
-- Every other write is unchanged (a missing price is still refused).

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
    v_status := case when v_priceless then 'no_price' else 'awaiting_mark' end;
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
    nullif(btrim(coalesce(p->>'thesis_id', '')), ''), v_side,
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
      ) || case when v_priceless then jsonb_build_object(
        'unscoreable', 'true', 'unscoreable_reason', 'no_price: ' || left(v_no_price, 240)
      ) else '{}'::jsonb end
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
  'Log one enter or skip that can be scored later. Refuses (refusal:unscoreable) when the market, side, price, or (for prediction) probability is missing, except a meme SKIP that omits the price and gives no_price_reason: it is stored unscoreable (resolve_status no_price) and never scored. Does not size or gate a trade. Equity resolves after 5 regular sessions, memes after 4 hours, prediction markets at resolution. Prediction: price and probability are the named side''s own (meta.price_terms = ''side''; pass meta.price_terms = ''yes'' for YES terms); a slug with no pm_markets row gets a ''watch'' stub so it can resolve (optional question, close_time). No price is invented.';
