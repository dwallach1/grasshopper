-- Last good public desk bundle.
--
-- grasshopper-desk rebuilds /bundle/public by fanning out about fifty
-- PostgREST reads. The authenticator role's statement_timeout is 8s, so
-- under that fan-out a core book read can die and the phone gets 503.
-- This row is the bundle those reads already produced. The edge function
-- reads it first and refreshes it off the request. It is not a price
-- source and it does not invent a mark: the payload is the last bundle
-- that passed the core-table check.
--
-- desk_public_reader is not granted this table. The public surface stays
-- the edge function. service_role (the function) is the only reader.

create table public.desk_public_bundle (
  id text primary key,
  generated_at timestamptz,
  payload jsonb,
  ready boolean not null default false,
  refresh_started_at timestamptz,
  refresh_failed_at timestamptz,
  constraint desk_public_bundle_id_chk check (id in ('public', 'full')),
  constraint desk_public_bundle_ready_chk check (
    ready = false
    or (
      payload is not null
      and generated_at is not null
      and jsonb_typeof(payload) = 'object'
    )
  )
);

comment on table public.desk_public_bundle is
  'Last good desk-public-rest bundle. service_role only. Not granted to desk_public_reader. Payload is a prior successful read, never an invented book.';

comment on column public.desk_public_bundle.ready is
  'True only after a core-table read stored a payload. A refresh lock row stays false and must not be served.';

comment on column public.desk_public_bundle.refresh_failed_at is
  'Set when a refresh threw after a ready payload existed. The payload stays the last good bundle.';

alter table public.desk_public_bundle enable row level security;

revoke all on table public.desk_public_bundle from public, anon, authenticated, desk_public_reader;
revoke all on table public.desk_public_bundle from quantanamo_worker, oddsborne_worker, bandit_worker;
grant select, insert, update on table public.desk_public_bundle to service_role;

-- One refresh at a time. A second caller gets false while the lock is younger
-- than 90s, which is longer than a bounded rebuild and shorter than a stuck one.
create or replace function public.claim_desk_public_refresh(p_id text)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  if p_id is null or p_id not in ('public', 'full') then
    return false;
  end if;

  insert into public.desk_public_bundle as bundle (id, ready, refresh_started_at)
  values (p_id, false, pg_catalog.now())
  on conflict (id) do update
    set refresh_started_at = pg_catalog.now()
    where bundle.refresh_started_at is null
       or bundle.refresh_started_at < pg_catalog.now() - interval '90 seconds'
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

comment on function public.claim_desk_public_refresh(text) is
  'Single-flight lock for rebuilding desk_public_bundle. Returns false when another refresh holds the lock. Does not write a book.';

revoke all on function public.claim_desk_public_refresh(text) from public;
revoke all on function public.claim_desk_public_refresh(text) from anon, authenticated, desk_public_reader;
revoke all on function public.claim_desk_public_refresh(text) from quantanamo_worker, oddsborne_worker, bandit_worker;
grant execute on function public.claim_desk_public_refresh(text) to service_role;
