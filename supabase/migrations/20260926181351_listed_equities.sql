-- Real listed tickers are not ontology junk.
-- The label deny-list is a list of *words* (it, uk, race, txn = transaction,
-- gfs = Google File System, mp = podcast acronym). Applying it to membership
-- candidates, whose label is a *ticker*, silently rejected real equities
-- (TXN, GFS, MP and 32 others). A membership candidate whose label is in the
-- verified registry below is never label-junk; review decides on context.
-- Term and theme candidates still use the deny-list.

create table if not exists public.listed_equities (
  symbol text primary key check (symbol = upper(btrim(symbol)) and symbol ~ '^[A-Z][A-Z0-9.]{0,5}$'),
  name text,
  exchange text,
  source text not null,
  verified_price numeric check (verified_price is null or verified_price > 0),
  verified_at timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.listed_equities is
  'Registry of tickers verified as live listed equities (Robinhood quote state=active and/or Financial Datasets company facts). A membership candidate whose label is here is never rejected by the ontology word deny-list. Add a row only after checking a live quote; set active=false on delisting.';

alter table public.listed_equities enable row level security;

grant select on public.listed_equities to authenticated, desk_public_reader, quantanamo_worker;
grant select, insert, update on public.listed_equities to quantanamo_worker, service_role;

drop policy if exists desk_public_reader_select on public.listed_equities;
create policy desk_public_reader_select on public.listed_equities
  for select to desk_public_reader using (true);
drop policy if exists ledger_operator_select on public.listed_equities;
create policy ledger_operator_select on public.listed_equities
  for select to authenticated using ((select public.is_ledger_operator()));
drop policy if exists quantanamo_worker_select on public.listed_equities;
create policy quantanamo_worker_select on public.listed_equities
  for select to quantanamo_worker using (true);
drop policy if exists quantanamo_worker_insert on public.listed_equities;
create policy quantanamo_worker_insert on public.listed_equities
  for insert to quantanamo_worker with check (true);
drop policy if exists quantanamo_worker_update on public.listed_equities;
create policy quantanamo_worker_update on public.listed_equities
  for update to quantanamo_worker using (true) with check (true);

-- Verified 2026-09-26 against Robinhood quotes (state=active, has_traded, last
-- regular-session print 2026-09-25). TXN/GFS/MP also via Financial Datasets.
insert into public.listed_equities (symbol, name, exchange, source, verified_price, verified_at)
values
  ('ADM', null, null, 'robinhood_quote', 81.13, '2026-09-25 20:00:00+00'),
  ('ARR', null, null, 'robinhood_quote', 14.095, '2026-09-25 20:00:00+00'),
  ('CAS', null, null, 'robinhood_quote', 24.1815, '2026-09-25 20:00:00+00'),
  ('CDC', null, null, 'robinhood_quote', 72.51, '2026-09-25 20:00:00+00'),
  ('COF', null, null, 'robinhood_quote', 200.11, '2026-09-25 20:00:00+00'),
  ('CWI', null, null, 'robinhood_quote', 41.03, '2026-09-25 20:00:00+00'),
  ('DHT', null, null, 'robinhood_quote', 21.78, '2026-09-25 20:00:00+00'),
  ('ET', null, null, 'robinhood_quote', 20.215, '2026-09-25 20:00:00+00'),
  ('GFS', 'GlobalFoundries Inc.', 'NASDAQ', 'robinhood_quote+financial_datasets', 48.99, '2026-09-25 20:00:00+00'),
  ('GT', null, null, 'robinhood_quote', 5.125, '2026-09-25 20:00:00+00'),
  ('IQ', null, null, 'robinhood_quote', 1.01, '2026-09-25 20:00:00+00'),
  ('IT', null, null, 'robinhood_quote', 187.87, '2026-09-25 20:00:00+00'),
  ('KB', null, null, 'robinhood_quote', 127.09, '2026-09-25 20:00:00+00'),
  ('MP', 'MP Materials Corp.', 'NYSE', 'robinhood_quote+financial_datasets', 48.82, '2026-09-25 20:00:00+00'),
  ('MS', null, null, 'robinhood_quote', 196.2601, '2026-09-25 20:00:00+00'),
  ('MSA', null, null, 'robinhood_quote', 182.48, '2026-09-25 20:00:00+00'),
  ('MT', null, null, 'robinhood_quote', 70.68, '2026-09-25 20:00:00+00'),
  ('NE', null, null, 'robinhood_quote', 42.82, '2026-09-25 20:00:00+00'),
  ('OSS', null, null, 'robinhood_quote', 9.29, '2026-09-25 20:00:00+00'),
  ('PRE', null, null, 'robinhood_quote', 22.94, '2026-09-25 20:00:00+00'),
  ('PTL', null, null, 'robinhood_quote', 275.28, '2026-09-25 20:00:00+00'),
  ('PUSH', null, null, 'robinhood_quote', 49.85, '2026-09-25 20:00:00+00'),
  ('RACE', null, null, 'robinhood_quote', 411.04, '2026-09-25 20:00:00+00'),
  ('REF', null, null, 'robinhood_quote', 12.375, '2026-09-25 20:00:00+00'),
  ('RPM', null, null, 'robinhood_quote', 100.46, '2026-09-25 20:00:00+00'),
  ('RTO', null, null, 'robinhood_quote', 20.665, '2026-09-25 20:00:00+00'),
  ('SF', null, null, 'robinhood_quote', 70.37, '2026-09-25 20:00:00+00'),
  ('SKHY', null, null, 'robinhood_quote', 191.51, '2026-09-25 20:00:00+00'),
  ('SRE', null, null, 'robinhood_quote', 77.94, '2026-09-25 20:00:00+00'),
  ('SSO', null, null, 'robinhood_quote', 70.96, '2026-09-25 20:00:00+00'),
  ('TLS', null, null, 'robinhood_quote', 4.05, '2026-09-25 20:00:00+00'),
  ('TPC', null, null, 'robinhood_quote', 84.02, '2026-09-25 20:00:00+00'),
  ('TXN', 'Texas Instruments Incorporated', 'NASDAQ', 'robinhood_quote+financial_datasets', 278.01, '2026-09-25 20:00:00+00'),
  ('UK', null, null, 'robinhood_quote', 2.10, '2026-09-25 20:00:00+00'),
  ('ZONE', null, null, 'robinhood_quote', 0.13, '2026-09-25 20:00:00+00')
on conflict (symbol) do nothing;

create or replace function public.is_listed_equity(p_label text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.listed_equities e
    where e.active
      and e.symbol = upper(btrim(coalesce(p_label, '')))
  );
$$;

comment on function public.is_listed_equity(text) is
  'True when the label is an active row in public.listed_equities.';

revoke all on function public.is_listed_equity(text) from public, anon;
grant execute on function public.is_listed_equity(text)
  to authenticated, desk_public_reader, quantanamo_worker, service_role;

-- PostgREST computed field: ontology_candidates?select=...,listed_equity
create or replace function public.listed_equity(c public.ontology_candidates)
returns boolean
language sql
stable
set search_path = ''
as $$
  select c.candidate_type = 'membership' and public.is_listed_equity(c.proposed_label);
$$;

comment on function public.listed_equity(public.ontology_candidates) is
  'Computed field: a membership candidate whose label is a verified listed equity. The desk uses it to keep real tickers out of the word deny-list.';

revoke all on function public.listed_equity(public.ontology_candidates) from public, anon;
grant execute on function public.listed_equity(public.ontology_candidates)
  to authenticated, desk_public_reader, quantanamo_worker, service_role;

-- Wrap the deny-list: a listed-equity membership is never junk.
do $do$
declare
  v_def text;
begin
  select pg_get_functiondef('private.ontology_label_is_junk(text,text)'::regprocedure) into v_def;
  if position('public.is_listed_equity' in v_def) = 0 then
    v_def := replace(
      v_def,
      E'  select\n    v = \'\'',
      E'  select\n    not (lower(coalesce(p_type, \'\')) = \'membership\' and public.is_listed_equity(p_label))\n    and (\n    v = \'\''
    );
    v_def := replace(
      v_def,
      E'        and lower(l.token) = v\n    )\n  from (',
      E'        and lower(l.token) = v\n    )\n    )\n  from ('
    );
    if position('public.is_listed_equity' in v_def) = 0 or position(E'    )\n    )\n  from (' in v_def) = 0 then
      raise exception 'ontology_label_is_junk shape changed; patch by hand';
    end if;
    execute v_def;
  end if;
end;
$do$;

comment on function private.ontology_label_is_junk(text, text) is
  'True when a candidate label is URL/SQL/listicle/discourse/IT-acronym/ticker-mashup/stopword junk. A membership whose label is in public.listed_equities is never junk. Keep labels in sync with ONTOLOGY_JUNK_LABELS / isJunkOntologyLabel.';

-- Unblock memberships the word list wrongly rejected. Back to pending with an
-- audited restore; manual rejections (e.g. MP "podcast acronym bleed") stay.
with restored as (
  select c.id, c.candidate_key, to_jsonb(c.*) as previous
  from public.ontology_candidates c
  where c.candidate_type = 'membership'
    and c.status = 'rejected'
    and c.review_note = 'junk_deny_list'
    and public.is_listed_equity(c.proposed_label)
),
updated as (
  update public.ontology_candidates c
  set status = 'pending',
      reviewed_at = null,
      review_note = 'unblocked: listed equity (was junk_deny_list); review on context'
  from restored r
  where c.id = r.id
  returning c.id, c.candidate_key, to_jsonb(c.*) as next_state, r.previous
)
insert into public.ontology_management_actions (actor_id, entity_type, entity_key, action, previous_state, next_state, created_at)
select 'listed_equities_migration', 'candidate', u.candidate_key, 'restore', u.previous, u.next_state, now()
from updated u;
