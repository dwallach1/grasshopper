drop policy if exists thesisforge_site_snapshot_select on public.dashboard_snapshots;
create policy thesisforge_site_snapshot_select
on public.dashboard_snapshots
for select
to anon
using (
  id = 'current'
  and (
    select encode(
      extensions.digest(
        coalesce(
          current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-dashboard-token',
          ''
        ),
        'sha256'
      ),
      'hex'
    ) = '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a'
  )
);
