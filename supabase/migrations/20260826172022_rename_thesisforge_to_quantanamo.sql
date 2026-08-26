-- Rename ThesisForge brand identifiers to Quantanamo (role, policies, headers, helpers).

-- 1) Role: policies reference the role by OID, so rename preserves grants/RLS.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'thesisforge_worker')
     and not exists (select 1 from pg_roles where rolname = 'quantanamo_worker') then
    alter role thesisforge_worker rename to quantanamo_worker;
  elsif not exists (select 1 from pg_roles where rolname = 'quantanamo_worker') then
    create role quantanamo_worker nologin noinherit;
  end if;
end $$;

-- 2) Policy names: thesisforge_* → quantanamo_*
do $$
declare
  r record;
  new_name text;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where policyname like '%thesisforge%'
  loop
    new_name := replace(r.policyname, 'thesisforge', 'quantanamo');
    execute format(
      'alter policy %I on %I.%I rename to %I',
      r.policyname, r.schemaname, r.tablename, new_name
    );
  end loop;
end $$;

-- 3) Auth helper functions (new header names)
create or replace function public.is_quantanamo_dashboard_reader()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      coalesce(
        current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-dashboard-token',
        ''
      ),
      'sha256'
    ),
    'hex'
  ) in (
    '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a',
    'f92815d42576ec7de57769076d2c547f8ee4811db0cba6fc1e8a94cfe212eef9',
    -- local-dashboard-token-do-not-use-in-prod
    '329669fba60b385cfa668bb781897f56cdbecf54101b96b1d642c05473fd311b'
  );
$$;
revoke all on function public.is_quantanamo_dashboard_reader() from public, authenticated, service_role;
grant execute on function public.is_quantanamo_dashboard_reader() to anon;

