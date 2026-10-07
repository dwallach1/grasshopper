-- Small steward fixes, and close lessons that could raise confidence after a loss.
--
-- 1. decision_candidates 09d47e24 is the same ODDSBORNE CLE YES pass as 9dcd9f35 (same steward,
--    instrument, side, price and probability, logged 37 s apart under two source_ids): superseded,
--    as 59 did for duplicates. Not deleted.
-- 2. Heartbeats: steward-rpc always calls fn(p jsonb), so the zero-arg oddsborne_touch_heartbeat()
--    could not be reached; oddsborne_worker and bandit_worker also had only SELECT on desk_agents, so
--    their row-scoped UPDATE policies never applied (bandit_mark_position's heartbeat was skipped).
--    Each steward gets <steward>_touch_heartbeat(p jsonb) and UPDATE (heartbeat_at, updated_at).
-- 3. desk_rules: the worker roles already have SELECT and an RLS read policy; over HTTPS there was no
--    callable function, so steward_desk_rules(p jsonb) reads them.
-- 4. steward_close_lesson took new_confidence as an absolute number from the steward's notes, and its
--    prior from prior_confidence or, since workers can't read theses under RLS, the latest belief
--    update. BANDIT's Agency lesson (lot 41a2cf67, a -0.0313 SOL loss) wrote 57 over a ledger 47, and
--    belief_update_sync_thesis copied 57 into theses.stated_confidence. Sizing never read it: the
--    gates and edge stake read theses.results_confidence (the outcome re-score, 47), and
--    theses.confidence shows results_confidence once scored. stated_confidence is the steward's
--    display number. Now the prior is always the ledger's (results_confidence, else stated), the
--    caller can send confidence_delta, and a losing close is clamped to at most the prior.

create or replace function private.thesis_ledger_confidence(p_thesis text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(t.results_confidence, t.stated_confidence, t.confidence)::numeric
  from public.theses t where t.id = p_thesis;
$$;

create or replace function private.lot_realized_pnl(p_table text, p_lot uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select o.realized_pnl from public.trade_outcomes o
  where o.source_table = p_table and o.source_id = p_lot::text
  order by o.closed_at desc nulls last limit 1;
$$;

revoke all on function private.thesis_ledger_confidence(text) from public, anon, authenticated;
revoke all on function private.lot_realized_pnl(text, uuid) from public, anon, authenticated;
grant execute on function private.thesis_ledger_confidence(text) to oddsborne_worker, bandit_worker, quantanamo_worker, service_role;
grant execute on function private.lot_realized_pnl(text, uuid) to oddsborne_worker, bandit_worker, quantanamo_worker, service_role;

-- ——— close lessons ———

create or replace function public.steward_close_lesson(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
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
  v_delta numeric := (p->>'confidence_delta')::numeric;
  v_asked numeric;
  v_pnl numeric;
  v_clamp text;
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
  if v_new is not null and v_delta is not null then
    raise exception 'refusal:input: pass new_confidence or confidence_delta, not both' using errcode = 'P0001';
  end if;
  if v_new is not null and (v_new < 1 or v_new > 100) then
    raise exception 'refusal:input: new_confidence is on the 1-100 scale, got %', v_new using errcode = 'P0001';
  end if;
  -- 60: the prior is always the ledger's current number (the one sizing reads), never the caller's;
  -- a lesson moves confidence relative to it, and a losing close can never raise it.
  v_prior := private.thesis_ledger_confidence(v_thesis);
  if v_delta is not null then
    v_new := case when v_prior is null then null else v_prior + v_delta end;
  end if;
  v_asked := v_new;
  v_pnl := private.lot_realized_pnl(v_table, v_lot);
  if v_new is not null and v_prior is not null and v_pnl < 0 and v_new > v_prior then
    v_new := v_prior;
    v_clamp := 'losing close: confidence cannot rise above the ledger value';
  end if;
  if v_new is not null then
    v_new := least(greatest(v_new, 1), 100);
  end if;
  insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
  values (v_thesis, v_prior, v_new, btrim(p->>'rationale'), now(),
          coalesce(p->'meta', '{}'::jsonb) || jsonb_build_object(
            'kind', v_kind, 'steward', v_steward, 'lot_table', v_table, 'lot_id', v_lot,
            'lot_closed_at', v_closed, 'writer', 'close_lesson')
          || jsonb_strip_nulls(jsonb_build_object(
            'prior_source', 'ledger (theses results_confidence, else stated)',
            'caller_prior_confidence', p->'prior_confidence',
            'requested_new_confidence', case when v_asked is distinct from v_new then v_asked end,
            'confidence_delta', v_delta, 'lot_realized_pnl', v_pnl, 'clamped', v_clamp)))
  returning id into v_id;
  return jsonb_build_object('belief_update_id', v_id, 'thesis_id', v_thesis, 'kind', v_kind,
                            'prior_confidence', v_prior, 'new_confidence', v_new, 'lot_closed_at', v_closed,
                            'lot_realized_pnl', v_pnl, 'clamped', v_clamp);
end;
$$;

-- ——— heartbeats ———

grant update (heartbeat_at, updated_at) on public.desk_agents to oddsborne_worker, bandit_worker;

create or replace function public.oddsborne_touch_heartbeat(p jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object('heartbeat_at', public.oddsborne_touch_heartbeat());
$$;

create or replace function public.bandit_touch_heartbeat(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
begin
  update public.desk_agents set heartbeat_at = now(), updated_at = now()
   where slug = 'bandit' returning heartbeat_at into v_at;
  return jsonb_build_object('heartbeat_at', v_at);
end;
$$;

create or replace function public.quantanamo_touch_heartbeat(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
begin
  update public.desk_agents set heartbeat_at = now(), updated_at = now()
   where slug = 'quantanamo' returning heartbeat_at into v_at;
  return jsonb_build_object('heartbeat_at', v_at);
end;
$$;

revoke all on function public.oddsborne_touch_heartbeat(jsonb) from public, anon, authenticated;
revoke all on function public.bandit_touch_heartbeat(jsonb) from public, anon, authenticated;
revoke all on function public.quantanamo_touch_heartbeat(jsonb) from public, anon, authenticated;
grant execute on function public.oddsborne_touch_heartbeat(jsonb) to oddsborne_worker, service_role;
grant execute on function public.bandit_touch_heartbeat(jsonb) to bandit_worker, service_role;
grant execute on function public.quantanamo_touch_heartbeat(jsonb) to quantanamo_worker, service_role;

-- ——— desk rules over HTTPS ———

create or replace function public.steward_desk_rules(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.rule_id), '[]'::jsonb)
  from public.desk_rules r
  where (nullif(p->>'rule_id', '') is null or r.rule_id = p->>'rule_id')
    and (nullif(p->>'status', '') is null or r.status = p->>'status');
$$;

revoke all on function public.steward_desk_rules(jsonb) from public, anon, authenticated;
grant execute on function public.steward_desk_rules(jsonb) to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— repairs ———

-- 1. the duplicate pass
update public.decision_candidates d
set meta = d.meta || jsonb_build_object('superseded', 'true', 'superseded_by', k.id,
                                        'superseded_why', 'duplicate log of the same pass (60)'),
    updated_at = now()
from public.decision_candidates k
where d.id = '09d47e24-6bc0-4881-82f7-ae85e4886a1c' and k.id = '9dcd9f35-07be-4d43-9d2d-2486c1c1bffe'
  and d.steward = k.steward and d.instrument = k.instrument and d.side = k.side
  and d.book_price = k.book_price and d.my_probability is not distinct from k.my_probability
  and abs(extract(epoch from d.decided_at - k.decided_at)) < 600
  and coalesce(d.meta->>'superseded', '') <> 'true';

-- 4. lessons that raised confidence after a losing close. Each is annotated; where it is still the
--    thesis's latest lesson its new_confidence goes back to its prior (the most the fixed rule allows)
--    and theses.stated_confidence follows.
with bad as (
  select b.id, b.thesis_id, b.prior_confidence, b.new_confidence, o.source_id as lot, o.realized_pnl,
    not exists (select 1 from public.belief_updates b2
                where b2.thesis_id = b.thesis_id and b2.id <> b.id and b2.new_confidence is not null
                  and coalesce(b2.meta->>'kind', '') <> 'outcome_rescore'
                  and b2.observed_at > b.observed_at) as latest
  from public.belief_updates b
  cross join lateral (
    select o.source_id, o.realized_pnl from public.trade_outcomes o
    where o.thesis_id = b.thesis_id
      and (o.source_id = b.meta->>'lot_id'
           or (b.meta->>'lot_id' is null and o.closed_at <= b.observed_at and o.closed_at > b.observed_at - interval '2 days'))
    order by o.closed_at desc limit 1) o
  where coalesce(b.meta->>'kind', '') <> 'outcome_rescore'
    and b.new_confidence > b.prior_confidence
    and o.realized_pnl < 0
    and not (b.meta ? 'correction_60')
)
update public.belief_updates b
set new_confidence = case when bad.latest then bad.prior_confidence else b.new_confidence end,
    meta = b.meta || jsonb_build_object('correction_60', jsonb_build_object(
      'was_new_confidence', bad.new_confidence, 'prior_confidence', bad.prior_confidence,
      'lot', bad.lot, 'lot_realized_pnl', bad.realized_pnl,
      'action', case when bad.latest then 'new_confidence set to prior (a loss cannot raise confidence)'
                     else 'flagged only: a later lesson already replaced it' end))
from bad
where b.id = bad.id;

update public.theses t
set stated_confidence = round(b.new_confidence)::smallint, updated_at = now()
from public.belief_updates b
where b.thesis_id = t.id
  and b.meta->'correction_60'->>'action' like 'new_confidence set%'
  and t.stated_confidence is distinct from round(b.new_confidence)::smallint;
