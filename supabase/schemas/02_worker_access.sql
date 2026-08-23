-- Least-privilege role used by trusted local and scheduled ThesisForge jobs.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'thesisforge_worker') then
    create role thesisforge_worker nologin noinherit;
  end if;
end $$;

-- Owner-only ThesisForge Sites reads use a publishable API key plus a
-- high-entropy server token. The token is never sent to the browser, and RLS
-- restricts this role to the single canonical dashboard row.
grant select on table public.dashboard_snapshots to anon;

drop policy if exists thesisforge_site_snapshot_select on public.dashboard_snapshots;
create policy thesisforge_site_snapshot_select
on public.dashboard_snapshots
for select
to anon
using (
  id = 'current'
  and encode(
    extensions.digest(
      coalesce(
        (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-dashboard-token'),
        ''
      ),
      'sha256'
    ),
    'hex'
  ) = '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a'
);

grant connect on database postgres to thesisforge_worker;
grant usage on schema public to thesisforge_worker;

do $$
declare
  target_table text;
  sequence_name text;
begin
  foreach target_table in array array[
    'runs','bookmarks','bookmark_urls','symbols','bookmark_symbols','claims','theses',
    'thesis_symbols','thesis_evidence','thesis_scores','catalysts','portfolio_exposure',
    'account_snapshots','trade_proposals','postmortems','articles','graph_nodes','graph_edges',
    'research_events','research_queue','predictions','insights','insight_links','thesis_relations',
    'event_decisions','research_cycles','strategy_tests','test_scenarios','agent_runs',
    'research_lessons','risk_controls','financial_api_requests','financial_request_cache',
    'financial_access_log','financial_records','dashboard_snapshots'
  ]
  loop
    execute format(
      'grant select, insert, update on table public.%I to thesisforge_worker',
      target_table
    );
    execute format(
      'create policy thesisforge_worker_select on public.%I for select to thesisforge_worker using (true)',
      target_table
    );
    execute format(
      'create policy thesisforge_worker_insert on public.%I for insert to thesisforge_worker with check (true)',
      target_table
    );
    execute format(
      'create policy thesisforge_worker_update on public.%I for update to thesisforge_worker using (true) with check (true)',
      target_table
    );

    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and information_schema.columns.table_name = target_table
        and column_name = 'id'
    ) then
      sequence_name := pg_get_serial_sequence(format('public.%I', target_table), 'id');
      if sequence_name is not null then
        execute format(
          'grant usage, select, update on sequence %s to thesisforge_worker',
          sequence_name
        );
      end if;
    end if;
  end loop;
end $$;
