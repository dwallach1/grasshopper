-- Sector memberships from what the desk actually trades.
--
-- Bookmarks and research lessons were the only proposer sources. Lessons on
-- earnings_gap_structure are the earnings_events theme, and that branch does
-- not open a new key, so a name QUANTANAMO traded or put on an earnings sheet
-- never became a candidate.
--
-- Company facts already live at Financial Datasets /company/facts (the same
-- call workers/knowledge makes). Postgres cannot reach that API. A script
-- writes public.symbol_sectors; this proposer only reads it. A symbol with no
-- sector row, or a row whose sector is null, is counted as no_sector and is
-- not given a theme. Nothing here invents a sector.
--
-- Evidence source types are traded_lot (one row per position_episodes id,
-- any status, open or opened in 45 days), earnings_sheet (one row per
-- research_queue sheet that names the ticker), and research_lesson (a lesson
-- that already names the ticker). Those three are distinct source types, so
-- a lot plus a sheet plus a lesson is three sources against auto_promote_sources.
-- The junk deny list and the rejection resurrection gate are unchanged.
-- A new sector key's first_seen_at is the proposal time, so ontology_freshness
-- .starved clears only when a real candidate row is inserted.
--
-- This statement does not schedule cron and does not grant anything to
-- oddsborne_worker or bandit_worker.

alter table public.ontology_themes
  drop constraint if exists ontology_themes_kind_check;
alter table public.ontology_themes
  add constraint ontology_themes_kind_check
  check (kind in ('theme', 'concept', 'sector'));

create table public.symbol_sectors (
  symbol text primary key references public.symbols(symbol) on delete cascade,
  sector text,
  industry text,
  theme_id text references public.ontology_themes(id) on delete set null,
  source text not null,
  fetched_at timestamptz not null,
  skip_reason text,
  constraint symbol_sectors_source_check check (source = 'financialdatasets_company_facts'),
  constraint symbol_sectors_skip_check check (skip_reason is null or skip_reason = 'no_sector'),
  constraint symbol_sectors_link_check check (
    (skip_reason = 'no_sector' and theme_id is null and sector is null)
    or (skip_reason is null and theme_id is not null and sector is not null)
  )
);

comment on table public.symbol_sectors is
  'Sector and industry taken from Financial Datasets company facts. theme_id is the sector theme. skip_reason no_sector means the source had no sector. The proposer does not invent one.';

create index symbol_sectors_theme_idx on public.symbol_sectors(theme_id) where theme_id is not null;

alter table public.symbol_sectors enable row level security;

revoke all on table public.symbol_sectors from public, anon, oddsborne_worker, bandit_worker;
grant select on table public.symbol_sectors
  to authenticated, quantanamo_worker, desk_public_reader, service_role;
grant insert, update on table public.symbol_sectors
  to quantanamo_worker, service_role;

drop policy if exists symbol_sectors_read on public.symbol_sectors;
create policy symbol_sectors_read on public.symbol_sectors
  for select to authenticated, quantanamo_worker, desk_public_reader
  using (true);

drop policy if exists symbol_sectors_write on public.symbol_sectors;
create policy symbol_sectors_write on public.symbol_sectors
  for insert to quantanamo_worker
  with check (true);

drop policy if exists symbol_sectors_update on public.symbol_sectors;
create policy symbol_sectors_update on public.symbol_sectors
  for update to quantanamo_worker
  using (true)
  with check (true);

-- Container for sector themes. Not a symbol assignment.
insert into public.ontology_themes (
  id, kind, name, description, status,
  match_threshold, auto_promote_sources, created_by, created_at, updated_at
) values (
  'sectors', 'concept', 'Sectors',
  'Company-facts sectors. Memberships are proposed from traded lots and earnings sheets. A symbol with no sector is left unscoped.',
  'active', 35, 3, 'company_facts', now(), now()
) on conflict (id) do nothing;

