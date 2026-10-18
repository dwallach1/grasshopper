-- 79: a direct skip logged AFTER a note-derived skip supersedes it (78 only covered direct-before-note).
-- session_daily writes skip notes ~16:06Z and session_passlog logs direct rows ~16:14Z, so every daily
-- run double-counted. Direct logging is the source of truth regardless of write order.
create or replace function private.decision_candidates_direct_supersedes_note()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  begin
    if new.source_table <> 'direct' or new.decision <> 'skip'
       or new.instrument is null or new.side is null or new.decided_at is null then
      return null;
    end if;

    delete from public.decision_candidates n
    where n.source_table = 'pm_notes'
      and n.decision = 'skip'
      and n.steward = new.steward
      and n.instrument = new.instrument
      and n.side = new.side
      and n.decided_at between new.decided_at - interval '24 hours' and new.decided_at + interval '24 hours'
      and coalesce(n.meta->>'superseded', '') <> 'true'
      and n.resolved_outcome is null
      and n.counterfactual_pnl is null
      and n.brier is null
      and not exists (select 1 from public.decision_marks m where m.decision_id = n.id);

    update public.decision_candidates n
    set meta = n.meta || jsonb_build_object(
          'superseded', 'true',
          'superseded_why', 'note-derived skip duplicates a later direct row within 24h; kept because a mark or outcome references it',
          'superseded_by', new.id),
        updated_at = pg_catalog.now()
    where n.source_table = 'pm_notes'
      and n.decision = 'skip'
      and n.steward = new.steward
      and n.instrument = new.instrument
      and n.side = new.side
      and n.decided_at between new.decided_at - interval '24 hours' and new.decided_at + interval '24 hours'
      and coalesce(n.meta->>'superseded', '') <> 'true';
  exception when others then
    raise warning 'decision_candidates_direct_supersedes_note: %', sqlerrm;
  end;
  return null;
end;
$function$;

revoke all on function private.decision_candidates_direct_supersedes_note() from public, anon, authenticated;

drop trigger if exists decision_candidates_direct_supersedes_note on public.decision_candidates;
create trigger decision_candidates_direct_supersedes_note
  after insert on public.decision_candidates
  for each row
  when (new.source_table = 'direct' and new.decision = 'skip')
  execute function private.decision_candidates_direct_supersedes_note();

-- One-off: today's and any remaining duplicates (direct written after the note).
do $$
declare v_deleted integer := 0; v_superseded integer := 0;
begin
  delete from public.decision_candidates n
  where n.source_table = 'pm_notes' and n.decision = 'skip'
    and coalesce(n.meta->>'superseded', '') <> 'true'
    and private.pm_note_skip_covered_by_direct(n.steward, n.instrument, n.side, n.decided_at)
    and n.resolved_outcome is null and n.counterfactual_pnl is null and n.brier is null
    and not exists (select 1 from public.decision_marks m where m.decision_id = n.id);
  get diagnostics v_deleted = row_count;
  update public.decision_candidates n
  set meta = n.meta || jsonb_build_object('superseded', 'true',
        'superseded_why', 'note-derived skip duplicates a direct row within 24h; kept because a mark or outcome references it'),
      updated_at = pg_catalog.now()
  where n.source_table = 'pm_notes' and n.decision = 'skip'
    and coalesce(n.meta->>'superseded', '') <> 'true'
    and private.pm_note_skip_covered_by_direct(n.steward, n.instrument, n.side, n.decided_at);
  get diagnostics v_superseded = row_count;
  raise notice '79 direct-after-note dedup: deleted %, superseded %', v_deleted, v_superseded;
end;
$$;
