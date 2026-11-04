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
  v_symbol text;
  v_thesis text;
  v_prior numeric;
  v_new numeric := (p->>'new_confidence')::numeric;
  v_delta numeric := (p->>'confidence_delta')::numeric;
  v_asked numeric;
  v_pnl numeric;
  v_clamp text;
  v_id uuid;
  v_dry boolean := coalesce((p->>'dry_run')::boolean, false);
  v_lesson bigint;
  v_lesson_summary text := nullif(btrim(p->>'lesson_summary'), '');
  v_lesson_type text := nullif(btrim(p->>'lesson_type'), '');
  v_lesson_thesis text;
  v_cycle bigint;
  v_cycle_thesis text;
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
    select mp.thesis_id, mp.status, mp.closed_at, t.symbol
      into v_lot_thesis, v_status, v_closed, v_symbol
    from public.meme_positions mp
    left join public.meme_tokens t on t.id = mp.token_id
    where mp.id = v_lot;
  elsif v_steward = 'oddsborne' then
    v_table := 'pm_positions';
    select pp.thesis_id, pp.status, pp.closed_at,
           coalesce(nullif(btrim(m.slug), ''), nullif(btrim(pp.outcome), ''))
      into v_lot_thesis, v_status, v_closed, v_symbol
    from public.pm_positions pp
    left join public.pm_markets m on m.id = pp.market_id
    where pp.id = v_lot;
  elsif v_steward = 'quantanamo' then
    v_table := 'position_episodes';
    select thesis_id, status, closed_at, symbol
      into v_lot_thesis, v_status, v_closed, v_symbol
    from public.position_episodes where id = v_lot;
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
  if nullif(p->>'research_lesson_id', '') is not null and v_lesson_summary is not null then
    raise exception 'refusal:input: pass research_lesson_id or lesson_summary, not both' using errcode = 'P0001';
  end if;
  if nullif(p->>'research_lesson_id', '') is not null then
    if p->>'research_lesson_id' !~ '^[0-9]+$' then
      raise exception 'refusal:input: research_lesson_id must be the lesson id' using errcode = 'P0001';
    end if;
    v_lesson := (p->>'research_lesson_id')::bigint;
    select l.thesis_id into v_lesson_thesis
    from public.research_lessons l
    where l.id = v_lesson;
    if not found then
      raise exception 'refusal:input: research lesson % not found', v_lesson using errcode = 'P0001';
    end if;
    if v_lesson_thesis is distinct from v_thesis then
      raise exception 'refusal:input: research lesson % is on thesis %, not %', v_lesson, v_lesson_thesis, v_thesis
        using errcode = 'P0001';
    end if;
  elsif v_lesson_summary is not null then
    if length(v_lesson_summary) < 20 then
      raise exception 'refusal:input: lesson_summary (what the close taught, >= 20 chars) is required' using errcode = 'P0001';
    end if;
    if v_lesson_type is null or length(v_lesson_type) > 80 then
      raise exception 'refusal:input: lesson_type is required with lesson_summary' using errcode = 'P0001';
    end if;
    if coalesce(p->>'cycle_id', '') !~ '^[0-9]+$' then
      raise exception 'refusal:input: cycle_id is required with lesson_summary' using errcode = 'P0001';
    end if;
    v_cycle := (p->>'cycle_id')::bigint;
    select rc.thesis_id into v_cycle_thesis
    from public.research_cycles rc
    where rc.id = v_cycle;
    if not found then
      raise exception 'refusal:input: research cycle % not found', v_cycle using errcode = 'P0001';
    end if;
    if v_cycle_thesis is not null and v_cycle_thesis <> v_thesis then
      raise exception 'refusal:input: cycle % is on thesis %, not %', v_cycle, v_cycle_thesis, v_thesis
        using errcode = 'P0001';
    end if;
  elsif v_kind = 'trade_close_lesson' then
    v_lesson := private.match_trade_close_lesson(v_thesis, now(), v_symbol, null);
  end if;
  if v_dry then
    return jsonb_build_object('dry_run', true,
                              'would_write', case
                                when v_lesson_summary is not null then 'belief_updates,research_lessons'
                                else 'belief_updates'
                              end,
                              'steward', v_steward,
                              'lot_table', v_table, 'lot_id', v_lot, 'thesis_id', v_thesis, 'kind', v_kind,
                              'prior_confidence', v_prior, 'new_confidence', v_new,
                              'requested_new_confidence', case when v_asked is distinct from v_new then v_asked end,
                              'confidence_delta', v_delta, 'lot_closed_at', v_closed,
                              'lot_realized_pnl', v_pnl, 'clamped', v_clamp,
                              'research_lesson_id', v_lesson,
                              'symbol', v_symbol);
  end if;
  if v_lesson_summary is not null then
    insert into public.research_lessons (
      cycle_id, thesis_id, lesson_type, summary, incorporated, created_at
    ) values (
      v_cycle, v_thesis, v_lesson_type, v_lesson_summary, false, now()
    )
    returning id into v_lesson;
  end if;
  insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
  values (v_thesis, v_prior, v_new, btrim(p->>'rationale'), now(),
          coalesce(p->'meta', '{}'::jsonb) || jsonb_build_object(
            'kind', v_kind, 'steward', v_steward, 'lot_table', v_table, 'lot_id', v_lot,
            'lot_closed_at', v_closed, 'writer', 'close_lesson')
          || jsonb_strip_nulls(jsonb_build_object(
            'symbol', v_symbol,
            'research_lesson_id', v_lesson,
            'prior_source', 'ledger (theses results_confidence, else stated)',
            'caller_prior_confidence', p->'prior_confidence',
            'requested_new_confidence', case when v_asked is distinct from v_new then v_asked end,
            'confidence_delta', v_delta, 'lot_realized_pnl', v_pnl, 'clamped', v_clamp)))
  returning id into v_id;
  return jsonb_build_object('belief_update_id', v_id, 'thesis_id', v_thesis, 'kind', v_kind,
                            'prior_confidence', v_prior, 'new_confidence', v_new, 'lot_closed_at', v_closed,
                            'lot_realized_pnl', v_pnl, 'clamped', v_clamp,
                            'research_lesson_id', v_lesson);
end;
$$;

comment on function public.steward_close_lesson(jsonb) is
  'Close lesson for a steward lot. Moves confidence from the ledger and, for trade_close_lesson, stamps meta.research_lesson_id from the lesson written in this call or the one lesson within 10 minutes. dry_run writes nothing. A losing close cannot raise confidence.';

revoke all on function public.steward_close_lesson(jsonb) from public, anon, authenticated;
grant execute on function public.steward_close_lesson(jsonb) to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
