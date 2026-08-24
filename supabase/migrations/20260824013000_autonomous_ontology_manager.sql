alter table public.ontology_themes
  drop constraint if exists ontology_themes_status_check;
alter table public.ontology_themes
  add constraint ontology_themes_status_check
  check (status in ('candidate', 'active', 'merged', 'retired', 'blacklisted'));

create table public.ontology_management_actions (
  id bigint generated always as identity primary key,
  actor_id text not null,
  entity_type text not null check (entity_type in ('theme', 'symbol')),
  entity_key text not null,
  action text not null check (action in ('promote', 'demote', 'blacklist', 'restore')),
  previous_state jsonb not null,
  next_state jsonb not null,
  created_at timestamptz not null default now()
);
create index idx_ontology_management_actions_entity_created
  on public.ontology_management_actions(entity_type, entity_key, created_at desc);
create index idx_ontology_management_actions_created
  on public.ontology_management_actions(created_at desc);

alter table public.ontology_management_actions enable row level security;
revoke all on table public.ontology_management_actions from public, anon, authenticated;
grant all on table public.ontology_management_actions to service_role;
grant all on sequence public.ontology_management_actions_id_seq to service_role;
grant select, insert, update on table public.ontology_management_actions to thesisforge_worker;
grant usage, select, update on sequence public.ontology_management_actions_id_seq to thesisforge_worker;

create policy thesisforge_worker_select
on public.ontology_management_actions for select to thesisforge_worker using (true);
create policy thesisforge_worker_insert
on public.ontology_management_actions for insert to thesisforge_worker with check (true);
create policy thesisforge_worker_update
on public.ontology_management_actions for update to thesisforge_worker using (true) with check (true);

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
    ) = '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a'
    and encode(
      extensions.digest(
        coalesce(
          (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) = '644fbeec6d5153114d1d24d36d95dbefbbb08c9a37d7386c7664def738078696'
    and coalesce(
      (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-user-id'),
      ''
    ) = 'dc4218ec-f17c-4159-9d61-5ed54354ac50';
$$;
revoke all on function public.is_thesisforge_site_manager() from public, authenticated, service_role;
grant execute on function public.is_thesisforge_site_manager() to anon;

grant select on table public.ontology_themes to anon;
grant select on table public.symbols to anon;
grant select on table public.ontology_candidates to anon;
grant select on table public.ontology_management_actions to anon;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'ontology_themes','symbols','ontology_candidates','ontology_management_actions'
  ]
  loop
    execute format('drop policy if exists thesisforge_site_manager_select on public.%I', target_table);
    execute format(
      'create policy thesisforge_site_manager_select on public.%I for select to anon using ((select public.is_thesisforge_site_manager()))',
      target_table
    );
  end loop;
end $$;

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
  if not (select public.is_thesisforge_site_manager()) then
    raise insufficient_privilege using message = 'Ontology manager authorization required';
  end if;

  actor_id := coalesce(
    (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-user-id'),
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
