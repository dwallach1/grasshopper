-- Robinhood equity fundamentals as a second sector source.
--
-- Financial Datasets company facts remain a source. The prepaid balance can
-- be exhausted, and Postgres still cannot call Robinhood. The operator reads
-- fundamentals (sector and industry per symbol) and calls
-- upsert_symbol_sector as the database owner with source
-- robinhood_fundamentals. quantanamo_worker may call it too. Every other
-- worker role is still refused. This statement grants nothing to
-- desk_public_reader: that role was left off symbol_sectors on purpose.
--
-- Precedence. The two sources use different sector names, and a sector theme
-- is slugged from that name, so a cross-source overwrite would move the
-- symbol onto a different theme. The first source that stores a non-null
-- sector owns the row: sector, industry, theme_id, source, and fetched_at.
-- A later upsert from the other source writes nothing and returns skip
-- kept_existing_source. Only a same-source call refreshes the row, including
-- a same-source blank sector, which still stores skip_reason no_sector and
-- clears the theme. A row whose sector is null does not own a taxonomy, so
-- the other source may fill it.
-- fetched_at is not bumped on a cross-source skip, so symbol_sector_gaps can
-- list the symbol again after 30 days. The upsert then skips again.
--
-- Theme shape is the one company facts already uses. Kind is sector, parent
-- is the sectors concept, match_threshold is 35, auto_promote_sources is 3.
-- 'Producer Manufacturing' slugs to sector_producer_manufacturing. The
-- description and created_by of a theme this function creates name the
-- source. A slug that already exists keeps that theme's description and
-- created_by.
-- propose_ontology_candidates is unchanged. It joins any non-null sector
-- with an active sector theme and does not filter on source.

alter table public.symbol_sectors
  drop constraint if exists symbol_sectors_source_check;

alter table public.symbol_sectors
  add constraint symbol_sectors_source_check
  check (source in ('financialdatasets_company_facts', 'robinhood_fundamentals'));

comment on constraint symbol_sectors_source_check on public.symbol_sectors is
  'financialdatasets_company_facts and robinhood_fundamentals only. Different taxonomies: the first non-null sector owns the row.';

comment on table public.symbol_sectors is
  'Sector and industry from one source taxonomy, financialdatasets_company_facts or robinhood_fundamentals. The first source to store a non-null sector owns sector and theme_id. theme_id is the sector theme. skip_reason no_sector means that source had no sector. The proposer does not invent one.';

