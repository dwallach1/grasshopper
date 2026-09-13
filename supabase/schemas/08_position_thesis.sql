-- New equity / pm / meme lots need thesis_id or meta.untagged.
-- Backfill lives in the timestamped migration. Do not invent historical links.

create or replace function public.position_has_thesis_or_untagged(
  p_thesis_id text,
  p_meta jsonb
) returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select (
    nullif(btrim(coalesce(p_thesis_id, '')), '') is not null
    or nullif(btrim(coalesce(p_meta->>'untagged', '')), '') is not null
  );
$$;

comment on function public.position_has_thesis_or_untagged(text, jsonb) is
  'True when a lot has thesis_id or meta.untagged (non-empty). Required on new position writes.';

revoke all on function public.position_has_thesis_or_untagged(text, jsonb) from public, anon;
grant execute on function public.position_has_thesis_or_untagged(text, jsonb)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

alter table public.position_episodes
  add column if not exists thesis_id text references public.theses(id) on delete set null,
  add column if not exists meta jsonb not null default '{}'::jsonb;

create index if not exists idx_position_episodes_thesis_id
  on public.position_episodes(thesis_id)
  where thesis_id is not null;

alter table public.position_episodes
  drop constraint if exists position_episodes_thesis_or_untagged;
alter table public.position_episodes
  add constraint position_episodes_thesis_or_untagged
  check (public.position_has_thesis_or_untagged(thesis_id, meta));

alter table public.pm_positions
  drop constraint if exists pm_positions_thesis_or_untagged;
alter table public.pm_positions
  add constraint pm_positions_thesis_or_untagged
  check (public.position_has_thesis_or_untagged(thesis_id, meta));

alter table public.meme_positions
  drop constraint if exists meme_positions_thesis_or_untagged;
alter table public.meme_positions
  add constraint meme_positions_thesis_or_untagged
  check (public.position_has_thesis_or_untagged(thesis_id, meta));
