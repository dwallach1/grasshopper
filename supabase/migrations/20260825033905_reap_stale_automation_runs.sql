-- Prevent automations from staying "running" forever when a Workflow aborts,
-- a queue message is lost, or a task never reaches a terminal status.

create or replace function private.reap_stale_automation_runs(
  p_run_max_age interval default interval '2 hours',
  p_task_max_age interval default interval '2 hours'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reaped_runs integer := 0;
  reaped_tasks integer := 0;
  now_ts timestamptz := clock_timestamp();
begin
  with updated as (
    update public.cloud_tasks as t
    set
      status = 'failed',
      error_text = coalesce(nullif(t.error_text, ''), 'stale_task_reaped'),
      completed_at = coalesce(t.completed_at, now_ts),
      updated_at = now_ts
    where t.status in ('queued', 'running')
      and coalesce(t.started_at, t.queued_at) < now_ts - p_task_max_age
    returning t.id
  )
  select count(*)::integer into reaped_tasks from updated;

  with updated as (
    update public.cloud_runs as r
    set
      status = 'failed',
      error_text = coalesce(nullif(r.error_text, ''), 'stale_run_reaped'),
      completed_at = coalesce(r.completed_at, now_ts),
      updated_at = now_ts,
      summary = coalesce(r.summary, '{}'::jsonb) || jsonb_build_object(
        'reaped_at', now_ts,
        'reap_reason', 'stale_nonterminal_run'
      )
    where r.status in ('queued', 'running')
      and coalesce(r.started_at, r.created_at) < now_ts - p_run_max_age
    returning r.id
  )
  select count(*)::integer into reaped_runs from updated;

  return jsonb_build_object(
    'reaped_runs', reaped_runs,
    'reaped_tasks', reaped_tasks,
    'reaped_at', now_ts
  );
end;
$$;
revoke all on function private.reap_stale_automation_runs(interval, interval)
  from public, anon, authenticated;
grant execute on function private.reap_stale_automation_runs(interval, interval)
  to service_role;

create or replace function public.reap_stale_automation_runs(
  p_run_max_age interval default interval '2 hours',
  p_task_max_age interval default interval '2 hours'
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.reap_stale_automation_runs(p_run_max_age, p_task_max_age);
$$;
revoke all on function public.reap_stale_automation_runs(interval, interval)
  from public, anon, authenticated;
grant execute on function public.reap_stale_automation_runs(interval, interval)
  to service_role;

create index if not exists idx_cloud_runs_nonterminal_started
  on public.cloud_runs (started_at)
  where status in ('queued', 'running');

create index if not exists idx_cloud_tasks_nonterminal_started
  on public.cloud_tasks (coalesce(started_at, queued_at))
  where status in ('queued', 'running');

create or replace function public.publish_dashboard_snapshot(
  p_trade_policy jsonb,
  p_publish_current boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  supplied_token text;
  generated_at timestamptz := clock_timestamp();
  target_id text := case when p_publish_current then 'current' else 'cloudflare-shadow' end;
  next_payload jsonb;
  current_payload jsonb;
  normalized_digest text;
  current_digest text;
  changed_keys jsonb;
  reap_result jsonb;
begin
  supplied_token := coalesce(
    current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-publication-token',
    ''
  );
  if encode(extensions.digest(supplied_token, 'sha256'), 'hex') not in (
    '22464bba6b2c336e9650e5d172c62c3904aff03e18d9d025890e905592b7868c',
    -- local-publication-token-do-not-use-in-prod
    'f70394889d68639604c5e41c25080393f7544bf5e96b276c7ac8eefa7e6f562e'
  ) then
    raise insufficient_privilege using message = 'Dashboard publication authorization required';
  end if;
  if p_trade_policy is null or jsonb_typeof(p_trade_policy) <> 'object' then
    raise check_violation using message = 'Trade policy must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('thesisforge-dashboard-publication', 0));
  reap_result := private.reap_stale_automation_runs();
  select payload into current_payload
  from public.dashboard_snapshots
  where id='current';

  next_payload := private.build_dashboard_snapshot(p_trade_policy, generated_at);
  insert into public.dashboard_snapshots(id, generated_at, payload)
  values (target_id, generated_at, next_payload)
  on conflict(id) do update
  set generated_at=excluded.generated_at, payload=excluded.payload;

  normalized_digest := private.dashboard_payload_digest(next_payload - 'generated_at');
  current_digest := case when current_payload is null then null
    else private.dashboard_payload_digest(current_payload - 'generated_at') end;
  select coalesce(jsonb_agg(k.key order by k.key), '[]'::jsonb)
  into changed_keys
  from jsonb_object_keys(next_payload - 'generated_at') as k(key)
  where current_payload is null
     or private.dashboard_payload_digest((next_payload - 'generated_at')->k.key)
        is distinct from private.dashboard_payload_digest(
          (current_payload - 'generated_at')->k.key
        );

  return jsonb_build_object(
    'target_id', target_id,
    'generated_at', generated_at,
    'normalized_sha256', normalized_digest,
    'current_normalized_sha256', current_digest,
    'matches_current', normalized_digest = current_digest,
    'changed_keys', changed_keys,
    'thesis_count', jsonb_array_length(next_payload->'theses'),
    'trading_enabled', false,
    'reaped_stale_automations', reap_result
  );
end;
$$;
revoke all on function public.publish_dashboard_snapshot(jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_dashboard_snapshot(jsonb, boolean)
  to service_role;

-- Heal currently stuck observability rows and refresh the Automations tab.
select private.reap_stale_automation_runs(interval '1 hour', interval '1 hour');

update public.dashboard_snapshots
set payload = payload
where id = 'current';