create or replace function public.upsert_symbol_sector(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_symbol text;
  v_sector text;
  v_industry text;
  v_source text;
  v_slug text;
  v_parent text;
  v_existing_source text;
  v_existing_sector text;
  v_existing_theme text;
  v_theme_description text;
  v_created_by text;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'not_operator' using errcode = '42501';
  end if;

  v_symbol := upper(btrim(coalesce(p->>'symbol', '')));
  v_sector := nullif(btrim(coalesce(p->>'sector', '')), '');
  v_industry := nullif(btrim(coalesce(p->>'industry', '')), '');
  v_source := btrim(coalesce(p->>'source', ''));

  if v_symbol !~ '^[A-Z]{1,5}$' then
    raise exception 'refusal:sector: symbol must be a 1-5 letter ticker' using errcode = '22023';
  end if;
  if v_source not in ('financialdatasets_company_facts', 'robinhood_fundamentals') then
    raise exception 'refusal:sector: source must be financialdatasets_company_facts or robinhood_fundamentals'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.symbols s where s.symbol = v_symbol) then
    return jsonb_build_object('ok', false, 'symbol', v_symbol, 'skip', 'symbol_not_in_ledger');
  end if;

  select ss.source, ss.sector, ss.theme_id
    into v_existing_source, v_existing_sector, v_existing_theme
  from public.symbol_sectors ss
  where ss.symbol = v_symbol;

  -- First non-null sector owns the taxonomy. The other source does not
  -- overwrite sector or theme_id and does not refresh fetched_at.
  if v_existing_sector is not null and v_existing_source is distinct from v_source then
    return jsonb_build_object(
      'ok', true,
      'symbol', v_symbol,
      'sector', v_existing_sector,
      'theme_id', v_existing_theme,
      'source', v_existing_source,
      'skip', 'kept_existing_source'
    );
  end if;

  if v_sector is null then
    insert into public.symbol_sectors (symbol, sector, industry, theme_id, source, fetched_at, skip_reason)
    values (v_symbol, null, v_industry, null, v_source, now(), 'no_sector')
    on conflict (symbol) do update set
      sector = null,
      industry = excluded.industry,
      theme_id = null,
      source = excluded.source,
      fetched_at = excluded.fetched_at,
      skip_reason = 'no_sector';
    return jsonb_build_object(
      'ok', true, 'symbol', v_symbol, 'theme_id', null, 'skip_reason', 'no_sector'
    );
  end if;

  -- 'Producer Manufacturing' -> sector_producer_manufacturing
  v_slug := 'sector_' || btrim(regexp_replace(lower(v_sector), '[^a-z0-9]+', '_', 'g'), '_');
  if v_slug = 'sector_' or v_slug !~ '^sector_[a-z0-9][a-z0-9_]{0,70}$' then
    insert into public.symbol_sectors (symbol, sector, industry, theme_id, source, fetched_at, skip_reason)
    values (v_symbol, null, v_industry, null, v_source, now(), 'no_sector')
    on conflict (symbol) do update set
      sector = null,
      industry = excluded.industry,
      theme_id = null,
      source = excluded.source,
      fetched_at = excluded.fetched_at,
      skip_reason = 'no_sector';
    return jsonb_build_object(
      'ok', true, 'symbol', v_symbol, 'theme_id', null, 'skip_reason', 'no_sector'
    );
  end if;

  if v_source = 'robinhood_fundamentals' then
    v_theme_description := 'Sector from Robinhood equity fundamentals (robinhood_fundamentals).';
    v_created_by := 'robinhood_fundamentals';
  else
    v_theme_description := 'Sector from Financial Datasets company facts.';
    v_created_by := 'company_facts';
  end if;

  -- Shared container. Kind concept, id sectors. Sector rows use kind sector
  -- and this parent, for both sources.
  insert into public.ontology_themes (
    id, kind, name, description, status,
    match_threshold, auto_promote_sources, created_by, created_at, updated_at
  ) values (
    'sectors', 'concept', 'Sectors',
    'Company-facts sectors. Memberships are proposed from traded lots and earnings sheets. A symbol with no sector is left unscoped.',
    'active', 35, 3, 'company_facts', now(), now()
  ) on conflict (id) do nothing;

  select t.id into v_parent
  from public.ontology_themes t
  where t.id = 'sectors' and t.kind = 'concept' and t.status = 'active';

  insert into public.ontology_themes (
    id, kind, name, description, status, parent_theme_id,
    match_threshold, auto_promote_sources, created_by, created_at, updated_at
  ) values (
    v_slug, 'sector', v_sector,
    v_theme_description,
    'active', v_parent,
    35, 3, v_created_by, now(), now()
  )
  on conflict (id) do update set
    name = excluded.name,
    parent_theme_id = coalesce(public.ontology_themes.parent_theme_id, excluded.parent_theme_id),
    updated_at = now()
  where public.ontology_themes.kind = 'sector'
    and public.ontology_themes.status not in ('retired', 'blacklisted', 'merged');
  -- description and created_by stay with the source that created the theme.

  if not exists (
    select 1
    from public.ontology_themes t
    where t.id = v_slug and t.kind = 'sector' and t.status = 'active'
  ) then
    raise exception 'refusal:sector: % is not an active sector theme', v_slug
      using errcode = '23514';
  end if;

  insert into public.symbol_sectors (symbol, sector, industry, theme_id, source, fetched_at, skip_reason)
  values (v_symbol, v_sector, v_industry, v_slug, v_source, now(), null)
  on conflict (symbol) do update set
    sector = excluded.sector,
    industry = excluded.industry,
    theme_id = excluded.theme_id,
    source = excluded.source,
    fetched_at = excluded.fetched_at,
    skip_reason = null;

  return jsonb_build_object(
    'ok', true,
    'symbol', v_symbol,
    'sector', v_sector,
    'theme_id', v_slug,
    'skip_reason', null
  );
end;
$$;

comment on function public.upsert_symbol_sector(jsonb) is
  'Store one sector for a symbol and ensure the sector theme exists (kind sector, parent sectors, auto_promote_sources 3). source is financialdatasets_company_facts or robinhood_fundamentals. The first non-null sector owns sector and theme_id; the other source returns skip kept_existing_source and writes nothing. A same-source blank sector is skip_reason no_sector. A theme this call creates names its source in description and created_by. Does not invent a sector and does not write a membership.';

revoke all on function public.upsert_symbol_sector(jsonb)
  from public, anon, authenticated, desk_public_reader, oddsborne_worker, bandit_worker;
grant execute on function public.upsert_symbol_sector(jsonb)
  to quantanamo_worker, service_role;

revoke all on table public.symbol_sectors from desk_public_reader;
