create or replace function private.attach_worker_observability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.payload := new.payload || jsonb_build_object(
    'automations', jsonb_build_array(
      jsonb_build_object(
        'id','research-orchestrator','name','Research orchestrator',
        'prompt','Scheduled thesis research, position review, and trade-intent coordination.',
        'kind','cloudflare_worker','status','ACTIVE',
        'rrule','RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=10,13,15;BYMINUTE=05',
        'model','Workers AI','reasoning_effort',null,'next_run_at',null,
        'last_run_at',(select max(started_at) from public.cloud_runs),
        'indexed_at',clock_timestamp(),
        'run_count',(select count(*) from public.cloud_runs),
        'passed_count',(select count(*) from public.cloud_runs where status='complete'),
        'failed_count',(select count(*) from public.cloud_runs where status='failed')
      ),
      jsonb_build_object(
        'id','knowledge-pipeline','name','Knowledge pipeline',
        'prompt','X bookmark sync, document archive, ontology learning, and dashboard projection.',
        'kind','cloudflare_worker','status','ACTIVE',
        'rrule','RRULE:FREQ=MINUTELY;INTERVAL=30',
        'model',null,'reasoning_effort',null,'next_run_at',null,
        'last_run_at',(select max(started_at) from public.runs where run_type='bookmark_ingest'),
        'indexed_at',clock_timestamp(),
        'run_count',(select count(*) from public.runs where run_type='bookmark_ingest'),
        'passed_count',(select count(*) from public.runs where run_type='bookmark_ingest' and completed_at is not null),
        'failed_count',0
      )
    ),
    'automation_runs', coalesce((
      select jsonb_agg(row_value order by started_at desc)
      from (
        select c.started_at,
          jsonb_build_object(
            'thread_id',c.id::text,'automation_id','research-orchestrator',
            'automation_name','Research orchestrator','status',c.status,
            'outcome',case when c.status='complete' then 'passed' when c.status='failed' then 'failed' when c.status in ('queued','running') then 'running' else 'unknown' end,
            'started_at',c.started_at,'completed_at',c.completed_at,
            'duration_ms',case when c.completed_at is null or c.started_at is null then null else extract(epoch from (c.completed_at-c.started_at))*1000 end,
            'title',coalesce(c.market_slot,'Scheduled research run'),
            'summary',coalesce(c.summary->>'summary',c.summary::text),
            'final_output',null,'findings','[]'::jsonb,'learnings','[]'::jsonb,
            'explored','[]'::jsonb,'actions',coalesce(c.summary->'actions','[]'::jsonb),
            'timeline','[]'::jsonb,'error_text',c.error_text,'tokens_used',null
          ) as row_value
        from public.cloud_runs c
        union all
        select r.started_at,
          jsonb_build_object(
            'thread_id','knowledge-' || r.id::text,'automation_id','knowledge-pipeline',
            'automation_name','Knowledge pipeline',
            'status',case when r.completed_at is null then 'running' else 'complete' end,
            'outcome',case when r.completed_at is null then 'running' else 'passed' end,
            'started_at',r.started_at,'completed_at',r.completed_at,
            'duration_ms',case when r.completed_at is null then null else extract(epoch from (r.completed_at-r.started_at))*1000 end,
            'title','Bookmark ingestion','summary',r.notes,
            'final_output',null,'findings','[]'::jsonb,'learnings','[]'::jsonb,
            'explored','[]'::jsonb,'actions','[]'::jsonb,'timeline','[]'::jsonb,
            'error_text',null,'tokens_used',null
          )
        from public.runs r where r.run_type='bookmark_ingest'
        order by started_at desc limit 200
      ) x
    ), '[]'::jsonb)
  );
  return new;
end;
$$;
revoke all on function private.attach_worker_observability() from public, anon, authenticated;
grant execute on function private.attach_worker_observability() to service_role;

drop trigger if exists dashboard_snapshots_worker_observability on public.dashboard_snapshots;
create trigger dashboard_snapshots_worker_observability
before insert or update of payload on public.dashboard_snapshots
for each row execute function private.attach_worker_observability();

