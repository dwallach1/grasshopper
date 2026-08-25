-- Accept local-only tokens used by Miniflare / Vite against `supabase start`.
-- Plaintext values live only in committed `.dev.vars.example` files.

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
  if encode(extensions.digest(supplied_token, 'sha256'), 'hex') not in (
    '22464bba6b2c336e9650e5d172c62c3904aff03e18d9d025890e905592b7868c',
    'f70394889d68639604c5e41c25080393f7544bf5e96b276c7ac8eefa7e6f562e'
  ) then
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

create or replace function public.is_thesisforge_dashboard_reader()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      coalesce(
        current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-dashboard-token',
        ''
      ),
      'sha256'
    ),
    'hex'
  ) in (
    '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a',
    'f92815d42576ec7de57769076d2c547f8ee4811db0cba6fc1e8a94cfe212eef9',
    '329669fba60b385cfa668bb781897f56cdbecf54101b96b1d642c05473fd311b'
  );
$$;

create or replace function public.is_thesisforge_site_manager()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    encode(
      extensions.digest(
        coalesce(
          (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-dashboard-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) in (
      '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a',
      'f92815d42576ec7de57769076d2c547f8ee4811db0cba6fc1e8a94cfe212eef9',
      '329669fba60b385cfa668bb781897f56cdbecf54101b96b1d642c05473fd311b'
    )
    and encode(
      extensions.digest(
        coalesce(
          (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) in (
      '644fbeec6d5153114d1d24d36d95dbefbbb08c9a37d7386c7664def738078696',
      '9022c6a63dd1d8d166337c64103cfb27ec879a7e390d4241ca1df3bc5908f92b',
      '48e4a4f0f7d26f4c8f0764dffb572280e62ec090f2ae0e483f64f2a1ab9b7a44'
    )
    and (
      coalesce(
        (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-user-id'),
        ''
      ) = 'dc4218ec-f17c-4159-9d61-5ed54354ac50'
      or encode(
        extensions.digest(
          lower(
            coalesce(
              (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-user-id'),
              ''
            )
          ),
          'sha256'
        ),
        'hex'
      ) in (
        '68c1ad308ad4b806b9c0d4b2652c4899f2e44523fa5f6fb5d094559f59950e26',
        'c4cfc998df44884a2061a4ef3cc8b01d6e98c2c45c84273b0a91de79c4c50078'
      )
    );
$$;
