-- PR 6 data run: copy every tagged source thesis onto a mismatched trade_outcomes row.
-- Only rows whose source position carries a thesis are changed; an outcome linked to a thesis
-- whose source row is untagged keeps its link (nothing on the source to propagate).
-- trade_outcome_rescore_upd re-scores the affected theses; meme_4h_momentum_clip is also
-- re-scored explicitly.
with src as (
  select 'meme_positions'::text as st, id::text as sid, nullif(btrim(coalesce(thesis_id, '')), '') as th from public.meme_positions
  union all
  select 'pm_positions', id::text, nullif(btrim(coalesce(thesis_id, '')), '') from public.pm_positions
  union all
  select 'position_episodes', id::text, nullif(btrim(coalesce(thesis_id::text, '')), '') from public.position_episodes
)
update public.trade_outcomes o
set thesis_id = s.th,
    confidence_at_entry = private.thesis_confidence_at(s.th, o.opened_at),
    meta = coalesce(o.meta, '{}'::jsonb) || jsonb_build_object('thesis_relinked', jsonb_build_object(
      'from', o.thesis_id, 'to', s.th, 'at', now(), 'via', 'pr6_backfill')),
    updated_at = now()
from src s
where s.st = o.source_table
  and s.sid = o.source_id
  and s.th is not null
  and o.thesis_id is distinct from s.th;

select private.rescore_thesis_confidence('meme_4h_momentum_clip');
