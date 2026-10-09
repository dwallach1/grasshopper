-- 68: escalated_breaches / note_actionable_breaches run as owner so each steward worker can call them.
-- Under SECURITY INVOKER, v_invalidation_breaches unions every steward's lot table, so bandit_worker hit
-- "permission denied for table pm_positions" (2026-10-09). As definer, a *_worker caller only ever sees
-- its own steward's rows (taken from session_user, not from p); other callers keep the optional p filters.
-- authenticated loses execute: nothing in the app calls it, and a definer must not widen what it can read.

create or replace function public.escalated_breaches(p jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with who as (
    select case when session_user::text like '%\_worker' then replace(session_user::text, '_worker', '') end as forced
  )
  select coalesce(jsonb_agg(jsonb_build_object('steward', b.steward, 'lot_table', b.lot_table, 'lot_id', b.lot_id,
           'instrument', b.instrument, 'first_seen_at', b.first_seen_at, 'breach_age_minutes', b.breach_age_minutes,
           'mark', b.mark, 'invalidation_price', b.invalidation_price, 'escalation', b.escalation,
           'sentence', b.sentence) order by b.first_seen_at), '[]'::jsonb)
  from public.v_invalidation_breaches b, who
  where b.escalated
    and (who.forced is null or b.steward = who.forced)
    and (nullif(p->>'steward', '') is null or b.steward = p->>'steward')
    and (nullif(p->>'lot_table', '') is null or b.lot_table = p->>'lot_table');
$function$;

alter function public.note_actionable_breaches(jsonb) security definer;

revoke all on function public.escalated_breaches(jsonb) from public, anon, authenticated;
revoke all on function public.note_actionable_breaches(jsonb) from public, anon, authenticated;
grant execute on function public.escalated_breaches(jsonb) to service_role, quantanamo_worker, oddsborne_worker, bandit_worker;
grant execute on function public.note_actionable_breaches(jsonb) to service_role, quantanamo_worker, oddsborne_worker, bandit_worker;
