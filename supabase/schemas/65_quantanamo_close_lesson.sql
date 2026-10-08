-- QUANTANAMO close lessons through steward_close_lesson, with the same ledger-delta semantics.
--
-- 60 made a close lesson move confidence from the ledger (theses.results_confidence, else stated) by an
-- optional confidence_delta, and clamp a losing close so it can never raise confidence. The function only
-- knew BANDIT (meme_positions) and ODDSBORNE (pm_positions) lots and was granted to those two workers, so
-- QUANTANAMO wrote its 10/8 NBIS/CODA lessons by hand (belief_updates writer
-- 'close_lesson_equivalent_sql'; research_lessons 108-110). They are left as written; they match these
-- semantics.
--
-- 1. steward_close_lesson accepts steward 'quantanamo' and its equity lots (public.position_episodes; the
--    realized P&L is the trade_outcomes row with source_table 'position_episodes'). Same checks: the lot
--    exists and is closed, the thesis is the lot's, the prior is the ledger's, the delta moves from it,
--    and a losing close is clamped. As a worker role the steward is the role's own, so quantanamo_worker
--    can only write quantanamo lessons.
-- 2. dry_run: true runs every check and the arithmetic and returns what would be written; no row.
--    close_lesson.py --dry-run uses it (it read <steward>_position_get before, which QUANTANAMO lacks).
-- 3. EXECUTE to quantanamo_worker; steward-rpc allowlists steward_close_lesson for quantanamo_worker.
--
-- QUANTANAMO's call (SQL as quantanamo_worker or postgres, or steward-rpc as quantanamo_worker with
-- {"fn": "steward_close_lesson", "args": {...}}; 'steward' is required only for a non-worker role):
--   select public.steward_close_lesson(jsonb_build_object('steward', 'quantanamo',
--     'position_id', '<position_episodes.id>', 'confidence_delta', -3,
--     'rationale', '<what this close taught, >= 20 chars>'));   -- add 'dry_run', true to preview

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
  v_dry boolean := coalesce((p->>'dry_run')::boolean, false);
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
  elsif v_steward = 'quantanamo' then
    -- 65: QUANTANAMO's equity lots (Robinhood); their trade_outcomes rows carry source_table 'position_episodes'.
    v_table := 'position_episodes';
    select thesis_id, status, closed_at into v_lot_thesis, v_status, v_closed from public.position_episodes where id = v_lot;
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
  -- 65: dry_run runs every check and the same arithmetic, and writes nothing.
  if v_dry then
    return jsonb_build_object('dry_run', true, 'would_write', 'belief_updates', 'steward', v_steward,
                              'lot_table', v_table, 'lot_id', v_lot, 'thesis_id', v_thesis, 'kind', v_kind,
                              'prior_confidence', v_prior, 'new_confidence', v_new,
                              'requested_new_confidence', case when v_asked is distinct from v_new then v_asked end,
                              'confidence_delta', v_delta, 'lot_closed_at', v_closed,
                              'lot_realized_pnl', v_pnl, 'clamped', v_clamp);
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

revoke all on function public.steward_close_lesson(jsonb) from public, anon, authenticated;
grant execute on function public.steward_close_lesson(jsonb) to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
