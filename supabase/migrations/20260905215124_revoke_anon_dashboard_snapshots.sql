-- Public phone desk is served from a Cloudflare Worker snapshot (KV).
-- Do not expose dashboard_snapshots (or any live table) to the anon PostgREST role.
revoke all on table public.dashboard_snapshots from anon, authenticated;

drop policy if exists quantanamo_site_snapshot_select on public.dashboard_snapshots;
drop policy if exists thesisforge_site_snapshot_select on public.dashboard_snapshots;

create or replace function public.is_quantanamo_dashboard_reader()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select false
$$;
revoke all on function public.is_quantanamo_dashboard_reader()
  from public, anon, authenticated, service_role;
