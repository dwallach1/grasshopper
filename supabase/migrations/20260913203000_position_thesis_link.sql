-- New equity / pm / meme lots need thesis_id or an explicit meta.untagged reason.
-- Historical rows stay untagged unless the mapping is unambiguous. Do not invent P/L.

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

-- Conservative backfill only. Skip guesses (Fed hike, Chicago weather, multi-thesis names).
insert into public.thesis_symbols (thesis_id, symbol, role)
select 'earnings_gap_structure', 'CODA', 'held'
where exists (select 1 from public.theses t where t.id = 'earnings_gap_structure')
  and exists (select 1 from public.symbols s where s.symbol = 'CODA')
on conflict (thesis_id, symbol) do update set role = excluded.role;

update public.position_episodes
set thesis_id = 'earnings_gap_structure',
    meta = coalesce(meta, '{}'::jsonb) - 'untagged'
      || jsonb_build_object('linked', 'backfill_coda_earnings_gap_structure'),
    updated_at = now()
where symbol = 'CODA'
  and thesis_id is null
  and exists (select 1 from public.theses t where t.id = 'earnings_gap_structure');

insert into public.position_episodes (
  account_key, symbol, status, quantity, average_cost, opened_at, thesis_id, meta
)
select
  'agentic-7638',
  e.symbol,
  'open',
  e.quantity,
  e.average_buy_price,
  e.observed_at,
  'earnings_gap_structure',
  jsonb_build_object('linked', 'backfill_coda_earnings_gap_structure')
from public.portfolio_exposure e
where e.account_last4 = '7638'
  and e.symbol = 'CODA'
  and e.quantity > 0
  and e.observed_at = (
    select max(pe.observed_at)
    from public.portfolio_exposure pe
    where pe.account_last4 = '7638' and pe.symbol = 'CODA'
  )
  and exists (select 1 from public.theses t where t.id = 'earnings_gap_structure')
  and exists (select 1 from public.symbols s where s.symbol = 'CODA')
  and not exists (
    select 1 from public.position_episodes p
    where p.account_key = 'agentic-7638'
      and p.symbol = 'CODA'
      and p.status in ('proposed', 'open', 'closing')
  );

update public.pm_markets
set thesis_id = 'weather_same_day_high',
    updated_at = now()
where thesis_id is null
  and slug like 'tc-temp-laxhigh-%'
  and exists (select 1 from public.theses t where t.id = 'weather_same_day_high');

update public.pm_positions p
set thesis_id = 'weather_same_day_high',
    meta = coalesce(p.meta, '{}'::jsonb) - 'untagged'
      || jsonb_build_object('linked', 'backfill_lax_weather_same_day_high'),
    updated_at = now()
from public.pm_markets m
where p.market_id = m.id
  and p.thesis_id is null
  and m.slug like 'tc-temp-laxhigh-%'
  and exists (select 1 from public.theses t where t.id = 'weather_same_day_high');

-- Remaining live rows: document untagged. Do not invent a thesis.
update public.position_episodes
set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('untagged', 'historical')
where thesis_id is null
  and nullif(btrim(coalesce(meta->>'untagged', '')), '') is null;

update public.pm_positions
set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('untagged', 'historical')
where thesis_id is null
  and nullif(btrim(coalesce(meta->>'untagged', '')), '') is null;

update public.meme_positions
set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('untagged', 'historical')
where thesis_id is null
  and nullif(btrim(coalesce(meta->>'untagged', '')), '') is null;

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
