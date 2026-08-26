-- Project cloud_tasks synthesis into Automations findings/learnings/explored/actions,
-- and surface knowledge schedule skipped/failed outcomes from runs.notes.
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
        'rrule','RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=10,15;BYMINUTE=05',
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
        'rrule','RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,14;BYMINUTE=35',
        'model',null,'reasoning_effort',null,'next_run_at',null,
        'last_run_at',(select max(started_at) from public.runs where run_type='bookmark_ingest'),
        'indexed_at',clock_timestamp(),
        'run_count',(select count(*) from public.runs where run_type='bookmark_ingest'),
        'passed_count',(select count(*) from public.runs where run_type='bookmark_ingest' and completed_at is not null
          and coalesce((case when notes ~ '^\s*\{' then notes::jsonb->>'outcome' end), 'passed') = 'passed'),
        'failed_count',(select count(*) from public.runs where run_type='bookmark_ingest'
          and coalesce((case when notes ~ '^\s*\{' then notes::jsonb->>'outcome' end), '') = 'failed')
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
            'final_output',null,
            'findings',coalesce(
              case when jsonb_typeof(c.summary->'findings')='array' then c.summary->'findings' end,
              (
                select coalesce(jsonb_agg(finding order by ord), '[]'::jsonb)
                from (
                  select trim(both from concat_ws(' · ',
                    nullif(t.entity_key, ''),
                    nullif(t.output->>'symbol', ''),
                    nullif(t.output->>'claim_status', ''),
                    left(coalesce(t.output->>'summary', ''), 240)
                  )) as finding,
                  row_number() over (order by t.completed_at nulls last, t.queued_at) as ord
                  from public.cloud_tasks t
                  where t.run_id=c.id
                    and t.status='complete'
                    and coalesce(t.output->>'summary', '') <> ''
                  limit 40
                ) findings
              ),
              '[]'::jsonb
            ),
            'learnings',coalesce(
              case when jsonb_typeof(c.summary->'learnings')='array' then c.summary->'learnings' end,
              (
                select coalesce(jsonb_agg(risk order by ord), '[]'::jsonb)
                from (
                  select risk, row_number() over (order by t.completed_at nulls last, t.queued_at, ordinality) as ord
                  from public.cloud_tasks t
                  cross join lateral jsonb_array_elements_text(coalesce(t.output->'risks', '[]'::jsonb))
                    with ordinality as risk(risk, ordinality)
                  where t.run_id=c.id and t.status='complete'
                  limit 40
                ) risks
              ),
              '[]'::jsonb
            ),
            'explored',coalesce(
              case when jsonb_typeof(c.summary->'explored')='array' then c.summary->'explored' end,
              (
                select coalesce(jsonb_agg(label order by label), '[]'::jsonb)
                from (
                  select distinct coalesce(nullif(t.output->>'symbol', ''), t.entity_key) as label
                  from public.cloud_tasks t
                  where t.run_id=c.id
                    and coalesce(nullif(t.output->>'symbol', ''), t.entity_key) is not null
                  limit 40
                ) explored
              ),
              '[]'::jsonb
            ),
            'actions',coalesce(
              case when jsonb_typeof(c.summary->'actions')='array' then c.summary->'actions' end,
              (
                select coalesce(jsonb_agg(action order by ord), '[]'::jsonb)
                from (
                  select action, row_number() over (order by t.completed_at nulls last, t.queued_at, ordinality) as ord
                  from public.cloud_tasks t
                  cross join lateral jsonb_array_elements_text(coalesce(t.output->'actions', '[]'::jsonb))
                    with ordinality as action(action, ordinality)
                  where t.run_id=c.id and t.status='complete'
                  limit 40
                ) actions
              ),
              '[]'::jsonb
            ),
            'timeline','[]'::jsonb,'error_text',c.error_text,'tokens_used',null
          ) as row_value
        from public.cloud_runs c
        union all
        select r.started_at,
          jsonb_build_object(
            'thread_id','knowledge-' || r.id::text,'automation_id','knowledge-pipeline',
            'automation_name','Knowledge pipeline',
            'status',case when r.completed_at is null then 'running' else 'complete' end,
            'outcome',case
              when r.completed_at is null then 'running'
              when coalesce((case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'outcome' end), '') = 'failed' then 'failed'
              when coalesce((case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'outcome' end), '') = 'skipped' then 'cancelled'
              else 'passed'
            end,
            'started_at',r.started_at,'completed_at',r.completed_at,
            'duration_ms',case when r.completed_at is null then null else extract(epoch from (r.completed_at-r.started_at))*1000 end,
            'title',case
              when coalesce((case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'outcome' end), '') = 'failed' then 'Bookmark ingest failed'
              when coalesce((case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'outcome' end), '') = 'skipped' then 'Bookmark ingest skipped'
              else 'Bookmark ingestion'
            end,
            'summary',r.notes,
            'final_output',null,'findings','[]'::jsonb,'learnings','[]'::jsonb,
            'explored','[]'::jsonb,'actions','[]'::jsonb,'timeline','[]'::jsonb,
            'error_text',case when r.notes ~ '^\s*\{' then r.notes::jsonb->>'error' else null end,
            'tokens_used',null
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
