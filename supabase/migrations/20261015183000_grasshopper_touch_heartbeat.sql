-- GRASSHOPPER heartbeat. The other stewards already have <steward>_touch_heartbeat(p jsonb)
-- (60, then 67). GRASSHOPPER had none, so desk_agents.heartbeat_at stayed at the last
-- manual write. There is no grasshopper_worker login: routines call this in SQL.
-- Same contract as quantanamo_touch_heartbeat: bump the row, record the breach check,
-- return heartbeat_at and the sell-now list. now() is the touch. Nothing is backfilled.

create or replace function public.grasshopper_touch_heartbeat(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  update public.desk_agents set heartbeat_at = now(), updated_at = now()
   where slug = 'grasshopper' returning heartbeat_at into v_at;
  perform public.note_actionable_breaches(jsonb_build_object(
    'check_key', 'heartbeat:grasshopper:' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI')));
  return jsonb_build_object('heartbeat_at', v_at, 'escalated', public.escalated_breaches('{}'::jsonb));
end;
$$;

revoke all on function public.grasshopper_touch_heartbeat(jsonb) from public, anon, authenticated;
grant execute on function public.grasshopper_touch_heartbeat(jsonb) to service_role;

comment on function public.grasshopper_touch_heartbeat(jsonb) is
  'Ledger steward heartbeat. select public.grasshopper_touch_heartbeat(''{}''::jsonb). Returns heartbeat_at and escalated. service_role only; no grasshopper_worker login.';
