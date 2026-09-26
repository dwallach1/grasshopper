-- PR 3: ODDSBORNE outcomes re-priced from venue-keyed pm_fills (fills / settlement).
-- Writer fees are net (maker rebates negative); placeholder fills block pricing.

-- ODDSBORNE backfill outcome from venue-keyed pm_fills (PR 3).
--   buys == sells            -> pnl_source 'fills'
--   buys > sells, resolved   -> pnl_source 'settlement' (held x 1 if the side won, else 0)
-- Fees are the NET venue fee (maker rebates are negative) and are subtracted from P/L.
-- A fill without a venue execution id, or an aggregated placeholder, blocks pricing
-- ('fills_suspect') so a duplicate can never inflate cost. Venue liquidity rewards live in
-- pm_notes, not pm_fills, and are never trade P/L. Previous numbers go to meta.repriced_from.
create or replace function private.reprice_pm_backfill_outcome(p_outcome_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.trade_outcomes%rowtype;
  pos public.pm_positions%rowtype;
  v_resolved text;
  pm record;
  v_held numeric;
  v_payout numeric;
  v_proceeds numeric;
  v_source text;
begin
  select * into o from public.trade_outcomes where id = p_outcome_id;
  if not found or o.source_table <> 'pm_positions' then
    return 'skipped';
  end if;
  select * into pos from public.pm_positions where id = o.source_id::uuid;
  if not found then
    return 'no_position';
  end if;
  select
    coalesce(sum(f.quantity) filter (where f.side = 'buy'), 0) as bq,
    coalesce(sum(f.quantity) filter (where f.side = 'sell'), 0) as sq,
    coalesce(sum(f.quantity * f.price) filter (where f.side = 'buy'), 0) as bc,
    coalesce(sum(f.quantity * f.price) filter (where f.side = 'sell'), 0) as sp,
    coalesce(sum(f.fee), 0) as fe,
    count(*)::int as n,
    count(*) filter (
      where nullif(btrim(coalesce(f.venue_fill_id, '')), '') is null
         or f.venue_fill_id like '%-partial-%'
         or coalesce(f.payload->>'note', '') ilike 'aggregated%'
    )::int as suspect
  into pm
  from public.pm_fills f
  where f.position_id = pos.id;
  if pm.n = 0 or pm.bq <= 0 then
    return 'no_fills';
  end if;
  if pm.suspect > 0 then
    return 'fills_suspect';
  end if;
  if pm.sq > pm.bq * 1.000001 then
    return 'fills_incomplete';
  end if;

  select lower(nullif(m.resolution_outcome, '')) into v_resolved
  from public.pm_markets m where m.id = pos.market_id;
  v_held := pm.bq - pm.sq;
  if abs(v_held) <= greatest(pm.bq, 1) * 0.000001 then
    v_held := 0;
    v_payout := 0;
    v_source := 'fills';
  elsif v_resolved in ('yes', 'no') then
    v_payout := case when v_resolved = lower(coalesce(pos.outcome, '')) then v_held else 0 end;
    v_source := 'settlement';
  else
    return 'fills_incomplete';
  end if;
  v_proceeds := pm.sp + v_payout;

  update public.trade_outcomes
  set cost = round(pm.bc, 6),
      proceeds = round(v_proceeds, 6),
      fees = round(pm.fe, 6),
      realized_pnl = round(v_proceeds - pm.bc - pm.fe, 6),
      pnl_source = v_source,
      meta = (meta - 'basis') || jsonb_strip_nulls(jsonb_build_object(
        'repriced_at', now(),
        'fills', pm.n,
        'fill_match', 'position',
        'bought', pm.bq, 'sold', pm.sq, 'held_to_settlement', v_held,
        'resolution', v_resolved, 'settlement_payout', v_payout,
        'fees_basis', 'net venue fees (maker rebates negative)',
        'repriced_from', coalesce(meta->'repriced_from', jsonb_build_object(
          'cost', o.cost, 'proceeds', o.proceeds, 'fees', o.fees,
          'realized_pnl', o.realized_pnl, 'pnl_source', o.pnl_source))
      )),
      updated_at = now()
  where id = o.id
    and (cost, proceeds, fees, realized_pnl, pnl_source)
        is distinct from (round(pm.bc, 6), round(v_proceeds, 6), round(pm.fe, 6),
                          round(v_proceeds - pm.bc - pm.fe, 6), v_source);
  return 'pm_' || v_source;
end;
$$;

revoke all on function private.reprice_pm_backfill_outcome(uuid) from public, anon, authenticated;

-- Re-price one outcome row. Trigger-origin rows re-run their writer. Backfill rows
-- are upgraded only when real fills now cover the round trip (pnl_source = 'fills',
-- or 'settlement' for prediction positions held to resolution);
-- the previous numbers are kept in meta.repriced_from. Never invents a number.
create or replace function private.reprice_trade_outcome(p_outcome_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.trade_outcomes%rowtype;
  ep public.position_episodes%rowtype;
  rt record;
  v_episode uuid;
  pm record;
  meme record;
  v_before numeric;
begin
  select * into o from public.trade_outcomes where id = p_outcome_id;
  if not found then
    return 'missing';
  end if;
  v_before := o.realized_pnl;

  if o.source_table = 'meme_positions' then
    if coalesce(o.meta->>'origin', '') = 'trigger' then
      perform private.trade_outcome_from_meme(o.source_id::uuid);
      -- The writer rebuilds meta; keep the backfill tag and record what changed.
      update public.trade_outcomes t
      set meta = t.meta
        || jsonb_strip_nulls(jsonb_build_object('backfilled', o.meta->>'backfilled'))
        || case
             when t.realized_pnl is distinct from o.realized_pnl or t.fees is distinct from o.fees
               then jsonb_build_object('repriced_at', now(), 'repriced_from',
                 jsonb_build_object('realized_pnl', o.realized_pnl, 'fees', o.fees, 'pnl_source', o.pnl_source))
             else coalesce(jsonb_strip_nulls(jsonb_build_object(
               'repriced_at', o.meta->'repriced_at', 'repriced_from', o.meta->'repriced_from')), '{}'::jsonb)
           end
      where t.id = o.id;
      return 'meme_writer';
    end if;
    return 'skipped';
  end if;

  if o.source_table = 'pm_positions' then
    if coalesce(o.meta->>'origin', '') = 'trigger' then
      perform private.trade_outcome_from_pm(o.source_id::uuid);
      return 'pm_writer';
    end if;
    -- Backfill row: priced only from venue-keyed pm_fills (fills or fills + settlement).
    return private.reprice_pm_backfill_outcome(o.id);
  end if;

  if o.steward = 'quantanamo' and o.source_table in ('position_episodes', 'manual_backfill') then
    if o.source_table = 'position_episodes' then
      v_episode := o.source_id::uuid;
      select * into ep from public.position_episodes where id = v_episode;
    end if;
    select * into rt
    from private.equity_round_trip_fills(o.account_key, o.instrument, o.opened_at, o.closed_at, v_episode);
    if not rt.priced then
      if o.source_table = 'position_episodes' and coalesce(o.meta->>'origin', '') = 'trigger' then
        perform private.trade_outcome_from_episode(v_episode);
        return 'episode_writer';
      end if;
      return 'fills_incomplete';
    end if;
    update public.trade_outcomes
    set account_key = private.canonical_account_key('equity', account_key),
        opened_at = coalesce(rt.first_buy_at, opened_at),
        closed_at = coalesce(rt.last_sell_at, closed_at),
        cost = round(rt.cost, 4),
        proceeds = round(rt.proceeds, 4),
        fees = rt.fees,
        realized_pnl = round(rt.proceeds - rt.cost - rt.fees, 4),
        pnl_source = 'fills',
        meta = (meta - 'basis' - 'needs_pricing') || jsonb_strip_nulls(jsonb_build_object(
          'repriced_at', now(),
          'fills', rt.fills,
          'fill_match', rt.match,
          'placeholder_policy_intents', nullif(rt.placeholder_policy_intents, 0),
          'repriced_from', jsonb_build_object('cost', o.cost, 'proceeds', o.proceeds, 'fees', o.fees,
            'realized_pnl', o.realized_pnl, 'pnl_source', o.pnl_source,
            'opened_at', o.opened_at, 'closed_at', o.closed_at))),
        updated_at = now()
    where id = o.id
      and (realized_pnl is distinct from round(rt.proceeds - rt.cost - rt.fees, 4)
        or pnl_source is distinct from 'fills'
        or fees is distinct from rt.fees
        or closed_at is distinct from coalesce(rt.last_sell_at, closed_at));
    return 'equity_fills:' || rt.match;
  end if;

  return 'skipped';
end;
$$;

revoke all on function private.reprice_trade_outcome(uuid) from public, anon, authenticated;

-- Trigger-origin writer: record the net venue fee even when rebates make it negative.
create or replace function private.trade_outcome_from_pm(p_position_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pos public.pm_positions%rowtype;
  mkt public.pm_markets%rowtype;
  existing_meta jsonb;
  buy_cost numeric;
  buy_q numeric;
  sell_proc numeric;
  sell_q numeric;
  fee_sum numeric;
  n_fills integer;
  v_cost numeric;
  v_held numeric;
  v_payout numeric;
  v_proceeds numeric;
  v_pnl numeric;
  v_source text;
  v_edge numeric;
  resolved text;
begin
  select * into pos from public.pm_positions where id = p_position_id;
  if not found or coalesce(pos.status, '') not in ('closed', 'settled', 'resolved', 'expired') then
    return;
  end if;
  select meta into existing_meta
  from public.trade_outcomes
  where source_table = 'pm_positions' and source_id = p_position_id::text;
  if found and coalesce(existing_meta->>'origin', '') <> 'trigger' then
    return;
  end if;
  select * into mkt from public.pm_markets where id = pos.market_id;
  resolved := lower(nullif(mkt.resolution_outcome, ''));

  select
    coalesce(sum(f.quantity * f.price) filter (where f.side = 'buy'), 0),
    coalesce(sum(f.quantity) filter (where f.side = 'buy'), 0),
    coalesce(sum(f.quantity * f.price) filter (where f.side = 'sell'), 0),
    coalesce(sum(f.quantity) filter (where f.side = 'sell'), 0),
    coalesce(sum(f.fee), 0),
    count(*)
  into buy_cost, buy_q, sell_proc, sell_q, fee_sum, n_fills
  from public.pm_fills f
  where f.position_id = p_position_id;

  v_cost := case
    when buy_q > 0 then buy_cost
    else coalesce(
      private.try_numeric(pos.meta->>'cost_cash'),
      private.try_numeric(pos.meta->>'cost'),
      case when pos.quantity > 0 and pos.average_cost is not null then pos.quantity * pos.average_cost end
    )
  end;
  v_held := case
    when buy_q > 0 then buy_q - sell_q
    else coalesce(nullif(pos.quantity, 0), private.try_numeric(pos.meta->>'prior_qty'))
  end;

  if buy_q > 0 and abs(buy_q - sell_q) <= greatest(buy_q, 1) * 0.000001 then
    v_proceeds := sell_proc;
    v_source := 'fills';
  elsif resolved in ('yes', 'no') and v_cost is not null
        and (resolved is distinct from lower(pos.outcome) or v_held is not null) then
    v_payout := case when resolved = lower(pos.outcome) then v_held else 0 end;
    v_proceeds := sell_proc + v_payout;
    v_source := 'settlement';
  else
    v_proceeds := null;
    v_source := 'manual';
  end if;

  v_pnl := case
    when v_proceeds is not null and v_cost is not null
      then v_proceeds - v_cost - (case when buy_q > 0 then fee_sum else 0 end)
  end;

  select c.edge into v_edge
  from public.decision_candidates c
  where c.market_id = pos.market_id and c.decision = 'enter' and c.edge is not null
    and (pos.opened_at is null or c.decided_at <= pos.opened_at + interval '1 day')
  order by c.decided_at desc
  limit 1;

  insert into public.trade_outcomes (
    steward, venue, account_key, instrument, thesis_id, source_table, source_id,
    opened_at, closed_at, cost, proceeds, fees, realized_pnl, unit, pnl_source,
    confidence_at_entry, size_pct_nav_at_entry, edge_at_entry, exit_reason, is_paper, meta
  ) values (
    'oddsborne', 'prediction',
    private.canonical_account_key('prediction', pos.account_key),
    coalesce(mkt.slug, mkt.question, pos.market_id::text) || ' ' || upper(coalesce(pos.outcome, '')),
    nullif(btrim(coalesce(pos.thesis_id, '')), ''),
    'pm_positions', p_position_id::text,
    pos.opened_at, coalesce(pos.closed_at, now()),
    v_cost, v_proceeds,
    case when n_fills > 0 then fee_sum else private.try_numeric(pos.meta->>'fees') end,
    v_pnl, 'USD', v_source,
    private.thesis_confidence_at(nullif(btrim(coalesce(pos.thesis_id, '')), ''), pos.opened_at),
    null, v_edge,
    nullif(coalesce(pos.meta->>'closed_reason', pos.meta->>'exit_reason',
      case when resolved is not null then 'resolved_' || resolved end), ''),
    false,
    jsonb_strip_nulls(jsonb_build_object(
      'origin', 'trigger',
      'fills', n_fills,
      'market_slug', mkt.slug,
      'resolution', resolved,
      'needs_pricing', case when v_pnl is null then true end,
      'source_account_key', pos.account_key
    ))
  )
  on conflict (source_table, source_id) do update set
    account_key = excluded.account_key,
    instrument = excluded.instrument,
    thesis_id = excluded.thesis_id,
    opened_at = excluded.opened_at,
    closed_at = excluded.closed_at,
    cost = excluded.cost,
    proceeds = excluded.proceeds,
    fees = excluded.fees,
    realized_pnl = excluded.realized_pnl,
    pnl_source = excluded.pnl_source,
    confidence_at_entry = excluded.confidence_at_entry,
    edge_at_entry = excluded.edge_at_entry,
    exit_reason = excluded.exit_reason,
    meta = excluded.meta,
    updated_at = now()
  where public.trade_outcomes.meta->>'origin' = 'trigger';
end;
$$;

revoke all on function private.trade_outcome_from_pm(uuid) from public, anon, authenticated;
