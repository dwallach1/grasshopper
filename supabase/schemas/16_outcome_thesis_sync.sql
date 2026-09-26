-- PR 6: a thesis_id change on a source position row propagates to its trade_outcomes row.
-- Root cause: the outcome capture triggers only fire on status/closed_at, so a thesis tag set
-- after close (BANDIT familiars 51c05877, goon f97e3701 -> meme_4h_momentum_clip) never
-- reached trade_outcomes. Thesis linkage is an attribute of the source row, not a P/L number,
-- so it syncs for every origin (trigger, backfill, manual). The existing
-- trade_outcome_rescore_upd trigger then re-scores both the old and the new thesis.

create or replace function private.trade_outcome_thesis_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new text := nullif(btrim(coalesce(new.thesis_id::text, '')), '');
  v_old text := nullif(btrim(coalesce(old.thesis_id::text, '')), '');
begin
  begin
    if v_new is distinct from v_old then
      update public.trade_outcomes o
      set thesis_id = v_new,
          confidence_at_entry = private.thesis_confidence_at(v_new, o.opened_at),
          meta = coalesce(o.meta, '{}'::jsonb) || jsonb_build_object('thesis_relinked', jsonb_build_object(
            'from', o.thesis_id, 'to', v_new, 'at', now(), 'via', 'source_thesis_sync')),
          updated_at = now()
      where o.source_table = tg_table_name
        and o.source_id = new.id::text
        and o.thesis_id is distinct from v_new;
    end if;
  exception when others then
    raise warning 'trade_outcome_thesis_sync(%): %', tg_table_name, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.trade_outcome_thesis_sync() from public, anon, authenticated;

drop trigger if exists trade_outcome_thesis_sync on public.meme_positions;
create trigger trade_outcome_thesis_sync
  after update of thesis_id on public.meme_positions
  for each row when (old.thesis_id is distinct from new.thesis_id)
  execute function private.trade_outcome_thesis_sync();

drop trigger if exists trade_outcome_thesis_sync on public.pm_positions;
create trigger trade_outcome_thesis_sync
  after update of thesis_id on public.pm_positions
  for each row when (old.thesis_id is distinct from new.thesis_id)
  execute function private.trade_outcome_thesis_sync();

drop trigger if exists trade_outcome_thesis_sync on public.position_episodes;
create trigger trade_outcome_thesis_sync
  after update of thesis_id on public.position_episodes
  for each row when (old.thesis_id is distinct from new.thesis_id)
  execute function private.trade_outcome_thesis_sync();
