-- Steward exit / mark / P&L / lesson RPCs: the ledger writes a position needs after entry (marked,
-- reduced, closed, P&L snapshot, closed-trade lesson), as SQL functions the box can call over HTTPS
-- through the steward-rpc edge function (the box egresses HTTPS only; the Postgres pooler times out).
--
-- Same rules as 50_steward_entry_rpc.sql: SECURITY INVOKER, one jsonb in / one jsonb out, one transaction
-- per call, refusals raised as 'refusal:<gate>: <reason>' (P0001), execute granted only to the steward's
-- worker role and service_role. steward-rpc connects AS the worker, so table grants, RLS and every trigger
-- (require_lot_invalidation, trade_outcome_capture, order_thesis_from_fill, the ODDSBORNE heartbeat
-- touches, belief_update_sync_thesis) apply exactly as on the old psycopg path.
--
-- Realized P&L: private.trade_outcome_capture prices a closed lot from its linked fills only when the
-- linked buy and sell quantities match (pnl_source 'fills'); otherwise it writes realized_pnl null,
-- pnl_source 'manual'. ODDSBORNE's 10/4 TEN and MIA closes landed there because the maker entry fills
-- were never written to pm_fills. oddsborne_exit_record therefore takes the lot's entry fills along with
-- the exit fills, links them, and refuses to close a lot whose linked buys don't match the sells unless
-- the caller says why (allow_unpriced + unpriced_reason).

-- ------------------------------------------------------------------ shared: closed-trade lesson
-- One belief_updates row for a closed lot (counts for v_learning_loop_gaps). The steward comes from the
-- worker role; the lot must be that steward's, closed, and the thesis must be the lot's.
create or replace function public.steward_close_lesson(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_steward text;
  v_kind text := coalesce(nullif(p->>'kind', ''), 'trade_close_lesson');
  v_lot uuid := (p->>'position_id')::uuid;
  v_table text;
  v_lot_thesis text;
  v_status text;
  v_closed timestamptz;
  v_thesis text;
  v_prior numeric;
  v_new numeric := (p->>'new_confidence')::numeric;
  v_id uuid;
begin
  if current_user::text like '%\_worker' then
    v_steward := left(current_user::text, length(current_user::text) - length('_worker'));
    if nullif(p->>'steward', '') is not null and p->>'steward' <> v_steward then
      raise exception 'refusal:auth: % may not write a lesson for steward %', current_user, p->>'steward'
        using errcode = '42501';
    end if;
  else
    v_steward := p->>'steward';
  end if;
  if v_kind not in ('trade_close_lesson', 'playbook_rule', 'autopsy') then
    raise exception 'refusal:input: kind must be trade_close_lesson, playbook_rule or autopsy, got %', v_kind
      using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p->>'rationale', ''))) < 20 then
    raise exception 'refusal:input: rationale (what the close taught, >= 20 chars) is required' using errcode = 'P0001';
  end if;
  if v_lot is null then
    raise exception 'refusal:input: position_id is required' using errcode = 'P0001';
  end if;
  if v_steward = 'bandit' then
    v_table := 'meme_positions';
    select thesis_id, status, closed_at into v_lot_thesis, v_status, v_closed from public.meme_positions where id = v_lot;
  elsif v_steward = 'oddsborne' then
    v_table := 'pm_positions';
    select thesis_id, status, closed_at into v_lot_thesis, v_status, v_closed from public.pm_positions where id = v_lot;
  else
    raise exception 'refusal:input: steward % has no lot table here', v_steward using errcode = 'P0001';
  end if;
  if not found then
    raise exception 'refusal:input: % lot % not found', v_table, v_lot using errcode = 'P0001';
  end if;
  if v_status is distinct from 'closed' then
    raise exception 'refusal:state: lot % is %; a close lesson needs a closed lot', v_lot, v_status using errcode = 'P0001';
  end if;
  v_thesis := coalesce(nullif(p->>'thesis_id', ''), v_lot_thesis);
  if v_thesis is null then
    raise exception 'refusal:input: lot % has no thesis_id; pass thesis_id', v_lot using errcode = 'P0001';
  end if;
  if v_lot_thesis is not null and v_thesis <> v_lot_thesis then
    raise exception 'refusal:input: thesis % is not the lot''s thesis %', v_thesis, v_lot_thesis using errcode = 'P0001';
  end if;
  if v_new is not null and (v_new < 1 or v_new > 100) then
    raise exception 'refusal:input: new_confidence is on the 1-100 scale, got %', v_new using errcode = 'P0001';
  end if;
  -- workers can't read theses under RLS, so fall back to the thesis's latest belief update
  v_prior := coalesce((p->>'prior_confidence')::numeric,
                      (select coalesce(t.stated_confidence, t.confidence) from public.theses t where t.id = v_thesis),
                      (select b.new_confidence from public.belief_updates b
                        where b.thesis_id = v_thesis and b.new_confidence is not null
                        order by b.observed_at desc nulls last, b.created_at desc limit 1));
  insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
  values (v_thesis, v_prior, v_new, btrim(p->>'rationale'), now(),
          coalesce(p->'meta', '{}'::jsonb) || jsonb_build_object(
            'kind', v_kind, 'steward', v_steward, 'lot_table', v_table, 'lot_id', v_lot,
            'lot_closed_at', v_closed, 'writer', 'close_lesson'))
  returning id into v_id;
  return jsonb_build_object('belief_update_id', v_id, 'thesis_id', v_thesis, 'kind', v_kind,
                            'prior_confidence', v_prior, 'new_confidence', v_new, 'lot_closed_at', v_closed);
