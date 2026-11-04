update public.belief_updates b
   set meta = b.meta || jsonb_build_object('research_lesson_id', matched.lesson_id)
  from (
    select b2.id,
           private.match_trade_close_lesson(
             b2.thesis_id,
             coalesce(b2.observed_at, b2.created_at),
             private.close_lot_symbol(b2.meta),
             b2.id
           ) as lesson_id
    from public.belief_updates b2
    where coalesce(b2.meta->>'kind', '') = 'trade_close_lesson'
      and nullif(b2.meta->>'research_lesson_id', '') is null
  ) matched
 where b.id = matched.id
   and matched.lesson_id is not null;
