-- Operator incorporate: research_lessons.incorporated + playbook_rule belief_updates.
-- Operator incorporate of research_lessons. Public wrapper is INVOKER;
-- the private helper is DEFINER so it can UPDATE the lesson and INSERT
-- belief_updates the operator JWT cannot write directly. Phone /
-- desk_public_reader stay SELECT-only. The playbook artifact is the
-- existing belief_updates row (meta.kind = playbook_rule) that
-- active_playbook_rules already loads. Do not invent a parallel table.

do $$
begin
  if to_regclass('public.belief_updates') is null then
    return;
  end if;
  create unique index if not exists belief_updates_playbook_lesson_idx
    on public.belief_updates ((meta->>'research_lesson_id'))
    where coalesce(meta->>'kind', '') = 'playbook_rule'
      and nullif(meta->>'research_lesson_id', '') is not null;
end $$;

create or replace function private.incorporate_research_lesson(p_lesson_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text;
  v_lesson public.research_lessons%rowtype;
  v_belief_id uuid;
  v_replayed boolean := false;
  v_domain_id uuid;
  v_domain_slug text;
  v_steward text;
  v_rule text;
  v_rules jsonb;
begin
  if p_lesson_id is null or p_lesson_id <= 0 then
    raise exception 'lesson_required' using errcode = '22023';
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

  select * into v_lesson
    from public.research_lessons
   where id = p_lesson_id
   for update;
  if not found then
    raise exception 'lesson_not_found' using errcode = 'P0002';
  end if;

  select b.id into v_belief_id
    from public.belief_updates b
   where coalesce(b.meta->>'kind', '') = 'playbook_rule'
     and b.meta->>'research_lesson_id' = p_lesson_id::text
   order by b.observed_at desc, b.created_at desc, b.id desc
   limit 1;

  if v_belief_id is not null then
    v_replayed := true;
  else
    select td.domain_id, d.slug
      into v_domain_id, v_domain_slug
      from public.thesis_domains td
      join public.desk_domains d on d.id = td.domain_id
     where td.thesis_id = v_lesson.thesis_id
     order by d.sort_order, d.slug
     limit 1;

    if v_domain_slug = 'prediction' then
      v_steward := 'oddsborne';
    elsif v_domain_slug = 'meme' then
      v_steward := 'bandit';
    elsif v_domain_slug is not null then
      v_steward := 'quantanamo';
    end if;

    v_rule := trim(both '_' from lower(regexp_replace(
      btrim(coalesce(v_lesson.lesson_type, '')),
      '[^a-zA-Z0-9]+',
      '_',
      'g'
    )));
    if v_rule is null or v_rule = '' then
      v_rule := 'research_lesson';
    end if;
    v_rules := jsonb_build_array(v_rule);

    insert into public.belief_updates (
      thesis_id, domain_id, agent_id, prior_confidence, new_confidence,
      rationale, observed_at, meta
    ) values (
      v_lesson.thesis_id,
      v_domain_id,
      null,
      null,
      null,
      v_lesson.summary,
      now(),
      jsonb_strip_nulls(jsonb_build_object(
        'kind', 'playbook_rule',
        'source', 'operator_incorporate',
        'research_lesson_id', v_lesson.id,
        'lesson_type', v_lesson.lesson_type,
        'rules', v_rules,
        'steward', v_steward,
        'actor_id', v_actor
      ))
    )
    returning id into v_belief_id;
  end if;

  update public.research_lessons
     set incorporated = true
   where id = p_lesson_id
     and incorporated is distinct from true;

  return jsonb_build_object(
    'ok', true,
    'action', 'incorporate',
    'lesson_id', p_lesson_id,
    'incorporated', true,
    'replayed', v_replayed,
    'belief_id', v_belief_id,
    'thesis_id', v_lesson.thesis_id,
    'rules', coalesce(
      (select coalesce(b.meta->'rules', '[]'::jsonb)
         from public.belief_updates b
        where b.id = v_belief_id),
      '[]'::jsonb
    )
  );
end;
$$;

comment on function private.incorporate_research_lesson(bigint) is
  'Ledger-operator incorporate: mark research_lessons.incorporated and write a playbook_rule belief. Idempotent. Public phone cannot call this.';

revoke all on function private.incorporate_research_lesson(bigint) from public, anon;
grant execute on function private.incorporate_research_lesson(bigint)
  to authenticated, service_role;

create or replace function public.incorporate_research_lesson(p_lesson_id bigint)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.incorporate_research_lesson(p_lesson_id);
$$;

comment on function public.incorporate_research_lesson(bigint) is
  'Ledger-operator incorporate: mark a research_lesson incorporated and write belief_updates meta.kind = playbook_rule. Idempotent. Public phone cannot call this.';

revoke all on function public.incorporate_research_lesson(bigint) from public, anon;
grant execute on function public.incorporate_research_lesson(bigint)
  to authenticated, service_role;
