-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
-- Partial unique indexes so NULL condition_id/slug watch rows can coexist
alter table public.pm_markets drop constraint if exists pm_markets_venue_condition_uniq;
alter table public.pm_markets drop constraint if exists pm_markets_venue_slug_uniq;

create unique index if not exists pm_markets_venue_condition_uniq
  on public.pm_markets (venue, condition_id)
  where condition_id is not null;

create unique index if not exists pm_markets_venue_slug_uniq
  on public.pm_markets (venue, slug)
  where slug is not null;
