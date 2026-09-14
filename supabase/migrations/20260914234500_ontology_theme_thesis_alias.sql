-- Stable concept-theme → sibling thesis map for review_ontology_candidate.
-- thesis_id is UNIQUE on ontology_themes, so unlinked concepts cannot bind
-- the live sibling thesis. ipo_events is intentionally unmapped.
-- Phone / desk_public_reader stay SELECT-only.

-- Stable concept → sibling theme/thesis. thesis_id is UNIQUE on themes, so
-- unlinked concepts (neocloud, photonics, …) cannot bind the live thesis.
-- ipo_events is intentionally absent. Keep in sync with ONTOLOGY_THEME_THESIS_ALIASES.
create or replace function private.ontology_theme_thesis_alias(p_theme_id text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case btrim(coalesce(p_theme_id, ''))
    when 'neocloud' then 'neocloud_compute'
    when 'nuclear' then 'ai_power_nuclear'
    when 'ai_power' then 'ai_power_nuclear'
    when 'photonics' then 'semis_photonics'
    when 'crypto_ai' then 'crypto'
    when 'earnings_events' then 'earnings_gap_structure'
    else null
  end;
$$;

comment on function private.ontology_theme_thesis_alias(text) is
  'Stable concept-theme → sibling thesis/theme id. ipo_events is unmapped. Prefer ontology_themes.thesis_id when set. Keep in sync with ONTOLOGY_THEME_THESIS_ALIASES.';

revoke all on function private.ontology_theme_thesis_alias(text) from public, anon;

create or replace function private.review_ontology_candidate(
  p_candidate_id bigint,
  p_action text,
  p_thesis_id text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text;
  v_action text;
  v_note text;
  v_candidate public.ontology_candidates%rowtype;
  v_previous jsonb;
  v_next jsonb;
  v_thesis_id text;
  v_theme_id text;
  v_owner_theme text;
  v_symbol text;
  v_normalized text;
  v_linked boolean := false;
  v_stub boolean := false;
  v_alias text;
begin
  v_action := lower(btrim(coalesce(p_action, '')));
  if v_action not in ('promote', 'reject', 'merge') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  v_actor := coalesce((select auth.uid())::text, '');
  if v_actor = '' then
    if current_user in ('service_role', 'postgres') then
      v_actor := current_user;
    else
      raise exception 'not_operator' using errcode = '42501';
    end if;
  elsif not (select private.is_ledger_operator()) then
    raise exception 'not_operator' using errcode = '42501';
  end if;

  select * into v_candidate
  from public.ontology_candidates
  where id = p_candidate_id
  for update;
  if not found then
    raise exception 'candidate_not_found' using errcode = 'P0002';
  end if;
  if v_candidate.status is distinct from 'pending' then
    raise exception 'candidate_not_pending' using errcode = '22023';
  end if;

  v_previous := to_jsonb(v_candidate);
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  v_thesis_id := nullif(btrim(coalesce(p_thesis_id, '')), '');

  if v_action = 'reject' then
    update public.ontology_candidates
    set
      status = 'rejected',
      reviewed_at = now(),
      review_note = coalesce(v_note, 'operator_reject')
    where id = p_candidate_id
    returning to_jsonb(ontology_candidates.*) into v_next;

    insert into public.ontology_management_actions(
      actor_id, entity_type, entity_key, action, previous_state, next_state, created_at
    ) values (
      v_actor, 'candidate', v_candidate.candidate_key, 'reject', v_previous, v_next, now()
    );

    return jsonb_build_object(
      'ok', true,
      'action', 'reject',
      'candidate_id', p_candidate_id,
      'status', 'rejected',
      'thesis_id', null,
      'theme_id', v_candidate.proposed_theme_id,
      'linked_existing_thesis', false,
      'created_thesis_stub', false
    );
  end if;

  if v_action = 'merge' and v_thesis_id is null then
    raise exception 'thesis_required' using errcode = '22023';
  end if;

  if v_thesis_id is not null then
    if not exists (select 1 from public.theses t where t.id = v_thesis_id) then
      raise exception 'thesis_not_found' using errcode = 'P0002';
    end if;
    v_linked := true;
  end if;

  v_theme_id := nullif(btrim(coalesce(v_candidate.proposed_theme_id, '')), '');
  if v_theme_id is null and v_candidate.candidate_type = 'theme' then
    v_theme_id := nullif(
      trim(both '_' from lower(regexp_replace(btrim(v_candidate.proposed_label), '[^a-zA-Z0-9]+', '_', 'g'))),
      ''
    );
  end if;

  if v_thesis_id is null and v_theme_id is not null then
    select coalesce(t.thesis_id, case when exists (
      select 1 from public.theses s where s.id = t.id
    ) then t.id end)
    into v_thesis_id
    from public.ontology_themes t
    where t.id = v_theme_id;
    if v_thesis_id is not null then
      v_linked := true;
    end if;
  end if;

  if v_thesis_id is null and v_theme_id is not null then
    v_alias := private.ontology_theme_thesis_alias(v_theme_id);
    if v_alias is not null then
      select coalesce(t.thesis_id, case when exists (
        select 1 from public.theses s where s.id = v_alias
      ) then v_alias end)
      into v_thesis_id
      from public.ontology_themes t
      where t.id = v_alias;
      if v_thesis_id is null and exists (
        select 1 from public.theses s where s.id = v_alias
      ) then
        v_thesis_id := v_alias;
      end if;
      if v_thesis_id is not null then
        v_linked := true;
      end if;
    end if;
  end if;

  if v_thesis_id is null then
    select s.id
    into v_thesis_id
    from public.theses s
    where s.id = v_theme_id
       or lower(s.name) = lower(btrim(v_candidate.proposed_label))
    order by case when s.id = v_theme_id then 0 else 1 end
    limit 1;
    if v_thesis_id is not null then
      v_linked := true;
    end if;
  end if;

  if v_candidate.candidate_type = 'membership' then
    if v_theme_id is null then
      raise exception 'theme_required' using errcode = '22023';
    end if;
    if not exists (select 1 from public.ontology_themes t where t.id = v_theme_id) then
      raise exception 'theme_required' using errcode = '22023';
    end if;
    v_symbol := upper(btrim(v_candidate.proposed_label));
    if not exists (select 1 from public.symbols s where s.symbol = v_symbol) then
      raise exception 'symbol_not_in_ledger' using errcode = '22023';
    end if;
    insert into public.symbol_theme_memberships(
      symbol, theme_id, relationship, confidence, evidence_count, source_count,
      status, learned_by, first_seen_at, last_seen_at
    ) values (
      v_symbol, v_theme_id, 'member', v_candidate.score, v_candidate.evidence_count,
      v_candidate.source_count, 'active', 'operator_review', v_candidate.first_seen_at, now()
    )
    on conflict (symbol, theme_id) do update set
      confidence = greatest(public.symbol_theme_memberships.confidence, excluded.confidence),
      evidence_count = excluded.evidence_count,
      source_count = excluded.source_count,
      status = 'active',
      learned_by = excluded.learned_by,
      last_seen_at = excluded.last_seen_at;

  elsif v_candidate.candidate_type = 'term' then
    if v_theme_id is null then
      raise exception 'theme_required' using errcode = '22023';
    end if;
    if not exists (select 1 from public.ontology_themes t where t.id = v_theme_id) then
      raise exception 'theme_required' using errcode = '22023';
    end if;
    v_normalized := lower(regexp_replace(btrim(v_candidate.proposed_label), '\s+', ' ', 'g'));
    if v_normalized = '' or v_normalized ~ '(^| )(http|https|www|t\.co)( |$)' then
      raise exception 'term_not_vocabulary' using errcode = '22023';
    end if;
    insert into public.ontology_terms(
      theme_id, term, normalized_term, term_type, weight, status,
      evidence_count, source_count, created_by, created_at, updated_at
    ) values (
      v_theme_id, v_candidate.proposed_label, v_normalized, 'alias',
      greatest(1, least(100, v_candidate.score)), 'active',
      v_candidate.evidence_count, v_candidate.source_count, 'operator_review', now(), now()
    )
    on conflict (theme_id, normalized_term) do update set
      weight = greatest(public.ontology_terms.weight, excluded.weight),
      status = 'active',
      evidence_count = excluded.evidence_count,
      source_count = excluded.source_count,
      updated_at = excluded.updated_at;

  elsif v_candidate.candidate_type = 'theme' then
    if v_theme_id is null then
      raise exception 'theme_required' using errcode = '22023';
    end if;
    if v_thesis_id is null then
      insert into public.theses(
        id, name, summary, status, confidence, time_horizon, created_at, updated_at
      ) values (
        v_theme_id, v_candidate.proposed_label, v_candidate.proposed_description,
        'forming', 40, 'days_to_weeks', now(), now()
      ) on conflict (id) do nothing;
      v_stub := found;
      if not v_stub then
        v_linked := true;
      end if;
      v_thesis_id := v_theme_id;
    end if;

    select t.id into v_owner_theme
    from public.ontology_themes t
    where t.thesis_id = v_thesis_id
    limit 1;

    if v_action = 'merge' and v_owner_theme is not null and v_owner_theme is distinct from v_theme_id then
      insert into public.ontology_themes(
        id, thesis_id, kind, name, description, status, merged_into_theme_id,
        match_threshold, auto_promote_sources, created_by, created_at, updated_at
      ) values (
        v_theme_id, null, 'theme', v_candidate.proposed_label, v_candidate.proposed_description,
        'merged', v_owner_theme, 35, 6, 'operator_review', now(), now()
      )
      on conflict (id) do update set
        status = 'merged',
        merged_into_theme_id = excluded.merged_into_theme_id,
        updated_at = now();
    else
      insert into public.ontology_themes(
        id, thesis_id, kind, name, description, status,
        match_threshold, auto_promote_sources, created_by, created_at, updated_at
      ) values (
        v_theme_id,
        case when v_owner_theme is null or v_owner_theme = v_theme_id then v_thesis_id end,
        'theme', v_candidate.proposed_label, v_candidate.proposed_description,
        'active', 35, 6, 'operator_review', now(), now()
      )
      on conflict (id) do update set
        thesis_id = coalesce(
          public.ontology_themes.thesis_id,
          case when v_owner_theme is null or v_owner_theme = v_theme_id then excluded.thesis_id end
        ),
        status = 'active',
        updated_at = now();
    end if;
  else
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  if v_theme_id is not null and v_thesis_id is not null then
    update public.ontology_themes t
    set thesis_id = v_thesis_id, updated_at = now()
    where t.id = v_theme_id
      and t.thesis_id is null
      and t.status is distinct from 'merged'
      and not exists (
        select 1
        from public.ontology_themes other
        where other.thesis_id = v_thesis_id
          and other.id <> t.id
      );
    if found then
      v_linked := true;
    end if;
  end if;

  update public.ontology_candidates
  set
    status = 'promoted',
    reviewed_at = now(),
    review_note = coalesce(v_note, 'operator_' || v_action)
  where id = p_candidate_id
  returning to_jsonb(ontology_candidates.*) into v_next;

  insert into public.ontology_management_actions(
    actor_id, entity_type, entity_key, action, previous_state, next_state, created_at
  ) values (
    v_actor, 'candidate', v_candidate.candidate_key, v_action, v_previous, v_next, now()
  );

  return jsonb_build_object(
    'ok', true,
    'action', v_action,
    'candidate_id', p_candidate_id,
    'status', 'promoted',
    'thesis_id', v_thesis_id,
    'theme_id', v_theme_id,
    'linked_existing_thesis', v_linked,
    'created_thesis_stub', v_stub
  );
end;
$$;

revoke all on function private.review_ontology_candidate(bigint, text, text, text) from public, anon;
grant execute on function private.review_ontology_candidate(bigint, text, text, text)
  to authenticated, service_role;