end;
$$;

-- ------------------------------------------------------------------ BANDIT (mark_clip.py, exit_clip.py, pnl_snapshot.py)
create or replace function public.bandit_position_get(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', mp.id, 'status', mp.status, 'quantity', mp.quantity, 'average_cost_sol', mp.average_cost_sol,
    'mark_sol', mp.mark_sol, 'mark_at', mp.mark_at, 'opened_at', mp.opened_at, 'closed_at', mp.closed_at,
    'thesis_id', mp.thesis_id, 'invalidation_price', mp.invalidation_price, 'kill_criteria', mp.kill_criteria,
    'account_key', mp.account_key, 'meta', mp.meta,
    'token', jsonb_build_object('id', t.id, 'mint', t.mint, 'symbol', t.symbol, 'name', t.name))
  from public.meme_positions mp
  join public.meme_tokens t on t.id = mp.token_id
  where mp.id = (p->>'position_id')::uuid;
$$;

create or replace function public.bandit_open_positions(p jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', mp.id, 'symbol', t.symbol, 'mint', t.mint, 'quantity', mp.quantity,
    'average_cost_sol', mp.average_cost_sol, 'mark_sol', mp.mark_sol, 'mark_at', mp.mark_at,
    'opened_at', mp.opened_at, 'invalidation_price', mp.invalidation_price, 'thesis_id', mp.thesis_id)
    order by mp.opened_at), '[]'::jsonb)
  from public.meme_positions mp
  join public.meme_tokens t on t.id = mp.token_id
  where mp.status = 'open' and mp.account_key = coalesce(p->>'account_key', mp.account_key);
$$;

