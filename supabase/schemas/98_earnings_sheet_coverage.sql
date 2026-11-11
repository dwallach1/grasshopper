-- Earnings sheet coverage (lessons 190, 230, 245).
-- earnings_sheet.py ranks the full high-cap calendar and writes one research_queue
-- row (priority 1, source earnings_sheet), the same shape the autopsy sheet uses.
-- A calendar symbol that is not in public.symbols yet is inserted, so the next
-- screen can see it. PLTR is refused. No price is stored. This does not size or
-- place an order.
-- Retired seats (oddsborne_worker, bandit_worker) get no grant.

create or replace function public.steward_symbols_present(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_present jsonb;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not read symbols for the earnings sheet', current_user
      using errcode = '42501';
  end if;
  if jsonb_typeof(p->'symbols') is distinct from 'array' then
    raise exception 'refusal:sheet: symbols must be an array' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(s.symbol order by s.symbol), '[]'::jsonb)
    into v_present
  from public.symbols s
  where s.symbol in (
    select distinct upper(btrim(value))
    from jsonb_array_elements_text(p->'symbols') as t(value)
    where upper(btrim(value)) ~ '^[A-Z][A-Z0-9.]{0,9}$'
  );
  return jsonb_build_object('present', v_present);
end;
$$;

comment on function public.steward_symbols_present(jsonb) is
  'Which of these tickers are already in public.symbols. Read-only. Does not add PLTR or anyone else.';

revoke all on function public.steward_symbols_present(jsonb) from public, anon, authenticated;
revoke all on function public.steward_symbols_present(jsonb) from oddsborne_worker, bandit_worker;
grant execute on function public.steward_symbols_present(jsonb) to quantanamo_worker, service_role;

create or replace function public.steward_write_earnings_sheet(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_symbol text;
  v_inserted text[] := '{}';
  v_outside integer;
  v_id bigint;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not write the earnings sheet', current_user
      using errcode = '42501';
  end if;
  if jsonb_typeof(p->'calendar_symbols') is distinct from 'array'
     or jsonb_typeof(p->'ranked_symbols') is distinct from 'array' then
    raise exception 'refusal:sheet: calendar_symbols and ranked_symbols must be arrays'
      using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p->>'topic', '')), '') is null
     or coalesce(p->>'reason', '') not like 'coverage ranked=%' then
    raise exception 'refusal:sheet: topic is required and reason must start with the coverage line'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p->'calendar_symbols') as t(value)
    where upper(btrim(value)) = 'PLTR'
  ) or exists (
    select 1 from jsonb_array_elements_text(p->'ranked_symbols') as t(value)
    where upper(btrim(value)) = 'PLTR'
  ) then
    raise exception 'refusal:sheet: PLTR is not a candidate' using errcode = 'P0001';
  end if;

  -- Count names that were not in public.symbols before this write. A later insert
  -- does not turn them into "already in the universe".
  select count(*)::integer into v_outside
  from (
    select distinct upper(btrim(value)) as symbol
    from jsonb_array_elements_text(p->'ranked_symbols') as t(value)
  ) names
  where names.symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'
    and not exists (select 1 from public.symbols s where s.symbol = names.symbol);

  for v_symbol in
    select distinct upper(btrim(value))
    from jsonb_array_elements_text(p->'calendar_symbols') as t(value)
    where upper(btrim(value)) ~ '^[A-Z][A-Z0-9.]{0,9}$'
    order by 1
  loop
    if exists (select 1 from public.symbols s where s.symbol = v_symbol) then
      continue;
    end if;
    -- Not a bookmark mention. Zero counts so this row does not look like one.
    insert into public.symbols (symbol, first_seen_at, last_seen_at, mention_count, source_count, status)
    values (v_symbol, now(), now(), 0, 0, 'candidate')
    on conflict (symbol) do nothing;
    v_inserted := v_inserted || v_symbol;
  end loop;

  update public.research_queue
     set status = 'done', updated_at = now()
   where source = 'earnings_sheet'
     and status = 'open';

  insert into public.research_queue (priority, status, topic, reason, source, created_at, updated_at)
  values (1, 'open', btrim(p->>'topic'), p->>'reason', 'earnings_sheet', now(), now())
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'inserted_symbols', to_jsonb(v_inserted),
    'outside_symbols', v_outside,
    'source', 'earnings_sheet',
    'priority', 1
  );
end;
$$;

comment on function public.steward_write_earnings_sheet(jsonb) is
  'One earnings-sheet research_queue row at priority 1, source earnings_sheet, plus any calendar symbol missing from public.symbols. Closes the previous open earnings_sheet row. Refuses PLTR. Does not size or place an order.';

revoke all on function public.steward_write_earnings_sheet(jsonb) from public, anon, authenticated;
revoke all on function public.steward_write_earnings_sheet(jsonb) from oddsborne_worker, bandit_worker;
grant execute on function public.steward_write_earnings_sheet(jsonb) to quantanamo_worker, service_role;

-- Latest script sheet. Empty when earnings_sheet.py has not written one.
-- outside_symbols is null when the coverage line has no number (the symbols
-- list was missing). A regression that ranks nobody outside public.symbols
-- shows 0. Does not make /api/health not-ok.
create or replace view public.v_earnings_sheet_coverage
with (security_invoker = true)
as
select q.id,
       q.created_at,
       q.status,
       q.topic,
       substring(q.reason from 'ranked=([0-9]+)')::integer as ranked,
       substring(q.reason from 'outside_symbols=([0-9]+)')::integer as outside_symbols,
       substring(q.reason from 'beat_history_6of6=([0-9]+)')::integer as beat_history_6of6,
       substring(q.reason from 'quality_drawdown=([0-9]+)')::integer as quality_drawdown,
       substring(q.reason from 'crash_dump_am=([0-9]+)')::integer as crash_dump_am,
       substring(q.reason from 'no_history=([0-9]+)')::integer as no_history
from public.research_queue q
where q.source = 'earnings_sheet'
order by q.created_at desc
limit 1;

comment on view public.v_earnings_sheet_coverage is
  'The latest research_queue row written by earnings_sheet.py. outside_symbols counts calendar names that were not in public.symbols. Null when that count was not on the row. Empty when the script has not written a sheet. Does not make /api/health not-ok.';

revoke all on public.v_earnings_sheet_coverage from public, anon, oddsborne_worker, bandit_worker;
grant select on public.v_earnings_sheet_coverage
  to authenticated, quantanamo_worker, desk_public_reader, service_role;
