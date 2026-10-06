-- Steward entry RPCs: the ledger writes of BANDIT live_trade_clip.py and ODDSBORNE pm_enter.py as
-- SQL functions, so the scripts can make them over HTTPS (edge function steward-rpc) instead of a raw
-- Postgres connection. The agent box egresses HTTPS only; the Supavisor pooler (5432/6543) times out.
--
-- Every function is SECURITY INVOKER and takes/returns one jsonb. steward-rpc logs in AS the steward's
-- worker role, so the grants, RLS, triggers (private.require_lot_invalidation, the max_stake_at_entry
-- snapshot) and the sizing gates in public.steward_sizing_guidance apply exactly as on the old
-- psycopg path. Each function is the same SQL the script ran, in the same transaction boundaries.
-- A refusal raises 'refusal:<gate>: <reason>' (SQLSTATE P0001); the scripts turn it into a REFUSED.
-- Execute is granted only to the steward's own worker role and service_role.

-- ------------------------------------------------------------------ shared: sizing guidance
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
  -- A worker may only ask for its own steward's guidance.
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
    (p->>'entry_price')::numeric
  ) g
  limit 1;
  return r;  -- null when guidance returns no row (the scripts refuse)
end;
$$;

comment on function public.steward_entry_guidance(jsonb) is
  'jsonb wrapper over steward_sizing_guidance(steward, thesis_id, instrument, requested, invalidation_price, entry_price) for the HTTPS steward path. Same gates; a worker can only ask for its own steward.';