-- Traded lots (any status) in the last 45 days, plus names still proposed or
-- open, and tickers on earnings sheets QUANTANAMO wrote in that same window
-- (or the sheet that is still open). Sheet tickers are the name lines
-- earnings_sheet.py writes: "SYMBOL print_session=".
create or replace function private.sector_desk_symbols()
returns table (
  symbol text,
  source_key text,
  source_type text,
  observed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    upper(pe.symbol),
    pe.id::text,
    'traded_lot'::text,
    coalesce(pe.opened_at, pe.created_at, now())
  from public.position_episodes pe
  where upper(pe.symbol) ~ '^[A-Z]{1,5}$'
    and (
      pe.status in ('proposed', 'open', 'closing')
      or coalesce(pe.opened_at, pe.created_at) >= now() - interval '45 days'
    )
  union all
  select
    upper(sym.symbol),
    q.id::text,
    'earnings_sheet'::text,
    q.created_at
  from public.research_queue q
  cross join lateral (
    select m[1] as symbol
    from regexp_matches(coalesce(q.reason, ''), '(?:^|\n)([A-Z]{1,5}) print_session=', 'g') as m
  ) sym
  where q.source = 'earnings_sheet'
    and (
      q.status = 'open'
      or q.created_at >= now() - interval '45 days'
    )
    and upper(sym.symbol) ~ '^[A-Z]{1,5}$';
$$;

comment on function private.sector_desk_symbols() is
  'Symbols the sector proposer considers: position episodes of any status opened in 45 days or still proposed/open/closing, and earnings-sheet name lines from the last 45 days or the open sheet.';

revoke all on function private.sector_desk_symbols() from public, anon, authenticated, oddsborne_worker, bandit_worker;
grant execute on function private.sector_desk_symbols() to quantanamo_worker, service_role;

create or replace function public.symbol_sector_gaps(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_symbols jsonb;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'not_operator' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(s.symbol order by s.symbol), '[]'::jsonb)
    into v_symbols
  from (
    select distinct d.symbol
    from private.sector_desk_symbols() d
    where exists (select 1 from public.symbols y where y.symbol = d.symbol)
      and not exists (
        select 1
        from public.symbol_sectors ss
        where ss.symbol = d.symbol
          and ss.fetched_at >= now() - interval '30 days'
      )
  ) s;

  return jsonb_build_object('symbols', v_symbols, 'window_days', 45);
end;
$$;

comment on function public.symbol_sector_gaps(jsonb) is
  'Tickers on a recent lot or earnings sheet that have no company-facts sector row in the last 30 days. Does not assign a sector.';

revoke all on function public.symbol_sector_gaps(jsonb) from public, anon, authenticated;
revoke all on function public.symbol_sector_gaps(jsonb) from oddsborne_worker, bandit_worker;
grant execute on function public.symbol_sector_gaps(jsonb) to quantanamo_worker, service_role;

-- Latest stored company-facts row for each gap ticker. The script upserts
-- these before it buys another /company/facts response. A wrapped
-- company_facts object is the shape the vault already stored for some tickers.
create or replace function public.symbol_sector_vault(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'not_operator' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'symbol', g.symbol,
           'sector', nullif(btrim(coalesce(
             f.payload_json->>'sector',
             f.payload_json->'company_facts'->>'sector',
             ''
           )), ''),
           'industry', nullif(btrim(coalesce(
             f.payload_json->>'industry',
             f.payload_json->'company_facts'->>'industry',
             ''
           )), ''),
           'source', 'financialdatasets_company_facts'
         ) order by g.symbol), '[]'::jsonb)
    into v_rows
  from (
    select distinct d.symbol
    from private.sector_desk_symbols() d
    where exists (select 1 from public.symbols y where y.symbol = d.symbol)
      and not exists (
        select 1
        from public.symbol_sectors ss
        where ss.symbol = d.symbol
          and ss.fetched_at >= now() - interval '30 days'
      )
  ) g
  join lateral (
    select r.payload_json
    from public.financial_records r
    where r.dataset = 'company.facts'
      and upper(r.ticker) = g.symbol
    order by r.fetched_at desc
    limit 1
  ) f on true;

  return jsonb_build_object('rows', v_rows);
end;
$$;

comment on function public.symbol_sector_vault(jsonb) is
  'Stored Financial Datasets company.facts sector and industry for tickers that still need a symbol_sectors row. Does not call the network and does not invent a sector when the payload has none.';

revoke all on function public.symbol_sector_vault(jsonb) from public, anon, authenticated;
revoke all on function public.symbol_sector_vault(jsonb) from oddsborne_worker, bandit_worker;
grant execute on function public.symbol_sector_vault(jsonb) to quantanamo_worker, service_role;

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
  if v_source <> 'financialdatasets_company_facts' then
    raise exception 'refusal:sector: source must be financialdatasets_company_facts' using errcode = '22023';
  end if;
  if not exists (select 1 from public.symbols s where s.symbol = v_symbol) then
    return jsonb_build_object('ok', false, 'symbol', v_symbol, 'skip', 'symbol_not_in_ledger');
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
    'Sector from Financial Datasets company facts.',
    'active', v_parent,
    35, 3, 'company_facts', now(), now()
  )
  on conflict (id) do update set
    name = excluded.name,
    parent_theme_id = coalesce(public.ontology_themes.parent_theme_id, excluded.parent_theme_id),
    updated_at = now()
  where public.ontology_themes.kind = 'sector'
    and public.ontology_themes.status not in ('retired', 'blacklisted', 'merged');

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
  'Store one company-facts sector for a symbol and ensure the sector theme exists (kind sector, parent sectors, auto_promote_sources 3). A blank sector is skip_reason no_sector. Does not invent a sector and does not write a membership.';