create or replace function public.is_quantanamo_site_manager()
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
          (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-dashboard-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) in (
      '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a',
      'f92815d42576ec7de57769076d2c547f8ee4811db0cba6fc1e8a94cfe212eef9',
      -- local-dashboard-token-do-not-use-in-prod
      '329669fba60b385cfa668bb781897f56cdbecf54101b96b1d642c05473fd311b'
    )
    and encode(
      extensions.digest(
        coalesce(
          (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-manager-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) in (
      '644fbeec6d5153114d1d24d36d95dbefbbb08c9a37d7386c7664def738078696',
      '9022c6a63dd1d8d166337c64103cfb27ec879a7e390d4241ca1df3bc5908f92b',
      -- local-manager-token-do-not-use-in-prod
      '48e4a4f0f7d26f4c8f0764dffb572280e62ec090f2ae0e483f64f2a1ab9b7a44'
    )
    and (
      coalesce(
        (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-manager-user-id'),
        ''
      ) = 'dc4218ec-f17c-4159-9d61-5ed54354ac50'
      or encode(
        extensions.digest(
          lower(
            coalesce(
              (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-manager-user-id'),
              ''
            )
          ),
          'sha256'
        ),
        'hex'
      ) in (
        '68c1ad308ad4b806b9c0d4b2652c4899f2e44523fa5f6fb5d094559f59950e26',
        -- local@quantanamo.dev
        'c4cfc998df44884a2061a4ef3cc8b01d6e98c2c45c84273b0a91de79c4c50078'
      )
    );
$$;
revoke all on function public.is_quantanamo_site_manager() from public, authenticated, service_role;
grant execute on function public.is_quantanamo_site_manager() to anon;

-- 4) Recreate policies that call the old helper functions
drop policy if exists quantanamo_site_snapshot_select on public.dashboard_snapshots;
drop policy if exists thesisforge_site_snapshot_select on public.dashboard_snapshots;
create policy quantanamo_site_snapshot_select
on public.dashboard_snapshots
for select
to anon
using (
  id = 'current'
  and (select public.is_quantanamo_dashboard_reader())
);

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'ontology_themes','symbols','ontology_candidates','ontology_management_actions'
  ]
  loop
    execute format('drop policy if exists quantanamo_site_manager_select on public.%I', target_table);
    execute format('drop policy if exists thesisforge_site_manager_select on public.%I', target_table);
    execute format(
      'create policy quantanamo_site_manager_select on public.%I for select to anon using ((select public.is_quantanamo_site_manager()))',
      target_table
    );
  end loop;
end $$;

-- 5) Update functions that embedded old header / lock / helper names
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
    current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-publication-token',
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

  perform pg_advisory_xact_lock(hashtextextended('quantanamo-dashboard-publication', 0));
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

create or replace function public.manage_ontology_entity(
  p_entity_type text,
  p_entity_key text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text;
  previous_state jsonb;
  next_state jsonb;
begin
  if not (select public.is_quantanamo_site_manager()) then
    raise insufficient_privilege using message = 'Ontology manager authorization required';
  end if;

  actor_id := coalesce(
    (select current_setting('request.headers', true)::jsonb ->> 'x-quantanamo-manager-user-id'),
    ''
  );

  if p_entity_type = 'theme' then
    select to_jsonb(t) into previous_state
    from public.ontology_themes t where t.id=p_entity_key for update;
    if previous_state is null then
      raise no_data_found using message = 'Unknown ontology theme';
    end if;

    if p_action = 'promote' then
      insert into public.theses(
        id, name, summary, status, confidence, time_horizon, created_at, updated_at
      ) values (
        p_entity_key, previous_state->>'name', previous_state->>'description',
        'forming', 40, 'days_to_weeks', now(), now()
      ) on conflict(id) do nothing;
      update public.ontology_themes
      set thesis_id=coalesce(thesis_id, p_entity_key), status='active', updated_at=now()
      where id=p_entity_key;
      insert into public.ontology_terms(
        theme_id, term, normalized_term, term_type, weight, status,
        evidence_count, source_count, created_by, created_at, updated_at
      )
      select p_entity_key, c.proposed_label,
             trim(regexp_replace(lower(c.proposed_label), '[^a-z0-9.-]+', ' ', 'g')),
             'phrase', greatest(1, c.score), 'active', c.evidence_count,
             c.source_count, 'manager', now(), now()
      from public.ontology_candidates c
      where c.proposed_theme_id=p_entity_key and c.candidate_type='theme'
        and c.status='pending'
        and trim(regexp_replace(lower(c.proposed_label), '[^a-z0-9.-]+', ' ', 'g')) <> ''
      on conflict(theme_id, normalized_term) do update set
        weight=greatest(ontology_terms.weight, excluded.weight),
        status='active', evidence_count=excluded.evidence_count,
        source_count=excluded.source_count, updated_at=excluded.updated_at;
      update public.ontology_candidates
      set status='promoted', reviewed_at=now(), review_note='Manager override'
      where proposed_theme_id=p_entity_key and status='pending';
    elsif p_action = 'demote' then
      update public.ontology_themes set status='candidate', updated_at=now() where id=p_entity_key;
    elsif p_action = 'blacklist' then
      update public.ontology_themes set status='blacklisted', updated_at=now() where id=p_entity_key;
      update public.ontology_candidates
      set status='rejected', reviewed_at=now(), review_note='Theme blacklisted by manager'
      where proposed_theme_id=p_entity_key and status='pending';
    elsif p_action = 'restore' then
      update public.ontology_themes set status='candidate', updated_at=now() where id=p_entity_key;
    else
      raise check_violation using message = 'Unsupported theme action';
    end if;

    select to_jsonb(t) into next_state from public.ontology_themes t where t.id=p_entity_key;
  elsif p_entity_type = 'symbol' then
    select to_jsonb(s) into previous_state
    from public.symbols s where s.symbol=upper(p_entity_key) for update;
    if previous_state is null then
      raise no_data_found using message = 'Unknown ontology symbol';
    end if;

    if p_action = 'blacklist' then
      update public.symbols set status='blacklisted', last_seen_at=now() where symbol=upper(p_entity_key);
    elsif p_action = 'restore' or p_action = 'promote' then
      update public.symbols set status='verified', last_seen_at=now() where symbol=upper(p_entity_key);
    elsif p_action = 'demote' then
      update public.symbols set status='candidate', last_seen_at=now() where symbol=upper(p_entity_key);
    else
      raise check_violation using message = 'Unsupported symbol action';
    end if;

    select to_jsonb(s) into next_state from public.symbols s where s.symbol=upper(p_entity_key);
  else
    raise check_violation using message = 'Unsupported ontology entity type';
  end if;

  insert into public.ontology_management_actions(
    actor_id, entity_type, entity_key, action, previous_state, next_state
  ) values (actor_id, p_entity_type, p_entity_key, p_action, previous_state, next_state);

  return jsonb_build_object(
    'entity_type', p_entity_type,
    'entity_key', p_entity_key,
    'action', p_action,
    'entity', next_state
  );
end;
$$;
revoke all on function public.manage_ontology_entity(text, text, text) from public, authenticated, service_role;
grant execute on function public.manage_ontology_entity(text, text, text) to anon;

-- 6) Drop old helpers
drop function if exists public.is_thesisforge_dashboard_reader();
drop function if exists public.is_thesisforge_site_manager();
