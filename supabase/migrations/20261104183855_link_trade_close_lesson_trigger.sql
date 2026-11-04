create or replace function private.link_trade_close_lesson()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lesson bigint;
  v_belief uuid;
begin
  if tg_table_name = 'belief_updates' then
    if coalesce(new.meta->>'kind', '') <> 'trade_close_lesson' then
      return new;
    end if;
    if nullif(new.meta->>'research_lesson_id', '') is not null then
      return new;
    end if;
    v_lesson := private.match_trade_close_lesson(
      new.thesis_id,
      coalesce(new.observed_at, new.created_at, now()),
      private.close_lot_symbol(new.meta),
      new.id
    );
    if v_lesson is not null then
      new.meta := coalesce(new.meta, '{}'::jsonb)
        || jsonb_build_object('research_lesson_id', v_lesson);
    end if;
    return new;
  end if;

  if tg_table_name = 'research_lessons' and tg_op = 'INSERT' then
    v_belief := private.match_belief_for_lesson(new.id);
    if v_belief is not null then
      update public.belief_updates b
         set meta = coalesce(b.meta, '{}'::jsonb)
           || jsonb_build_object('research_lesson_id', new.id)
       where b.id = v_belief
         and coalesce(b.meta->>'kind', '') = 'trade_close_lesson'
         and nullif(b.meta->>'research_lesson_id', '') is null;
    end if;
  end if;
  return new;
end;
$$;

comment on function private.link_trade_close_lesson() is
  'BEFORE a trade_close_lesson belief, or AFTER a research lesson: set meta.research_lesson_id when exactly one close matches. Does not change confidence. Private security definer because lesson-after-belief must update a row the worker cannot update.';

revoke all on function private.link_trade_close_lesson() from public, anon, authenticated;

drop trigger if exists belief_updates_link_trade_close_lesson on public.belief_updates;
create trigger belief_updates_link_trade_close_lesson
  before insert on public.belief_updates
  for each row
  execute function private.link_trade_close_lesson();

drop trigger if exists research_lessons_link_trade_close_lesson on public.research_lessons;
create trigger research_lessons_link_trade_close_lesson
  after insert on public.research_lessons
  for each row
  execute function private.link_trade_close_lesson();

create unique index if not exists belief_updates_trade_close_lesson_idx
  on public.belief_updates ((meta->>'research_lesson_id'))
  where coalesce(meta->>'kind', '') = 'trade_close_lesson'
    and nullif(meta->>'research_lesson_id', '') is not null;
