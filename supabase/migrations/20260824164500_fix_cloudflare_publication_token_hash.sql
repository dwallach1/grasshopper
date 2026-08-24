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
begin
  supplied_token := coalesce(
    current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-publication-token',
    ''
  );
  if encode(extensions.digest(supplied_token, 'sha256'), 'hex') <> 'a1d1ec8f0148d08edd7373dc60b1f2c13e7e86558751e4007fbae7ebd39b2daa' then
    raise insufficient_privilege using message = 'Dashboard publication authorization required';
  end if;
  if p_trade_policy is null or jsonb_typeof(p_trade_policy) <> 'object' then
    raise check_violation using message = 'Trade policy must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('thesisforge-dashboard-publication', 0));
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
    'trading_enabled', false
  );
end;
$$;
revoke all on function public.publish_dashboard_snapshot(jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_dashboard_snapshot(jsonb, boolean)
  to service_role;