-- ------------------------------------------------------------------ ODDSBORNE (pm_enter.py)
create or replace function public.oddsborne_entry_upsert_market(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_slug text := p->>'slug';
  v_yes text := p->>'yes_side_id';
  v_no text := p->>'no_side_id';
  v_id uuid;
  v_y text;
  v_n text;
begin
  if v_slug is null or v_yes is null or v_no is null then
    raise exception 'refusal:input: slug, yes_side_id and no_side_id are required' using errcode = 'P0001';
  end if;
  select id, yes_token_id, no_token_id into v_id, v_y, v_n
  from public.pm_markets where slug = v_slug order by created_at limit 1;
  if found then
    if (nullif(v_y, '') is not null and v_y <> v_yes) or (nullif(v_n, '') is not null and v_n <> v_no) then
      raise exception 'refusal:market: pm_markets side ids %/% disagree with venue %/% for %',
        v_y, v_n, v_yes, v_no, v_slug using errcode = 'P0001';
    end if;
    update public.pm_markets
       set yes_token_id = v_yes, no_token_id = v_no,
           condition_id = coalesce(condition_id, p->>'venue_market_id'),
           close_time = coalesce(close_time, (p->>'close_time')::timestamptz),
           meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('venue_ids', p->'venue_ids'),
           updated_at = now()
     where id = v_id;
  else
    insert into public.pm_markets (venue, condition_id, slug, question, status, close_time,
                                   yes_token_id, no_token_id, meta)
    values ('polymarket', p->>'venue_market_id', v_slug, coalesce(nullif(p->>'question', ''), v_slug), 'open',
            (p->>'close_time')::timestamptz, v_yes, v_no, jsonb_build_object('venue_ids', p->'venue_ids'))
    returning id into v_id;
  end if;
  return jsonb_build_object('pm_market_id', v_id);
end;
$$;

create or replace function public.oddsborne_entry_record_order(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.pm_orders (market_id, account_key, thesis_id, outcome, side, order_type, size, price,
         status, mode, venue_order_id, rationale, kill_criteria, my_probability, book_probability,
         edge_after_costs, gate_results, payload, submitted_at,
         max_stake_at_entry, max_stake_reason_at_entry)
  values ((p->>'market_id')::uuid, p->>'account_key', p->>'thesis_id', p->>'outcome', 'buy', p->>'order_type',
          (p->>'size')::numeric, (p->>'price')::numeric, p->>'status', 'live', p->>'venue_order_id',
          p->>'rationale', p->>'kill_criteria', (p->>'my_probability')::numeric,
          (p->>'book_probability')::numeric, (p->>'edge_after_costs')::numeric,
          coalesce(p->'gate_results', '{}'::jsonb), coalesce(p->'payload', '{}'::jsonb),
          coalesce((p->>'submitted_at')::timestamptz, now()),
          (p->>'max_stake_at_entry')::numeric, p->>'max_stake_reason_at_entry')
  returning id into v_id;
  return jsonb_build_object('pm_order_id', v_id);
end;
$$;

-- Fills for one order, idempotent on (account_key, venue_fill_id). Links each fill to the single open
-- lot on (account, market, outcome) when exactly one exists, as pm_enter did.
create or replace function public.oddsborne_entry_record_fills(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  f jsonb;
  v_pos uuid[];
  v_fill uuid;
  v_result jsonb := '[]'::jsonb;
begin
  for f in select value from jsonb_array_elements(coalesce(p->'fills', '[]'::jsonb)) loop
    select array_agg(id) into v_pos from public.pm_positions
     where account_key = p->>'account_key' and market_id = (p->>'market_id')::uuid
       and outcome = f->>'outcome' and status = 'open';
    v_fill := null;
    insert into public.pm_fills (order_id, position_id, account_key, venue_fill_id, venue_order_id, outcome,
                                 side, quantity, price, fee, executed_at, payload)
    values ((p->>'pm_order_id')::uuid,
            case when cardinality(v_pos) = 1 then v_pos[1] end,
            p->>'account_key', f->>'venue_fill_id', f->>'venue_order_id', f->>'outcome', f->>'side',
            (f->>'quantity')::numeric, (f->>'price')::numeric, coalesce((f->>'fee')::numeric, 0),
            (f->>'executed_at')::timestamptz, coalesce(f->'payload', '{}'::jsonb))
    on conflict (account_key, venue_fill_id) do nothing
    returning id into v_fill;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'venue_fill_id', f->>'venue_fill_id', 'inserted', v_fill is not null, 'pm_fill_id', v_fill));
  end loop;
  return v_result;
end;
$$;

-- Open (or add to) the pm_positions lot for this order's newly inserted buy fills and link them.
create or replace function public.oddsborne_entry_upsert_position(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_qty numeric := (p->>'fill_qty')::numeric;
  v_px numeric := (p->>'fill_avg_px')::numeric;
  v_pos uuid;
  v_q0 numeric;
  v_a0 numeric;
  v_new_q numeric;
  v_new_avg numeric;
  v_action text;
  v_linked integer;
begin
  if v_qty is null or v_qty <= 0 then
    return jsonb_build_object('action', 'none', 'reason', 'no newly inserted fills');
  end if;
  select id, quantity, average_cost into v_pos, v_q0, v_a0
  from public.pm_positions
  where account_key = p->>'account_key' and market_id = (p->>'market_id')::uuid
    and outcome = p->>'outcome' and status = 'open'
  limit 1
  for update;
  if found then
    v_q0 := coalesce(v_q0, 0);
    v_new_q := v_q0 + v_qty;
    v_new_avg := case when v_a0 is not null or v_q0 = 0
                      then (coalesce(v_q0 * v_a0, 0) + v_qty * v_px) / v_new_q end;
    update public.pm_positions
       set quantity = v_new_q, average_cost = coalesce(v_new_avg, average_cost),
           invalidation_price = coalesce(invalidation_price, (p->>'invalidation_price')::numeric),
           invalidation_note = coalesce(invalidation_note, nullif(p->>'invalidation_note', '')),
           thesis_id = coalesce(thesis_id, p->>'thesis_id'), updated_at = now()
     where id = v_pos;
    v_action := 'added';
  else
    insert into public.pm_positions (market_id, account_key, thesis_id, outcome, status, quantity,
                                     average_cost, opened_at, kill_criteria, invalidation_price,
                                     invalidation_note, meta)
    values ((p->>'market_id')::uuid, p->>'account_key', p->>'thesis_id', p->>'outcome', 'open', v_qty, v_px,
            now(), nullif(p->>'kill_criteria', ''), (p->>'invalidation_price')::numeric,
            nullif(p->>'invalidation_note', ''),
            jsonb_build_object('writer', 'pm_enter', 'pm_order_id', p->>'pm_order_id'))
    returning id into v_pos;
    v_action := 'opened';
  end if;
  update public.pm_fills set position_id = v_pos
   where order_id = (p->>'pm_order_id')::uuid and position_id is null;
  get diagnostics v_linked = row_count;
  return jsonb_build_object('action', v_action, 'position_id', v_pos, 'fill_qty', v_qty::text,
                            'fill_avg_px', v_px::text, 'fills_linked', v_linked);
end;
$$;

create or replace function public.oddsborne_entry_heartbeat(p jsonb default '{}'::jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object('heartbeat_at', public.oddsborne_touch_heartbeat());
$$;

-- ------------------------------------------------------------------ BANDIT (live_trade_clip.py, paper_bank20.py)
-- Token row (find by mint, else insert) and the 'submitted' live buy order, in one transaction.
create or replace function public.bandit_entry_open_order(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_token uuid;
  v_order uuid;
begin
  select id into v_token from public.meme_tokens where mint = p->>'mint' limit 1;
  if found then
    update public.meme_tokens
       set symbol = coalesce(symbol, p->>'symbol'), name = coalesce(name, p->>'name'),
           kill_criteria = p->>'kill_criteria', updated_at = now()
     where id = v_token;
  else
    insert into public.meme_tokens (venue, mint, symbol, name, status, kill_criteria, meta)
    values ('jupiter', p->>'mint', p->>'symbol', p->>'name', 'watch', p->>'kill_criteria',
            jsonb_build_object('source', 'live_trade_clip', 'name', p->>'name'))
    returning id into v_token;
  end if;
  insert into public.meme_orders (token_id, account_key, thesis_id, side, order_type, size_sol,
                                  status, mode, kill_criteria, rationale, gate_results, payload, submitted_at,
                                  max_stake_at_entry, max_stake_reason_at_entry)
  values (v_token, p->>'account_key', p->>'thesis_id', 'buy', 'market', (p->>'size_sol')::numeric,
          'submitted', 'live', p->>'kill_criteria', p->>'rationale',
          coalesce(p->'gate_results', '{}'::jsonb), coalesce(p->'payload', '{}'::jsonb), now(),
          (p->>'max_stake_at_entry')::numeric, p->>'max_stake_reason_at_entry')
  returning id into v_order;
  return jsonb_build_object('order_id', v_order, 'token_id', v_token);
end;
$$;

create or replace function public.bandit_entry_reject_order(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  update public.meme_orders
     set status = 'rejected', updated_at = now(), payload = payload || coalesce(p->'payload', '{}'::jsonb)
   where id = (p->>'order_id')::uuid;
  get diagnostics v_n = row_count;
  return jsonb_build_object('order_id', p->>'order_id', 'updated', v_n);
end;
$$;

-- The post-swap ledger block: order -> filled, open or add to the lot, the fill, a meme_pnl row, the
-- heartbeat (skipped when grants don't allow it), then the thesis/opened_at read for the 4h deadline.
create or replace function public.bandit_entry_record_fill(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order uuid := (p->>'order_id')::uuid;
  v_token uuid := (p->>'token_id')::uuid;
  v_acct text := p->>'account_key';
  v_thesis text := p->>'thesis_id';
  v_sig text := p->>'signature';
  v_entry numeric := (p->>'entry_price')::numeric;
  v_out numeric := (p->>'out_tokens')::numeric;
  v_cash numeric := (p->>'cash_sol')::numeric;
  v_pos uuid;
  v_old_q numeric;
  v_old_avg numeric;
  v_new_q numeric;
  v_new_avg numeric;
  v_fill uuid;
  v_unreal numeric;
  v_pnl uuid;
  v_hb uuid;
  v_hb_err text;
  v_thesis_db text;
  v_opened timestamptz;
begin
  update public.meme_orders
     set status = 'filled', signature = v_sig, price_sol = v_entry, size_tokens = v_out, updated_at = now(),
         payload = payload || coalesce(p->'order_payload', '{}'::jsonb)
   where id = v_order;

  select id, coalesce(quantity, 0), coalesce(average_cost_sol, 0) into v_pos, v_old_q, v_old_avg
  from public.meme_positions
  where token_id = v_token and account_key = v_acct and status = 'open'
  order by created_at desc limit 1;
  if found then
    v_new_q := v_old_q + v_out;
    v_new_avg := case when v_new_q <> 0 and v_entry is not null
                      then (v_old_avg * v_old_q + v_entry * v_out) / v_new_q else v_entry end;
    update public.meme_positions
       set quantity = v_new_q, average_cost_sol = v_new_avg, mark_sol = v_entry, mark_at = now(),
           kill_criteria = p->>'kill_criteria', updated_at = now(), thesis_id = coalesce(thesis_id, v_thesis),
           meta = meta || jsonb_build_object('last_sig', v_sig, 'mint', p->>'mint')
     where id = v_pos;
  else
    insert into public.meme_positions (token_id, account_key, thesis_id, status, quantity, average_cost_sol,
                                       mark_sol, mark_at, opened_at, kill_criteria, meta,
                                       invalidation_price, invalidation_note)
    values (v_token, v_acct, v_thesis, 'open', v_out, v_entry, v_entry, now(), now(), p->>'kill_criteria',
            jsonb_build_object('mint', p->>'mint', 'symbol', p->>'symbol', 'entry_sig', v_sig, 'thesis', v_thesis),
            (p->>'invalidation_price')::numeric, p->>'invalidation_note')
    returning id into v_pos;
  end if;

  insert into public.meme_fills (order_id, position_id, account_key, venue_fill_id, venue_order_id,
                                 side, quantity, price_sol, fee_sol, executed_at, payload)
  values (v_order, v_pos, v_acct, v_sig, p->>'venue_order_id', 'buy', v_out, coalesce(v_entry, 0),
          coalesce((p->>'fee_sol')::numeric, 0), now(), coalesce(p->'fill_payload', '{}'::jsonb))
  returning id into v_fill;

  select coalesce(sum(quantity * coalesce(mark_sol, average_cost_sol, 0)), 0) into v_unreal
  from public.meme_positions where account_key = v_acct and status = 'open';

  insert into public.meme_pnl (account_key, as_of, realized, unrealized, fees, cash_sol, equity_sol, notes, payload)
  values (v_acct, coalesce((p->>'as_of')::timestamptz, now()), 0, v_unreal, 0, v_cash, v_cash + v_unreal,
          p->>'pnl_notes', coalesce(p->'pnl_payload', '{}'::jsonb))
  returning id into v_pnl;

  begin  -- subtransaction = the old SAVEPOINT hb
    update public.desk_agents set heartbeat_at = now(), updated_at = now() where slug = 'bandit' returning id into v_hb;
  exception when others then
    v_hb := null;
    v_hb_err := sqlerrm;
  end;

  update public.meme_positions set thesis_id = v_thesis where id = v_pos and thesis_id is distinct from v_thesis;
  select thesis_id, opened_at into v_thesis_db, v_opened from public.meme_positions where id = v_pos;

  return jsonb_build_object(
    'order_id', v_order, 'position_id', v_pos, 'fill_id', v_fill, 'pnl_id', v_pnl,
    'unrealized', v_unreal, 'equity_sol', v_cash + v_unreal,
    'heartbeat_updated', v_hb is not null, 'heartbeat_skipped', v_hb_err,
    'thesis_id', v_thesis_db, 'opened_at', v_opened);
end;
$$;

-- paper_bank20.py: the lot and its 5-minute venue marks (read-only) ...
create or replace function public.bandit_shadow_exit_marks(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'opened_at', mp.opened_at, 'status', mp.status, 'symbol', t.symbol,
    'marks', coalesce((
      select jsonb_agg(jsonb_build_array(x.as_of, (x.payload->>'pnl_pct_vs_entry')::numeric) order by x.as_of)
      from public.meme_pnl x
      where x.payload->>'position_id' = p->>'position_id' and x.payload ? 'pnl_pct_vs_entry'
    ), '[]'::jsonb))
  from public.meme_positions mp
  join public.meme_tokens t on t.id = mp.token_id
  where mp.id = (p->>'position_id')::uuid;
$$;

-- ... and the write of one meta.paper_<rule> object (overwrites only its own key).
create or replace function public.bandit_write_shadow_exit(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_key text := p->>'key';
  v_n integer;
begin
  if v_key is null or v_key !~ '^paper_[a-z0-9_]{1,40}$' then
    raise exception 'refusal:input: shadow-exit key must match paper_<name>, got %', v_key using errcode = 'P0001';
  end if;
  if jsonb_typeof(p->'value') is distinct from 'object' then
    raise exception 'refusal:input: shadow-exit value must be an object' using errcode = 'P0001';
  end if;
  update public.meme_positions
     set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(v_key, p->'value')
   where id = (p->>'position_id')::uuid;
  get diagnostics v_n = row_count;
  return jsonb_build_object('position_id', p->>'position_id', 'key', v_key, 'updated', v_n);
end;
$$;

-- ------------------------------------------------------------------ grants (worker role + service_role only)
revoke all on function public.steward_entry_guidance(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_entry_upsert_market(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_entry_record_order(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_entry_record_fills(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_entry_upsert_position(jsonb) from public, anon, authenticated;
revoke all on function public.oddsborne_entry_heartbeat(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_entry_open_order(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_entry_reject_order(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_entry_record_fill(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_shadow_exit_marks(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_write_shadow_exit(jsonb) from public, anon, authenticated;

grant execute on function public.steward_entry_guidance(jsonb) to oddsborne_worker, bandit_worker, service_role;
grant execute on function public.oddsborne_entry_upsert_market(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_entry_record_order(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_entry_record_fills(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_entry_upsert_position(jsonb) to oddsborne_worker, service_role;
grant execute on function public.oddsborne_entry_heartbeat(jsonb) to oddsborne_worker, service_role;
grant execute on function public.bandit_entry_open_order(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_entry_reject_order(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_entry_record_fill(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_shadow_exit_marks(jsonb) to bandit_worker, service_role;
grant execute on function public.bandit_write_shadow_exit(jsonb) to bandit_worker, service_role;
