-- Per-lot invalidation (2026-09-26). A steward writes its own invalidation for an open lot.
-- The QUANTANAMO exit logic reads it before the thesis-level falsifier. There is no global stop.
-- Price is in the row's own unit: USD per share (position_episodes), outcome price
-- (pm_positions), SOL per token (meme_positions). Lots are long, so a mark at or below the
-- price means the lot's invalidation has been hit.

alter table public.position_episodes
  add column if not exists invalidation_price numeric,
  add column if not exists invalidation_note text;
alter table public.pm_positions
  add column if not exists invalidation_price numeric,
  add column if not exists invalidation_note text;
alter table public.meme_positions
  add column if not exists invalidation_price numeric,
  add column if not exists invalidation_note text;

do $$
declare t text;
begin
  foreach t in array array['position_episodes', 'pm_positions', 'meme_positions'] loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', t)::regclass and conname = t || '_invalidation_price_positive'
    ) then
      execute format(
        'alter table public.%I add constraint %I check (invalidation_price is null or invalidation_price > 0)',
        t, t || '_invalidation_price_positive');
    end if;
    execute format($c$comment on column public.%I.invalidation_price is
      'Steward-written per-lot invalidation price in the row''s own unit. Null = none. Mark <= price means the lot''s invalidation has been hit.'$c$, t);
    execute format($c$comment on column public.%I.invalidation_note is
      'Steward-written per-lot invalidation in words (what would prove this lot wrong).'$c$, t);
  end loop;
end $$;

-- Each book's worker updates its own lots (the table-level UPDATE and RLS policies already
-- exist; this makes the column grant explicit).
grant update (invalidation_price, invalidation_note) on public.position_episodes to quantanamo_worker;
grant update (invalidation_price, invalidation_note) on public.pm_positions to oddsborne_worker;
grant update (invalidation_price, invalidation_note) on public.meme_positions to bandit_worker;