-- One mark: the lot's mark and meta (merged), the token's last price, one meme_pnl watch row, heartbeat.
create or replace function public.bandit_mark_position(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pos public.meme_positions%rowtype;
  v_at timestamptz := coalesce((p->>'mark_at')::timestamptz, now());
  v_mark numeric := (p->>'mark_sol')::numeric;
  v_pnl uuid;
  v_hb uuid;
  v_hb_err text;
begin
  if v_mark is null or v_mark < 0 then
    raise exception 'refusal:input: mark_sol is required and >= 0' using errcode = 'P0001';
  end if;
  select * into v_pos from public.meme_positions where id = (p->>'position_id')::uuid for update;
  if not found then
    raise exception 'refusal:input: meme position % not found', p->>'position_id' using errcode = 'P0001';
  end if;
  if v_pos.status <> 'open' or coalesce(v_pos.quantity, 0) <= 0 then
    return jsonb_build_object('updated', 0, 'reason', 'not_open', 'status', v_pos.status, 'quantity', v_pos.quantity);
  end if;
  update public.meme_positions
     set mark_sol = v_mark, mark_at = v_at, updated_at = now(),
         meta = coalesce(meta, '{}'::jsonb) || coalesce(p->'meta_patch', '{}'::jsonb)
   where id = v_pos.id;
  update public.meme_tokens set last_price_sol = v_mark, last_marked_at = v_at, updated_at = now()
   where id = v_pos.token_id;
  if jsonb_typeof(p->'pnl') = 'object' then
    insert into public.meme_pnl (account_key, as_of, cash_sol, equity_sol, unrealized, realized, notes, payload)
    values (v_pos.account_key, v_at, (p->'pnl'->>'cash_sol')::numeric, (p->'pnl'->>'equity_sol')::numeric,
            (p->'pnl'->>'unrealized')::numeric, coalesce((p->'pnl'->>'realized')::numeric, 0),
            p->'pnl'->>'notes', coalesce(p->'pnl'->'payload', '{}'::jsonb))
    returning id into v_pnl;
  end if;
  begin  -- the old scripts' heartbeat; skipped when the role can't update desk_agents
    update public.desk_agents set heartbeat_at = now() where slug = 'bandit' returning id into v_hb;
  exception when others then
    v_hb := null;
    v_hb_err := sqlerrm;
  end;
  return jsonb_build_object('updated', 1, 'pnl_id', v_pnl, 'invalidation_price', v_pos.invalidation_price,
                            'heartbeat_updated', v_hb is not null, 'heartbeat_skipped', v_hb_err);
end;
$$;

-- The 'submitted' live sell order for an open lot (re-checked under a row lock).
create or replace function public.bandit_exit_open_order(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pos public.meme_positions%rowtype;
  v_order uuid;
begin
  select * into v_pos from public.meme_positions where id = (p->>'position_id')::uuid for update;
  if not found then
    raise exception 'refusal:input: meme position % not found', p->>'position_id' using errcode = 'P0001';
  end if;
  if v_pos.status <> 'open' then
    raise exception 'refusal:state: position % is %', v_pos.id, v_pos.status using errcode = 'P0001';
  end if;
  if v_pos.meta ? 'deadline_exit' then
    raise exception 'refusal:state: an exit is already recorded on position % (meta.deadline_exit)', v_pos.id
      using errcode = 'P0001';
  end if;
  insert into public.meme_orders (token_id, account_key, side, order_type, size_sol, size_tokens, status, mode,
                                  kill_criteria, rationale, gate_results, payload, submitted_at)
  values (v_pos.token_id, v_pos.account_key, 'sell', 'market', (p->>'size_sol')::numeric,
          (p->>'size_tokens')::numeric, 'submitted', 'live', coalesce(p->>'kill_criteria', v_pos.kill_criteria),
          p->>'rationale', coalesce(p->'gate_results', '{}'::jsonb), coalesce(p->'payload', '{}'::jsonb), now())
  returning id into v_order;
  return jsonb_build_object('order_id', v_order, 'token_id', v_pos.token_id, 'position_id', v_pos.id);
end;
$$;

-- The post-swap exit block: order -> filled, the sell fill (linked to the lot), the lot reduced or closed
-- (trade_outcome_capture prices the close from the linked fills), a meme_pnl row, heartbeat.
create or replace function public.bandit_exit_record_fill(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order uuid := (p->>'order_id')::uuid;
  v_pid uuid := (p->>'position_id')::uuid;
  v_sig text := p->>'signature';
  v_px numeric := (p->>'exit_price')::numeric;
  v_in numeric := (p->>'in_tokens')::numeric;
  v_remain numeric := coalesce((p->>'remain_tokens')::numeric, 0);
  v_cash numeric := (p->>'cash_sol')::numeric;
  v_pos public.meme_positions%rowtype;
  v_fill uuid;
  v_closed boolean;
  v_unreal numeric;
  v_pnl uuid;
  v_hb uuid;
  v_hb_err text;
  v_to record;
begin
  select * into v_pos from public.meme_positions where id = v_pid for update;
  if not found then
    raise exception 'refusal:input: meme position % not found', v_pid using errcode = 'P0001';
  end if;
  update public.meme_orders
     set status = 'filled', signature = v_sig, price_sol = v_px, size_tokens = v_in,
         size_sol = (p->>'out_sol')::numeric, updated_at = now(),
         payload = payload || coalesce(p->'order_payload', '{}'::jsonb)
   where id = v_order;
  if not found then
    raise exception 'refusal:input: meme order % not found', v_order using errcode = 'P0001';
  end if;

  insert into public.meme_fills (order_id, position_id, account_key, venue_fill_id, venue_order_id,
                                 side, quantity, price_sol, fee_sol, executed_at, payload)
  values (v_order, v_pid, v_pos.account_key, v_sig, p->>'venue_order_id', 'sell', v_in, coalesce(v_px, 0),
          coalesce((p->>'fee_sol')::numeric, 0), coalesce((p->>'executed_at')::timestamptz, now()),
          coalesce(p->'fill_payload', '{}'::jsonb))
  on conflict (account_key, venue_fill_id) do nothing
  returning id into v_fill;

  v_closed := v_remain <= 0.000000001;
  if v_closed then
    update public.meme_positions
       set status = 'closed', quantity = 0, mark_sol = v_px, mark_at = now(), closed_at = now(), updated_at = now(),
           meta = coalesce(meta, '{}'::jsonb) || coalesce(p->'close_meta', '{}'::jsonb)
     where id = v_pid;
  else
    update public.meme_positions
       set quantity = v_remain, mark_sol = v_px, mark_at = now(), updated_at = now(),
           meta = coalesce(meta, '{}'::jsonb) || coalesce(p->'close_meta', '{}'::jsonb)
     where id = v_pid;
  end if;

  select coalesce(sum(quantity * coalesce(mark_sol, average_cost_sol, 0)), 0) into v_unreal
  from public.meme_positions where account_key = v_pos.account_key and status = 'open';
  insert into public.meme_pnl (account_key, as_of, realized, unrealized, fees, cash_sol, equity_sol, notes, payload)
  values (v_pos.account_key, coalesce((p->>'as_of')::timestamptz, now()), coalesce((p->>'realized_total')::numeric, 0),
          v_unreal, 0, v_cash, v_cash + v_unreal, p->>'pnl_notes', coalesce(p->'pnl_payload', '{}'::jsonb))
  returning id into v_pnl;

  begin
    update public.desk_agents set heartbeat_at = now() where slug = 'bandit' returning id into v_hb;
  exception when others then
    v_hb := null;
    v_hb_err := sqlerrm;
  end;

  select o.realized_pnl, o.pnl_source, o.meta->>'needs_pricing' as needs_pricing into v_to
  from public.trade_outcomes o
  where o.source_table = 'meme_positions' and o.source_id = v_pid::text;

  return jsonb_build_object(
    'order_id', v_order, 'position_id', v_pid, 'fill_id', v_fill, 'fill_inserted', v_fill is not null,
    'pnl_id', v_pnl, 'closed', v_closed, 'remaining_tokens', case when v_closed then 0 else v_remain end,
    'unrealized', v_unreal, 'equity_sol', v_cash + v_unreal,
    'realized_pnl', v_to.realized_pnl, 'pnl_source', v_to.pnl_source,
    'heartbeat_updated', v_hb is not null, 'heartbeat_skipped', v_hb_err);
end;
$$;

-- Merge into a meme_pnl row's payload (the post-exit token-account cleanup result).
create or replace function public.bandit_annotate_pnl(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if jsonb_typeof(p->'payload') is distinct from 'object' then
    raise exception 'refusal:input: payload must be an object' using errcode = 'P0001';
  end if;
  update public.meme_pnl set payload = coalesce(payload, '{}'::jsonb) || (p->'payload')
   where id = (p->>'pnl_id')::uuid;
  get diagnostics v_n = row_count;
  return jsonb_build_object('pnl_id', p->>'pnl_id', 'updated', v_n);
end;
$$;

-- A book snapshot (standups, catch-ups): cash from the venue, unrealized from open lots' marks.
create or replace function public.bandit_pnl_snapshot(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_acct text := coalesce(nullif(p->>'account_key', ''), 'solana-bandit-primary');
  v_cash numeric := (p->>'cash_sol')::numeric;
  v_unreal numeric;
  v_open integer;
  v_pnl uuid;
  v_hb uuid;
  v_hb_err text;
begin
  if v_cash is null or v_cash < 0 then
    raise exception 'refusal:input: cash_sol (venue balance) is required' using errcode = 'P0001';
  end if;
  select coalesce(sum(quantity * coalesce(mark_sol, average_cost_sol, 0)), 0), count(*) into v_unreal, v_open
  from public.meme_positions where account_key = v_acct and status = 'open';
  insert into public.meme_pnl (account_key, as_of, realized, unrealized, fees, cash_sol, equity_sol, notes, payload)
  values (v_acct, coalesce((p->>'as_of')::timestamptz, now()), coalesce((p->>'realized')::numeric, 0), v_unreal, 0,
          v_cash, v_cash + v_unreal, p->>'notes', coalesce(p->'payload', '{}'::jsonb))
  returning id into v_pnl;
  begin
    update public.desk_agents set status = 'active', heartbeat_at = now(), updated_at = now()
     where slug = 'bandit' returning id into v_hb;
  exception when others then
    v_hb := null;
    v_hb_err := sqlerrm;
  end;
  return jsonb_build_object('pnl_id', v_pnl, 'cash_sol', v_cash, 'unrealized', v_unreal,
                            'equity_sol', v_cash + v_unreal, 'open_count', v_open,
                            'heartbeat_updated', v_hb is not null, 'heartbeat_skipped', v_hb_err);
end;
$$;

-- ------------------------------------------------------------------ ODDSBORNE (pm_watch.py, pm_exit.py, pm_fills_sync.py, pm_pnl_snapshot.py)
create or replace function public.oddsborne_position_get(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', pp.id, 'status', pp.status, 'outcome', pp.outcome, 'quantity', pp.quantity,
    'average_cost', pp.average_cost, 'mark', pp.mark, 'mark_at', pp.mark_at, 'opened_at', pp.opened_at,
    'closed_at', pp.closed_at, 'thesis_id', pp.thesis_id, 'invalidation_price', pp.invalidation_price,
    'invalidation_note', pp.invalidation_note, 'kill_criteria', pp.kill_criteria,
    'account_key', pp.account_key, 'market_id', pp.market_id, 'meta', pp.meta,
    'market', jsonb_build_object('slug', m.slug, 'question', m.question, 'status', m.status,
                                 'resolution_outcome', m.resolution_outcome,
                                 'yes_side_id', m.yes_token_id, 'no_side_id', m.no_token_id),
    'entry_orders', coalesce((
      select jsonb_agg(jsonb_build_object('pm_order_id', o.id, 'venue_order_id', o.venue_order_id,
                                          'status', o.status, 'size', o.size, 'price', o.price,
                                          'created_at', o.created_at) order by o.created_at)
      from public.pm_orders o
      where o.account_key = pp.account_key and o.market_id = pp.market_id and o.outcome = pp.outcome
        and o.side = 'buy' and o.venue_order_id is not null), '[]'::jsonb),
    'linked_fills', (
      select jsonb_build_object(
        'n', count(*),
        'buy_qty', coalesce(sum(f.quantity) filter (where f.side = 'buy'), 0),
        'sell_qty', coalesce(sum(f.quantity) filter (where f.side = 'sell'), 0))
      from public.pm_fills f where f.position_id = pp.id))
  from public.pm_positions pp
  join public.pm_markets m on m.id = pp.market_id
  where pp.id = (p->>'position_id')::uuid;
$$;

create or replace function public.oddsborne_open_positions(p jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', pp.id, 'slug', m.slug, 'outcome', pp.outcome, 'quantity', pp.quantity,
    'average_cost', pp.average_cost, 'mark', pp.mark, 'mark_at', pp.mark_at, 'opened_at', pp.opened_at,
    'invalidation_price', pp.invalidation_price, 'thesis_id', pp.thesis_id) order by pp.opened_at), '[]'::jsonb)
  from public.pm_positions pp
  join public.pm_markets m on m.id = pp.market_id
  where pp.status = 'open' and pp.account_key = coalesce(p->>'account_key', pp.account_key);
$$;

-- A pm_orders row by venue order id, with what pm_fills_sync.py needs to record late fills and open the
-- lot (thesis, the invalidation pm_enter gated on, the market slug).
create or replace function public.oddsborne_order_get(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'pm_order_id', o.id, 'venue_order_id', o.venue_order_id, 'market_id', o.market_id, 'slug', m.slug,
    'account_key', o.account_key, 'thesis_id', o.thesis_id, 'outcome', o.outcome, 'side', o.side,
    'order_type', o.order_type, 'size', o.size, 'price', o.price, 'status', o.status,
    'kill_criteria', o.kill_criteria, 'submitted_at', o.submitted_at,
    'invalidation_price', o.gate_results->>'invalidation_price',
    'invalidation_note', o.gate_results->>'invalidation_note',
    'fills', (select jsonb_build_object('n', count(*), 'qty', coalesce(sum(f.quantity), 0),
                                        'unlinked', count(*) filter (where f.position_id is null))
              from public.pm_fills f where f.order_id = o.id))
  from public.pm_orders o
  join public.pm_markets m on m.id = o.market_id
  where o.venue_order_id = p->>'venue_order_id'
    and o.account_key = coalesce(nullif(p->>'account_key', ''), 'polymarket-us-primary')
  order by o.created_at desc
  limit 1;
$$;

create or replace function public.oddsborne_order_set_status(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if p->>'status' not in ('submitted', 'open', 'partial', 'filled', 'cancelled', 'rejected', 'expired') then
    raise exception 'refusal:input: status % is not a venue order status', p->>'status' using errcode = 'P0001';
  end if;
  update public.pm_orders
     set status = p->>'status', updated_at = now(),
         payload = coalesce(payload, '{}'::jsonb) || coalesce(p->'payload_patch', '{}'::jsonb)
   where venue_order_id = p->>'venue_order_id'
     and account_key = coalesce(nullif(p->>'account_key', ''), 'polymarket-us-primary');
  get diagnostics v_n = row_count;
  return jsonb_build_object('venue_order_id', p->>'venue_order_id', 'status', p->>'status', 'updated', v_n);
end;
$$;

-- One watch mark on an open lot (mark, mark_at, meta merged). The pm_positions trigger touches the heartbeat.
create or replace function public.oddsborne_mark_position(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_n integer;
  v_mark numeric := (p->>'mark')::numeric;
begin
  if v_mark is null or v_mark < 0 or v_mark > 1 then
    raise exception 'refusal:input: mark must be an outcome price in [0, 1]' using errcode = 'P0001';
  end if;
  update public.pm_positions
     set mark = v_mark, mark_at = coalesce((p->>'mark_at')::timestamptz, now()), updated_at = now(),
         meta = coalesce(meta, '{}'::jsonb) || coalesce(p->'meta_patch', '{}'::jsonb)
   where id = (p->>'position_id')::uuid and status = 'open';
  get diagnostics v_n = row_count;
  return jsonb_build_object('position_id', p->>'position_id', 'updated', v_n);
end;
$$;

-- The exit ledger block for one sell order, in one transaction:
--   the sell pm_orders row (found by venue order id, else inserted), the lot's entry fills (linked; the
--   piece the 10/4 closes were missing), the exit fills (linked), then the lot reduced or closed. Closing
--   requires linked buys = linked sells so trade_outcome_capture writes realized_pnl from fills; a close
--   without matching buys is refused unless allow_unpriced with an unpriced_reason. Optional pm_pnl row.
create or replace function public.oddsborne_exit_record(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pid uuid := (p->>'position_id')::uuid;
  v_pos public.pm_positions%rowtype;
  o jsonb := coalesce(p->'order', '{}'::jsonb);
  v_vo text := o->>'venue_order_id';
  v_order uuid;
  v_side text;
  f jsonb;
  v_buy_order uuid;
  v_fill uuid;
  v_entry jsonb := '[]'::jsonb;
  v_exit jsonb := '[]'::jsonb;
  v_buy_q numeric;
  v_sell_q numeric;
  v_last_px numeric;
  v_last_at timestamptz;
  v_remaining numeric;
  v_action text;
  v_eps numeric;
  v_unreal numeric;
  v_pnl uuid;
  v_to record;
begin
  select * into v_pos from public.pm_positions where id = v_pid for update;
  if not found then
    raise exception 'refusal:input: pm position % not found', v_pid using errcode = 'P0001';
  end if;
  if v_pos.status <> 'open' then
    raise exception 'refusal:state: position % is already %', v_pid, v_pos.status using errcode = 'P0001';
  end if;
  if v_vo is null then
    raise exception 'refusal:input: order.venue_order_id is required' using errcode = 'P0001';
  end if;

  -- 1. the sell order
  select id, side into v_order, v_side from public.pm_orders
   where account_key = v_pos.account_key and venue_order_id = v_vo and market_id = v_pos.market_id
   order by created_at desc limit 1;
  if found then
    if v_side <> 'sell' then
      raise exception 'refusal:input: venue order % is a % order, not a sell', v_vo, v_side using errcode = 'P0001';
    end if;
    update public.pm_orders
       set status = coalesce(o->>'status', status), updated_at = now(),
           payload = coalesce(payload, '{}'::jsonb) || coalesce(o->'payload', '{}'::jsonb)
     where id = v_order;
  else
    insert into public.pm_orders (market_id, account_key, thesis_id, outcome, side, order_type, size, price,
                                  status, mode, venue_order_id, rationale, kill_criteria, gate_results,
                                  payload, submitted_at)
    values (v_pos.market_id, v_pos.account_key, v_pos.thesis_id, v_pos.outcome, 'sell',
            coalesce(o->>'order_type', 'fak'), (o->>'size')::numeric, (o->>'price')::numeric,
            coalesce(o->>'status', 'submitted'), 'live', v_vo, o->>'rationale', v_pos.kill_criteria,
            coalesce(o->'gate_results', '{}'::jsonb), coalesce(o->'payload', '{}'::jsonb),
            coalesce((o->>'submitted_at')::timestamptz, now()))
    returning id into v_order;
  end if;

  -- 2. entry fills: each must belong to one of this lot's buy orders; link it to the lot
  for f in select value from jsonb_array_elements(coalesce(p->'entry_fills', '[]'::jsonb)) loop
    if f->>'side' <> 'buy' or f->>'outcome' <> v_pos.outcome then
      raise exception 'refusal:input: entry fill % must be a % buy', f->>'venue_fill_id', v_pos.outcome using errcode = 'P0001';
    end if;
    select id into v_buy_order from public.pm_orders
     where account_key = v_pos.account_key and venue_order_id = f->>'venue_order_id'
       and market_id = v_pos.market_id and side = 'buy' and outcome = v_pos.outcome
     order by created_at desc limit 1;
    if not found then
      raise exception 'refusal:fills: entry fill % is on venue order %, which has no buy row in pm_orders for this lot',
        f->>'venue_fill_id', f->>'venue_order_id' using errcode = 'P0001';
    end if;
    v_fill := null;
    insert into public.pm_fills (order_id, position_id, account_key, venue_fill_id, venue_order_id, outcome,
                                 side, quantity, price, fee, executed_at, payload)
    values (v_buy_order, v_pid, v_pos.account_key, f->>'venue_fill_id', f->>'venue_order_id', v_pos.outcome,
            'buy', (f->>'quantity')::numeric, (f->>'price')::numeric, coalesce((f->>'fee')::numeric, 0),
            (f->>'executed_at')::timestamptz, coalesce(f->'payload', '{}'::jsonb))
    on conflict (account_key, venue_fill_id) do nothing
    returning id into v_fill;
    if v_fill is null then  -- already recorded: link it if it isn't linked yet
      update public.pm_fills set position_id = v_pid
       where account_key = v_pos.account_key and venue_fill_id = f->>'venue_fill_id' and position_id is null
      returning id into v_fill;
      v_entry := v_entry || jsonb_build_array(jsonb_build_object(
        'venue_fill_id', f->>'venue_fill_id', 'inserted', false, 'linked', v_fill is not null));
    else
      v_entry := v_entry || jsonb_build_array(jsonb_build_object(
        'venue_fill_id', f->>'venue_fill_id', 'inserted', true, 'linked', true));
    end if;
  end loop;

  -- 3. exit fills on the sell order
  for f in select value from jsonb_array_elements(coalesce(p->'exit_fills', '[]'::jsonb)) loop
    if f->>'side' <> 'sell' or f->>'outcome' <> v_pos.outcome then
      raise exception 'refusal:input: exit fill % must be a % sell', f->>'venue_fill_id', v_pos.outcome using errcode = 'P0001';
    end if;
    v_fill := null;
    insert into public.pm_fills (order_id, position_id, account_key, venue_fill_id, venue_order_id, outcome,
                                 side, quantity, price, fee, executed_at, payload)
    values (v_order, v_pid, v_pos.account_key, f->>'venue_fill_id', v_vo, v_pos.outcome, 'sell',
            (f->>'quantity')::numeric, (f->>'price')::numeric, coalesce((f->>'fee')::numeric, 0),
            (f->>'executed_at')::timestamptz, coalesce(f->'payload', '{}'::jsonb))
    on conflict (account_key, venue_fill_id) do nothing
    returning id into v_fill;
    v_exit := v_exit || jsonb_build_array(jsonb_build_object('venue_fill_id', f->>'venue_fill_id',
                                                             'inserted', v_fill is not null));
  end loop;

  -- 4. what the linked fills say
  select coalesce(sum(quantity) filter (where side = 'buy'), 0), coalesce(sum(quantity) filter (where side = 'sell'), 0)
    into v_buy_q, v_sell_q
  from public.pm_fills where position_id = v_pid;
  select price, executed_at into v_last_px, v_last_at
  from public.pm_fills where position_id = v_pid and side = 'sell' order by executed_at desc limit 1;
  v_eps := greatest(v_buy_q, 1) * 0.000001;
  v_remaining := case when v_buy_q > 0 then v_buy_q - v_sell_q else coalesce(v_pos.quantity, 0) - v_sell_q end;

  if v_sell_q <= 0 then
    v_action := 'order_only';  -- resting / unfilled sell: order row recorded, lot untouched
  elsif v_remaining <= v_eps then
    if v_buy_q <= 0 or abs(v_buy_q - v_sell_q) > v_eps then
      if not coalesce((p->>'allow_unpriced')::boolean, false) or length(btrim(coalesce(p->>'unpriced_reason', ''))) < 10 then
        raise exception 'refusal:fills_incomplete: lot % linked buys % vs sells %; pass the lot''s entry fills (pm_exit.py pulls them from portfolio.activities) or allow_unpriced with an unpriced_reason',
          v_pid, v_buy_q, v_sell_q using errcode = 'P0001';
      end if;
    end if;
    update public.pm_positions
       set status = 'closed', quantity = 0, closed_at = coalesce(v_last_at, now()),
           mark = coalesce(v_last_px, mark), mark_at = coalesce(v_last_at, now()), updated_at = now(),
           meta = coalesce(meta, '{}'::jsonb) || coalesce(p->'exit_meta', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
             'exit_reason', nullif(p->>'exit_reason', ''), 'closed_reason', nullif(p->>'exit_reason', ''),
             'exit_venue_order_id', v_vo, 'exit_pm_order_id', v_order, 'writer', 'pm_exit',
             'prior_qty', v_pos.quantity, 'unpriced_reason', nullif(p->>'unpriced_reason', '')))
     where id = v_pid;
    v_action := 'closed';
  else
    update public.pm_positions
       set quantity = v_remaining, mark = coalesce(v_last_px, mark), mark_at = coalesce(v_last_at, now()),
           updated_at = now(),
           meta = coalesce(meta, '{}'::jsonb) || coalesce(p->'exit_meta', '{}'::jsonb) || jsonb_build_object(
             'last_partial_exit', jsonb_build_object('venue_order_id', v_vo, 'sold_qty', v_sell_q,
                                                     'remaining', v_remaining, 'at', now(),
                                                     'reason', p->>'exit_reason'))
     where id = v_pid;
    v_action := 'reduced';
  end if;

  select o2.realized_pnl, o2.pnl_source, o2.id into v_to
  from public.trade_outcomes o2 where o2.source_table = 'pm_positions' and o2.source_id = v_pid::text;

  -- 5. optional book snapshot (cash from the venue)
  if (p->>'cash') is not null then
    select coalesce(sum(quantity * coalesce(mark, average_cost, 0)), 0) into v_unreal
    from public.pm_positions where account_key = v_pos.account_key and status = 'open';
    insert into public.pm_pnl (account_key, as_of, realized, unrealized, fees, cash, equity, notes, payload)
    values (v_pos.account_key, coalesce((p->>'as_of')::timestamptz, now()),
            case when v_action = 'closed' then coalesce(v_to.realized_pnl, 0) else 0 end,
            v_unreal, 0, (p->>'cash')::numeric, (p->>'cash')::numeric + v_unreal, p->>'pnl_notes',
            coalesce(p->'pnl_payload', '{}'::jsonb) || jsonb_build_object('writer', 'pm_exit', 'position_id', v_pid))
    returning id into v_pnl;
  end if;

  return jsonb_build_object(
    'position_id', v_pid, 'action', v_action, 'pm_order_id', v_order,
    'linked_buy_qty', v_buy_q, 'linked_sell_qty', v_sell_q,
    'remaining', case when v_action = 'closed' then 0 else greatest(v_remaining, 0) end,
    'entry_fills', v_entry, 'exit_fills', v_exit,
    'trade_outcome_id', v_to.id, 'realized_pnl', v_to.realized_pnl, 'pnl_source', v_to.pnl_source,
    'pm_pnl_id', v_pnl);
end;
$$;

-- A book snapshot (standups, sessions): cash from the venue; unrealized from open lots' marks unless the
-- caller passes the venue's equity. The pm_pnl trigger touches the ODDSBORNE heartbeat.
create or replace function public.oddsborne_pnl_snapshot(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_acct text := coalesce(nullif(p->>'account_key', ''), 'polymarket-us-primary');
  v_cash numeric := (p->>'cash')::numeric;
  v_unreal numeric;
  v_open integer;
  v_equity numeric;
  v_pnl uuid;
begin
  if v_cash is null or v_cash < 0 then
    raise exception 'refusal:input: cash (venue balance) is required' using errcode = 'P0001';
  end if;
  select coalesce(sum(quantity * coalesce(mark, average_cost, 0)), 0), count(*) into v_unreal, v_open
  from public.pm_positions where account_key = v_acct and status = 'open';
  v_equity := coalesce((p->>'equity')::numeric, v_cash + v_unreal);
  insert into public.pm_pnl (account_key, as_of, realized, unrealized, fees, cash, equity, notes, payload)
  values (v_acct, coalesce((p->>'as_of')::timestamptz, now()), coalesce((p->>'realized')::numeric, 0), v_unreal,
          coalesce((p->>'fees')::numeric, 0), v_cash, v_equity, p->>'notes', coalesce(p->'payload', '{}'::jsonb))
  returning id into v_pnl;
  return jsonb_build_object('pm_pnl_id', v_pnl, 'cash', v_cash, 'unrealized', v_unreal, 'equity', v_equity,
                            'open_count', v_open);
end;
$$;

-- ------------------------------------------------------------------ grants (worker role + service_role only)
revoke all on function public.steward_close_lesson(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_position_get(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_open_positions(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_mark_position(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_exit_open_order(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_exit_record_fill(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_annotate_pnl(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_pnl_snapshot(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_position_get(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_open_positions(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_order_get(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_order_set_status(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_mark_position(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_exit_record(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_pnl_snapshot(jsonb) from public, anon, authenticated;

grant execute on function public.steward_close_lesson(jsonb) to oddsborne_worker, bandit_worker, service_role;
grant execute on function public.bandit_position_get(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_open_positions(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_mark_position(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_exit_open_order(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_exit_record_fill(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_annotate_pnl(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_pnl_snapshot(jsonb) to bandit_worker, service_role;
grant execute on function public.oddsborne_position_get(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_open_positions(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_order_get(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_order_set_status(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_mark_position(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_exit_record(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_pnl_snapshot(jsonb) to oddsborne_worker, service_role;
