-- ODDSBORNE session pm_notes over HTTPS. session_daily.py / session_pm.py used to INSERT
-- public.pm_notes on a direct pooler connection, which times out from the box. steward-rpc
-- allowlists oddsborne_insert_note for oddsborne_worker and runs this function as that role
-- (SECURITY INVOKER), so the pm_notes grants, RLS, and the note triggers still apply.
-- One note per call. Columns are fixed; nothing in the payload is executed as SQL.
-- Execute is granted only to oddsborne_worker and service_role.

create or replace function public.oddsborne_insert_note(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_type text := p->>'note_type';
  v_title text := p->>'title';
  v_body text := p->>'body';
  v_decision text := nullif(p->>'decision', '');
  v_thesis text := nullif(p->>'thesis_id', '');
  v_market text := nullif(p->>'market_id', '');
  v_meta jsonb := coalesce(p->'meta', '{}'::jsonb);
  v_my numeric;
  v_book numeric;
  v_id uuid;
begin
  if v_type is null or v_type not in (
    'scan', 'skip', 'idea', 'thesis', 'kill', 'postmortem', 'lesson', 'other'
  ) then
    raise exception 'refusal:input: note_type must be scan, skip, idea, thesis, kill, postmortem, lesson, or other'
      using errcode = 'P0001';
  end if;
  if v_title is null or length(btrim(v_title)) = 0 or char_length(v_title) > 500 then
    raise exception 'refusal:input: title is required (1..500 chars)' using errcode = 'P0001';
  end if;
  if v_body is null or char_length(v_body) > 32000 then
    raise exception 'refusal:input: body is required (at most 32000 chars)' using errcode = 'P0001';
  end if;
  if v_decision is not null and v_decision not in ('skip', 'watch', 'enter', 'exit', 'hold') then
    raise exception 'refusal:input: decision must be skip, watch, enter, exit, hold, or null'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_meta) is distinct from 'object' then
    raise exception 'refusal:input: meta must be a JSON object' using errcode = 'P0001';
  end if;
  if octet_length(v_meta::text) > 400000 then
    raise exception 'refusal:input: meta is too large' using errcode = 'P0001';
  end if;
  if v_market is not null and v_market !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'refusal:input: market_id must be a uuid' using errcode = 'P0001';
  end if;
  if nullif(p->>'my_probability', '') is not null then
    begin
      v_my := (p->>'my_probability')::numeric;
    exception when invalid_text_representation then
      raise exception 'refusal:input: my_probability must be numeric' using errcode = 'P0001';
    end;
    if v_my < 0 or v_my > 1 then
      raise exception 'refusal:input: my_probability must be between 0 and 1' using errcode = 'P0001';
    end if;
  end if;
  if nullif(p->>'book_probability', '') is not null then
    begin
      v_book := (p->>'book_probability')::numeric;
    exception when invalid_text_representation then
      raise exception 'refusal:input: book_probability must be numeric' using errcode = 'P0001';
    end;
    if v_book < 0 or v_book > 1 then
      raise exception 'refusal:input: book_probability must be between 0 and 1' using errcode = 'P0001';
    end if;
  end if;
  if v_thesis is not null then
    if char_length(v_thesis) > 200 then
      raise exception 'refusal:input: thesis_id is too long' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.theses t where t.id = v_thesis) then
      raise exception 'refusal:input: unknown thesis_id %', v_thesis using errcode = 'P0001';
    end if;
  end if;

  insert into public.pm_notes (
    market_id, thesis_id, note_type, title, body, my_probability, book_probability, decision, meta
  ) values (
    v_market::uuid, v_thesis, v_type, v_title, v_body, v_my, v_book, v_decision, v_meta
  )
  returning id into v_id;

  return jsonb_build_object('pm_note_id', v_id, 'note_type', v_type);
end;
$$;

revoke all on function public.oddsborne_insert_note(jsonb) from public, anon, authenticated;
grant execute on function public.oddsborne_insert_note(jsonb) to oddsborne_worker, service_role;

comment on function public.oddsborne_insert_note(jsonb) is
  'Insert one pm_notes row for ODDSBORNE over steward-rpc. Validates note_type, decision, title, body, meta, and optional market/probability/thesis. No arbitrary SQL. oddsborne_worker and service_role only.';
