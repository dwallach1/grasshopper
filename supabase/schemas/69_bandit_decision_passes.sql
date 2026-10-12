-- Read-only list of a steward's logged decisions for one thesis (edge2_path_score.py).
-- steward_pending_decision_marks only returns passes that are past horizon AND not yet marked, and carries no
-- thesis_id, so once pass_marks.py marks a pass it can no longer be found. This returns every decision for
-- the calling steward and thesis, marked or not. No writes.
create or replace function public.bandit_decision_passes(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_thesis text := nullif(btrim(coalesce(p->>'thesis_id', '')), '');
  v_limit integer := least(greatest(coalesce(private.try_numeric(p->>'limit')::integer, 500), 1), 2000);
begin
  if session_user::text like '%\_worker' and session_user::text <> 'bandit_worker' then
    raise exception 'refusal:auth: only bandit may read bandit decisions' using errcode = '42501';
  end if;
  if v_thesis is null then
    raise exception 'refusal:decision_passes: thesis_id is required' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'decision_id', c.id, 'decision', c.decision, 'instrument', c.instrument, 'side', c.side,
      'book_price', c.book_price, 'decided_at', c.decided_at, 'thesis_id', c.thesis_id,
      'source_id', c.source_id, 'blocked_by', c.meta->>'blocked_by',
      'counterfactual_pnl', c.counterfactual_pnl, 'resolve_status', c.meta->>'resolve_status'
    ) order by c.decided_at)
    from (select * from public.decision_candidates
          where steward = 'bandit' and venue = 'meme' and thesis_id = v_thesis
          order by decided_at limit v_limit) c
  ), '[]'::jsonb);
end;
$$;
comment on function public.bandit_decision_passes(jsonb) is
  'Read-only: every BANDIT meme decision for one thesis_id (marked or not), for edge2_path_score.py.';
revoke all on function public.bandit_decision_passes(jsonb) from public, anon, authenticated;
grant execute on function public.bandit_decision_passes(jsonb) to bandit_worker, service_role;