revoke all on function public.upsert_symbol_sector(jsonb) from public, anon, authenticated;
revoke all on function public.upsert_symbol_sector(jsonb) from oddsborne_worker, bandit_worker;
grant execute on function public.upsert_symbol_sector(jsonb) to quantanamo_worker, service_role;

create or replace function private.propose_ontology_candidates()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor text;
  v_inserted integer := 0;
  v_refreshed integer := 0;
  v_evidence integer := 0;
  v_recounted integer := 0;
  v_ids bigint[] := '{}';
  v_rejected jsonb;
  v_already_promoted integer := 0;
  v_rejected_quiet integer := 0;
  v_junk integer := 0;
  v_below integer := 0;
  v_resurrected integer := 0;
  v_lot_keys integer := 0;
  v_sheet_keys integer := 0;
  v_lesson_keys integer := 0;
  v_no_sector integer := 0;
begin
  -- A bookmark or lesson write already passed that table's grants. The
  -- trigger may propose. A direct call still needs an operator or a steward role.
  if pg_trigger_depth() = 0 then
    v_actor := coalesce((select auth.uid())::text, '');
    if v_actor <> '' then
      if not (select private.is_ledger_operator()) then
        raise exception 'not_operator' using errcode = '42501';
      end if;
    elsif session_user not in (
      'service_role', 'postgres', 'supabase_admin',
      'quantanamo_worker', 'oddsborne_worker', 'bandit_worker'
    ) then
      raise exception 'not_operator' using errcode = '42501';
    else
      v_actor := session_user;
    end if;
  else
    v_actor := session_user;
  end if;

  with index_etf(symbol) as (
    values
      ('SPY'::text), ('QQQ'), ('IWM'), ('DIA'),
      ('SMH'), ('SOXX'), ('XLK'), ('XLF'), ('XLE'), ('XLV'),
      ('XLY'), ('XLP'), ('XLI'), ('XLB'), ('XLU'), ('XLRE'), ('XLC'),
      ('VTI'), ('VOO'), ('IVV'), ('QQQM'), ('MDY'), ('IWB'), ('RSP'),
      ('XBI'), ('XHB'), ('XRT'), ('XOP'), ('XME'), ('KRE'), ('IBB'), ('IYR'),
      ('TQQQ'), ('SQQQ'), ('SOXL'), ('SOXS'), ('SPXL'), ('UPRO')
  ),
  open_equity as (
    select distinct upper(pe.symbol) as symbol
    from public.position_episodes pe
    where pe.status = 'open'
      and upper(pe.symbol) ~ '^[A-Z]{1,5}$'
  ),
  bookmark_raw as (
    select
      b.id as source_key,
      'bookmark'::text as source_type,
      b.classified_at as observed_at,
      least(100, greatest(0, coalesce(b.market_score, 0)))::smallint as score,
      left(regexp_replace(coalesce(b.text, ''), '\s+', ' ', 'g'), 180) as excerpt,
      b.text,
      upper(sym.symbol) as symbol
    from public.bookmarks b
    cross join lateral (
      select distinct m[1] as symbol
      from regexp_matches(coalesce(b.text, ''), '\$([A-Z]{2,5})([^A-Za-z]|$)', 'g') as m
      union
      select upper(bs.symbol)
      from public.bookmark_symbols bs
      where bs.bookmark_id = b.id
        and bs.symbol ~ '^[A-Za-z]{2,5}$'
    ) sym
    where b.is_market_related
      and b.classified_at >= timestamptz '2026-09-13 00:00:00+00'
      and sym.symbol ~ '^[A-Z]{2,5}$'
  ),
  bookmark_clean as (
    select *
    from bookmark_raw r
    where not private.ontology_label_is_junk('membership', r.symbol)
      and not exists (select 1 from index_etf e where e.symbol = r.symbol)
  ),
  bookmark_counts as (
    select source_key, count(distinct symbol)::integer as n_sym
    from bookmark_clean
    group by source_key
  ),
  bookmark_themed as (
    select
      c.source_key,
      c.source_type,
      c.observed_at,
      c.score,
      c.excerpt,
      c.symbol,
      hit.theme_id
    from bookmark_clean c
    join bookmark_counts n on n.source_key = c.source_key
    left join lateral (
      select t.theme_id
      from public.ontology_terms t
      join public.ontology_themes th on th.id = t.theme_id and th.status = 'active'
      where n.n_sym <= 4
        and t.status = 'active'
        and char_length(t.normalized_term) >= 6
        and t.normalized_term ~ '^[a-z0-9][a-z0-9 .-]*$'
        and not private.ontology_label_is_junk('term', t.normalized_term)
        and lower(c.text) ~ (
          '(^|[^a-z0-9])'
          || replace(replace(replace(t.normalized_term, '.', '\.'), '-', '[^a-z0-9]'), ' ', '[^a-z0-9]+')
          || '([^a-z0-9]|$)'
        )
        and (
          not exists (
            select 1
            from public.symbol_theme_memberships m
            where m.symbol = c.symbol
              and m.theme_id = t.theme_id
              and m.status = 'active'
          )
          or exists (
            select 1
            from public.ontology_candidates oc
            where oc.candidate_type = 'membership'
              and oc.candidate_key = t.theme_id || ':' || c.symbol
          )
        )
      order by char_length(t.normalized_term) desc, t.theme_id
      limit 2
    ) hit on true
  ),
  lesson_prose(symbol) as (
    values
      ('AH'::text), ('AM'), ('PM'), ('ET'), ('QD'), ('OOS'), ('CI'), ('RTH'),
      ('EPS'), ('FY'), ('GPU'), ('CPU'), ('GAAP'), ('FOMC'), ('FOMO'),
      ('REIT'), ('ADR'), ('ETF'), ('IPO'), ('CEO'), ('CFO'), ('COO'), ('CTO'),
      ('AI'), ('US'), ('UK'), ('IT'), ('OR'), ('AND'), ('THE'), ('FOR'),
      ('ALL'), ('NEW'), ('NOT'), ('NO'), ('DUMP'), ('RUNUP'), ('HOLD'),
      ('FAIL'), ('OPEN'), ('PAPER'), ('SCORE'), ('WATCH'), ('WELL'), ('HIGH'),
      ('EVERY'), ('LONG'), ('BASE'), ('FAST'), ('SKIP'), ('LOST'), ('NEXT'),
      ('DNA'), ('USD'), ('NYSE'), ('UTC'), ('ATH'), ('EOD'), ('YTD'),
      ('QOQ'), ('YOY'), ('EST'), ('EDT'), ('SEC'), ('FDA'), ('FED'),
      ('CPI'), ('GDP'), ('WSJ'), ('NNNN'), ('PT'), ('TP')
  ),
  lesson_symbols as (
    select
      l.id,
      l.thesis_id,
      l.created_at,
      l.summary,
      upper(sym.symbol) as symbol
    from public.research_lessons l
    cross join lateral (
      select x[1] as symbol
      from regexp_matches(
        coalesce(l.summary, ''),
        '(?:^|[^A-Za-z$])([A-Z]{2,5})(?::|\s+[-+]?\d+(?:\.\d+)?%|/)',
        'g'
      ) as x
      union
      select x[1]
      from regexp_matches(
        coalesce(l.summary, ''),
        '/([A-Z]{2,5})(?=/|[^A-Za-z]|$)',
        'g'
      ) as x
      union
      select x[1]
      from regexp_matches(
        coalesce(l.summary, ''),
        '(?:[(,]\s*)([A-Z]{2,5})(?=\s*[,)])',
        'g'
      ) as x
      union
      select upper(ts.symbol)
      from public.thesis_symbols ts
      where ts.thesis_id = l.thesis_id
        and coalesce(l.summary, '') ~ ('(^|[^A-Za-z])' || upper(ts.symbol) || '([^A-Za-z]|$)')
    ) sym
    where l.created_at >= timestamptz '2026-09-13 00:00:00+00'
      and upper(sym.symbol) ~ '^[A-Z]{2,5}$'
  ),
  lesson_clean as (
    select s.*
    from lesson_symbols s
    where not private.ontology_label_is_junk('membership', s.symbol)
      and not exists (select 1 from index_etf e where e.symbol = s.symbol)
      and (
        not exists (select 1 from lesson_prose p where p.symbol = s.symbol)
        or exists (
          select 1
          from public.thesis_symbols ts
          where ts.thesis_id = s.thesis_id
            and upper(ts.symbol) = s.symbol
        )
      )
  ),
  lesson_tagged as (
    select
      l.id,
      l.thesis_id,
      l.created_at,
      l.summary,
      l.symbol,
      n.n_sym,
      (
        l.summary ~* (
          '(reported|prints?|beats?|miss(?:ed)?|gaps?|reports?).{0,80}[^A-Za-z]'
          || l.symbol || '([^A-Za-z]|$)'
        )
        or l.summary ~* (
          '(^|[^A-Za-z])' || l.symbol
          || '[^A-Za-z].{0,80}(reported|prints?|beats?|miss(?:ed)?|gaps?|reports?)'
        )
      ) as earnings_subject,
      (
        l.summary ~* (
          '\m(hold|holding|held|chase|chasing)\M[^A-Za-z]{0,16}'
          || l.symbol || '([^A-Za-z]|$)'
        )
        or l.summary ~* (
          '(^|[^A-Za-z])' || l.symbol || '[^A-Za-z]{0,12}\m(hold|chase)\M'
        )
      ) as position_note,
      l.summary ~* ('(^|[^A-Za-z])' || l.symbol || ':') as colon_subject
    from lesson_clean l
    join (
      select id, count(distinct symbol)::integer as n_sym
      from lesson_clean
      group by id
    ) n on n.id = l.id
  ),
  lesson_raw as (
    select
      l.id::text as source_key,
      'research_lesson'::text as source_type,
      l.created_at as observed_at,
      0::smallint as score,
      left(regexp_replace(coalesce(l.summary, ''), '\s+', ' ', 'g'), 180) as excerpt,
      l.symbol,
      th.id as theme_id,
      l.earnings_subject,
      l.position_note,
      l.colon_subject,
      l.n_sym
    from lesson_tagged l
    left join public.ontology_themes th
      on th.status = 'active'
     and (th.id = l.thesis_id or th.thesis_id = l.thesis_id)
    where (
        th.id is null
        or not exists (
          select 1
          from public.symbol_theme_memberships m
          where m.symbol = l.symbol
            and m.theme_id = th.id
            and m.status = 'active'
        )
        or exists (
          select 1
          from public.ontology_candidates oc
          where oc.candidate_type = 'membership'
            and oc.candidate_key = th.id || ':' || l.symbol
        )
      )
      and not (
        exists (select 1 from open_equity h where h.symbol = l.symbol)
        and l.position_note
        and not l.earnings_subject
      )
      -- Earnings lessons stay in the evidence stream so an existing key can
      -- refresh. A new earnings_events key is still not inserted: a score-0
      -- lesson ticker is below the new-key gate.
  ),
  lesson_key_stats as (
    select
      coalesce(theme_id, 'unscoped') || ':' || symbol as candidate_key,
      count(distinct source_key)::integer as n_src,
      max(observed_at) as last_at
    from lesson_raw
    group by 1
  ),
  sector_activity as (
    select
      d.symbol,
      d.source_key,
      d.source_type,
      d.observed_at,
      left(
        case d.source_type
          when 'traded_lot' then 'traded lot ' || d.symbol
          else 'earnings sheet ' || d.symbol
        end,
        180
      ) as excerpt
    from private.sector_desk_symbols() d
  ),
  sector_clean as (
    select a.*
    from sector_activity a
    where not private.ontology_label_is_junk('membership', a.symbol)
      and not exists (select 1 from index_etf e where e.symbol = a.symbol)
  ),
  sector_known as (
    select
      c.symbol,
      c.source_key,
      c.source_type,
      c.observed_at,
      c.excerpt,
      p.theme_id
    from sector_clean c
    join public.symbol_sectors p
      on p.symbol = c.symbol
     and p.theme_id is not null
     and p.sector is not null
     and p.skip_reason is null
    join public.ontology_themes th
      on th.id = p.theme_id
     and th.status = 'active'
     and th.kind = 'sector'
  ),
  sector_lessons as (
    select
      l.id::text as source_key,
      'research_lesson'::text as source_type,
      l.created_at as observed_at,
      l.symbol,
      p.theme_id,
      left(regexp_replace(coalesce(l.summary, ''), '\s+', ' ', 'g'), 180) as excerpt
    from lesson_clean l
    join public.symbol_sectors p
      on p.symbol = l.symbol
     and p.theme_id is not null
     and p.sector is not null
     and p.skip_reason is null
    join public.ontology_themes th
      on th.id = p.theme_id
     and th.status = 'active'
     and th.kind = 'sector'
    where exists (
      select 1 from sector_clean c where c.symbol = l.symbol
    )
  ),
  incoming as (
    select
      'membership'::text as candidate_type,
      coalesce(theme_id, 'unscoped') || ':' || symbol as candidate_key,
      theme_id as proposed_theme_id,
      symbol as proposed_label,
      excerpt as description,
      score,
      source_type,
      source_key,
      observed_at
    from bookmark_themed
    where theme_id is not null
       or exists (
         select 1
         from public.ontology_candidates oc
         where oc.candidate_type = 'membership'
           and oc.candidate_key = 'unscoped:' || bookmark_themed.symbol
       )
       or not exists (
         select 1
         from public.ontology_candidates oc
         where oc.candidate_type = 'membership'
           and upper(oc.proposed_label) = bookmark_themed.symbol
       )
    union all
    select
      'membership'::text,
      coalesce(r.theme_id, 'unscoped') || ':' || r.symbol,
      r.theme_id,
      r.symbol,
      r.excerpt,
      r.score,
      r.source_type,
      r.source_key,
      r.observed_at
    from lesson_raw r
    join lesson_key_stats s
      on s.candidate_key = coalesce(r.theme_id, 'unscoped') || ':' || r.symbol
    where (
        exists (
          select 1
          from public.ontology_candidates oc
          where oc.candidate_type = 'membership'
            and oc.candidate_key = s.candidate_key
        )
        or (
          r.theme_id is distinct from 'earnings_events'
          and not exists (
            select 1
            from public.ontology_candidates oc
            where oc.candidate_type = 'membership'
              and oc.candidate_key = s.candidate_key
          )
          and (s.n_src >= 2 or s.last_at >= now() - interval '14 days')
          and (
            r.theme_id is not null
            or not exists (
              select 1
              from public.ontology_candidates oc
              where oc.candidate_type = 'membership'
                and upper(oc.proposed_label) = r.symbol
            )
          )
        )
      )
    union all
    select
      'membership'::text,
      k.theme_id || ':' || k.symbol,
      k.theme_id,
      k.symbol,
      k.excerpt,
      0::smallint,
      k.source_type,
      k.source_key,
      k.observed_at
    from sector_known k
    union all
    select
      'membership'::text,
      s.theme_id || ':' || s.symbol,
      s.theme_id,
      s.symbol,
      s.excerpt,
      0::smallint,
      s.source_type,
      s.source_key,
      s.observed_at
    from sector_lessons s
    where exists (
      select 1
      from sector_known k
      where k.symbol = s.symbol
        and k.theme_id = s.theme_id
    )
  ),
  admitted as (
    select i.*
    from incoming i
  ),
  revive_keys as (
    select oc.id, oc.candidate_type, oc.candidate_key
    from public.ontology_candidates oc
    join admitted i
      on i.candidate_type = oc.candidate_type
     and i.candidate_key = oc.candidate_key
    where oc.status = 'rejected'
      and not private.ontology_label_is_junk(oc.candidate_type, oc.proposed_label)
      and i.observed_at > coalesce(oc.reviewed_at, oc.first_seen_at)
      and not exists (
        select 1
        from public.ontology_candidate_evidence e
        where e.candidate_id = oc.id
          and e.source_type = i.source_type
          and e.source_key = i.source_key
      )
    group by oc.id, oc.candidate_type, oc.candidate_key
    having count(distinct i.source_type || ':' || i.source_key) >= 3
       and count(distinct i.source_key) >= 2
  ),
  dedup_evidence as (
    select distinct on (candidate_type, candidate_key, source_type, source_key)
      candidate_type, candidate_key, proposed_theme_id, proposed_label,
      description, score, source_type, source_key, observed_at
    from admitted
    order by candidate_type, candidate_key, source_type, source_key, score desc, observed_at desc
  ),
  candidate_rows as (
    select
      candidate_type,
      candidate_key,
      (array_agg(proposed_theme_id order by score desc, observed_at desc))[1] as proposed_theme_id,
      (array_agg(proposed_label order by score desc, observed_at desc))[1] as proposed_label,
      (array_agg(description order by score desc, observed_at desc))[1] as description,
      max(score)::smallint as score,
      case
        when bool_or(source_type in ('traded_lot', 'earnings_sheet')) then now()
        else min(observed_at)
      end as first_seen,
      max(observed_at) as last_seen,
      (array_agg(source_type order by observed_at desc))[1] as source_type
    from dedup_evidence
    group by candidate_type, candidate_key
  ),
  writable as (
    select c.*
    from candidate_rows c
    left join public.ontology_candidates oc
      on oc.candidate_type = c.candidate_type
     and oc.candidate_key = c.candidate_key
    where oc.id is null
       or oc.last_seen_at < c.last_seen
       or exists (
         select 1
         from revive_keys rk
         where rk.candidate_type = c.candidate_type
           and rk.candidate_key = c.candidate_key
       )
       or exists (
         select 1
         from dedup_evidence d
         where d.candidate_type = c.candidate_type
           and d.candidate_key = c.candidate_key
           and oc.id is not null
           and not exists (
             select 1
             from public.ontology_candidate_evidence e
             where e.candidate_id = oc.id
               and e.source_type = d.source_type
               and e.source_key = d.source_key
           )
       )
  ),
  upserted as (
    insert into public.ontology_candidates(
      candidate_type, candidate_key, proposed_theme_id, proposed_label,
      proposed_description, score, sample_context, first_seen_at, last_seen_at
    )
    select
      candidate_type,
      candidate_key,
      proposed_theme_id,
      proposed_label,
      coalesce(description, ''),
      score,
      jsonb_build_object(
        'source', source_type,
        'evidence_excerpt', coalesce(description, ''),
        'prompt_version', 'ledger-propose-v1'
      ),
      first_seen,
      last_seen
    from writable
    on conflict (candidate_type, candidate_key) do update set
      last_seen_at = greatest(public.ontology_candidates.last_seen_at, excluded.last_seen_at),
      status = case
        when public.ontology_candidates.status = 'rejected'
          and exists (
            select 1 from revive_keys rk
            where rk.candidate_type = public.ontology_candidates.candidate_type
              and rk.candidate_key = public.ontology_candidates.candidate_key
          )
          then 'pending'
        else public.ontology_candidates.status
      end,
      reviewed_at = case
        when public.ontology_candidates.status = 'rejected'
          and exists (
            select 1 from revive_keys rk
            where rk.candidate_type = public.ontology_candidates.candidate_type
              and rk.candidate_key = public.ontology_candidates.candidate_key
          )
          then null
        else public.ontology_candidates.reviewed_at
      end,
      review_note = case
        when public.ontology_candidates.status = 'rejected'
          and exists (
            select 1 from revive_keys rk
            where rk.candidate_type = public.ontology_candidates.candidate_type
              and rk.candidate_key = public.ontology_candidates.candidate_key
          )
          then null
        else public.ontology_candidates.review_note
      end,
      sample_context = case
        when public.ontology_candidates.status = 'rejected'
          and exists (
            select 1 from revive_keys rk
            where rk.candidate_type = public.ontology_candidates.candidate_type
              and rk.candidate_key = public.ontology_candidates.candidate_key
          )
          then excluded.sample_context
        when public.ontology_candidates.status = 'pending'
          and excluded.last_seen_at >= public.ontology_candidates.last_seen_at
          then excluded.sample_context
        else public.ontology_candidates.sample_context
      end
    returning id, candidate_type, candidate_key
  ),
  new_keys as (
    select c.candidate_type, c.candidate_key
    from candidate_rows c
    where not exists (
      select 1
      from public.ontology_candidates o
      where o.candidate_type = c.candidate_type
        and o.candidate_key = c.candidate_key
    )
  ),
  evidenced as (
    insert into public.ontology_candidate_evidence(
      candidate_id, source_type, source_key, evidence_score, context, observed_at
    )
    select
      u.id,
      d.source_type,
      d.source_key,
      d.score,
      jsonb_build_object(
        'evidence_excerpt', coalesce(d.description, ''),
        'prompt_version', 'ledger-propose-v1'
      ),
      d.observed_at
    from upserted u
    join dedup_evidence d using (candidate_type, candidate_key)
    on conflict (candidate_id, source_type, source_key) do update set
      evidence_score = greatest(public.ontology_candidate_evidence.evidence_score, excluded.evidence_score),
      context = excluded.context,
      observed_at = greatest(public.ontology_candidate_evidence.observed_at, excluded.observed_at)
    where public.ontology_candidate_evidence.observed_at is distinct from excluded.observed_at
       or public.ontology_candidate_evidence.evidence_score is distinct from excluded.evidence_score
       or public.ontology_candidate_evidence.context is distinct from excluded.context
    returning 1 as wrote
  )
  select
    (select count(*)::integer from new_keys),
    (select count(*)::integer from evidenced),
    (select coalesce(array_agg(id), '{}'::bigint[]) from upserted),
    greatest(
      0,
      (select count(*)::integer from upserted) - (select count(*)::integer from new_keys)
    ),
    (select count(distinct a.candidate_key)::integer
     from admitted a
     join public.ontology_candidates oc
       on oc.candidate_type = a.candidate_type
      and oc.candidate_key = a.candidate_key
     where oc.status = 'promoted'),
    (select count(distinct a.candidate_key)::integer
     from admitted a
     join public.ontology_candidates oc
       on oc.candidate_type = a.candidate_type
      and oc.candidate_key = a.candidate_key
     where oc.status = 'rejected'
       and not exists (select 1 from revive_keys rk where rk.id = oc.id)),
    (select count(distinct j.symbol)::integer
     from (
       select r.symbol
       from bookmark_raw r
       where private.ontology_label_is_junk('membership', r.symbol)
       union
       select s.symbol
       from lesson_symbols s
       where private.ontology_label_is_junk('membership', s.symbol)
       union
       select a.symbol
       from sector_activity a
       where private.ontology_label_is_junk('membership', a.symbol)
     ) j),
    (select count(distinct k.candidate_key)::integer
     from (
       select coalesce(r.theme_id, 'unscoped') || ':' || r.symbol as candidate_key
       from lesson_raw r
       union
       select 'unscoped:' || c.symbol
       from bookmark_clean c
       where not exists (
         select 1
         from bookmark_themed bt
         where bt.source_key = c.source_key
           and bt.symbol = c.symbol
           and bt.theme_id is not null
       )
     ) k
     where not exists (
       select 1
       from public.ontology_candidates oc
       where oc.candidate_type = 'membership'
         and oc.candidate_key = k.candidate_key
     )
     and not exists (
       select 1
       from admitted a
       where a.candidate_type = 'membership'
         and a.candidate_key = k.candidate_key
     )),
    (select count(*)::integer from revive_keys),
    (select count(distinct k.theme_id || ':' || k.symbol)::integer
     from sector_known k
     where k.source_type = 'traded_lot'),
    (select count(distinct k.theme_id || ':' || k.symbol)::integer
     from sector_known k
     where k.source_type = 'earnings_sheet'),
    (select count(distinct s.theme_id || ':' || s.symbol)::integer
     from sector_lessons s
     where exists (
       select 1 from sector_known k
       where k.symbol = s.symbol and k.theme_id = s.theme_id
     )),
    (select count(distinct c.symbol)::integer
     from sector_clean c
     where not exists (
       select 1
       from public.symbol_sectors p
       join public.ontology_themes th
         on th.id = p.theme_id
        and th.status = 'active'
        and th.kind = 'sector'
       where p.symbol = c.symbol
         and p.theme_id is not null
         and p.sector is not null
         and p.skip_reason is null
     ))
  into v_inserted, v_evidence, v_ids, v_refreshed,
       v_already_promoted, v_rejected_quiet, v_junk, v_below, v_resurrected,
       v_lot_keys, v_sheet_keys, v_lesson_keys, v_no_sector;

  -- A later statement sees the evidence just written. A sibling CTE would not.
  update public.ontology_candidates c set
    evidence_count = (
      select count(*) from public.ontology_candidate_evidence e where e.candidate_id = c.id
    ),
    source_count = (
      select count(distinct e.source_type || ':' || e.source_key)
      from public.ontology_candidate_evidence e
      where e.candidate_id = c.id
    ),
    score = greatest(
      c.score,
      coalesce((
        select max(e.evidence_score)
        from public.ontology_candidate_evidence e
        where e.candidate_id = c.id
      ), c.score)
    ),
    last_seen_at = greatest(
      c.last_seen_at,
      coalesce((
        select max(e.observed_at)
        from public.ontology_candidate_evidence e
        where e.candidate_id = c.id
      ), c.last_seen_at)
    )
  where c.id = any(v_ids);
  get diagnostics v_recounted = row_count;

  update public.symbol_theme_memberships m
  set
    evidence_count = c.evidence_count,
    source_count = c.source_count,
    last_seen_at = greatest(m.last_seen_at, c.last_seen_at)
  from public.ontology_candidates c
  where c.id = any(v_ids)
    and c.status = 'promoted'
    and c.candidate_type = 'membership'
    and c.proposed_theme_id is not null
    and m.theme_id = c.proposed_theme_id
    and m.symbol = upper(c.proposed_label)
    and m.status = 'active';

  -- The sweep's own gate is narrower than this trigger. A skipped sweep
  -- must not roll back the bookmark or lesson that fired it. New rows are
  -- already filtered by private.ontology_label_is_junk.
  begin
    v_rejected := private.reject_junk_ontology_candidates();
  exception
    when insufficient_privilege then
      v_rejected := jsonb_build_object('ok', false, 'rejected', 0, 'note', 'junk_sweep_skipped');
  end;

  return jsonb_build_object(
    'ok', true,
    'actor', v_actor,
    'inserted', v_inserted,
    'refreshed', v_refreshed,
    'evidence', v_evidence,
    'recounted', v_recounted,
    'pending', (
      select count(*)::integer
      from public.ontology_candidates
      where status = 'pending'
    ),
    'rejected', v_rejected,
    'last_first_seen_at', (select max(first_seen_at) from public.ontology_candidates),
    'created_7d', (
      select count(*)::integer
      from public.ontology_candidates
      where first_seen_at >= now() - interval '7 days'
    ),
    'resurrected', v_resurrected,
    'new_keys', v_inserted,
    'lot_keys', v_lot_keys,
    'sheet_keys', v_sheet_keys,
    'lesson_keys', v_lesson_keys,
    'no_sector', v_no_sector,
    'skipped_reasons', jsonb_build_object(
      'already_promoted', v_already_promoted,
      'rejected_no_new_evidence', v_rejected_quiet,
      'junk', v_junk,
      'below_threshold', v_below,
      'no_sector', v_no_sector
    ),
    'note', case
      when v_inserted = 0 then 'new evidence carried no new keys'
      else 'new keys proposed'
    end
  );
end;
$fn$;

comment on function private.propose_ontology_candidates() is
  'Propose membership ontology_candidates from market bookmarks classified since 2026-09-13, from research lessons, and from sector themes fed by traded lots and earnings sheets. A new earnings_events key is not opened from a research lesson. A sector key is theme_id:SYMBOL where the theme kind is sector and symbol_sectors has a company-facts sector. Lots (any status, 45 days or still open), earnings-sheet name lines, and a lesson that names the ticker are distinct evidence source types (traded_lot, earnings_sheet, research_lesson), so lot plus sheet plus lesson meets auto_promote_sources. A symbol with no sector is counted as no_sector and is not proposed. A new sector key records first_seen_at at proposal time so starved clears only when a candidate is inserted. An existing key, including a promoted one, gets evidence_count, source_count, and last_seen_at refreshed when new evidence matches, and an active symbol_theme_membership for that promoted key is refreshed the same way. A rejected key returns to pending only when at least 3 new evidence rows from at least 2 sources arrived after reviewed_at, and the junk deny list still blocks that return. skipped_reasons counts already_promoted, rejected_no_new_evidence, junk, below_threshold, and no_sector. Applies private.ontology_label_is_junk, then private.reject_junk_ontology_candidates.';

