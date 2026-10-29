-- Cumulative playbook rules. DISTINCT ON (thesis_id, domain_id) kept only the
-- newest row, so lessons written into belief_updates never bound at decision time.
-- A row stays in force unless it marks itself withdrawn, retired, or superseded,
-- or a newer playbook_rule names its id in meta.supersedes (text or array).
-- rule_status unproven_evidence_lost stays: that row is the current statement.
-- Lesson 178 withdraws an AI-hardware cohort rule that was never stored as a
-- playbook_rule, so there is no row to drop for it.
-- Declarative copy: supabase/schemas/06_playbook_rules.sql.

create or replace function public.playbook_rule_is_withdrawn(p_meta jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    (
      nullif(pg_catalog.btrim(coalesce(p_meta->>'withdrawn', '')), '') is not null
      and pg_catalog.lower(pg_catalog.btrim(p_meta->>'withdrawn')) not in ('false', 'f', '0', 'no')
    )
    or (
      nullif(pg_catalog.btrim(coalesce(p_meta->>'retired', '')), '') is not null
      and pg_catalog.lower(pg_catalog.btrim(p_meta->>'retired')) not in ('false', 'f', '0', 'no')
    )
    or (
      nullif(pg_catalog.btrim(coalesce(p_meta->>'superseded', '')), '') is not null
      and pg_catalog.lower(pg_catalog.btrim(p_meta->>'superseded')) not in ('false', 'f', '0', 'no')
    )
    or pg_catalog.lower(pg_catalog.btrim(coalesce(p_meta->>'status', ''))) in ('withdrawn', 'retired', 'superseded')
    or (
      coalesce(pg_catalog.jsonb_typeof(p_meta->'rule_status') = 'string', false)
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p_meta->>'rule_status', ''))) in ('withdrawn', 'retired', 'superseded')
    )
    or (
      coalesce(pg_catalog.jsonb_typeof(p_meta->'rule_status') = 'object', false)
      and exists (
        select 1
        from pg_catalog.jsonb_each_text(p_meta->'rule_status') status(slug, value)
        where pg_catalog.lower(pg_catalog.btrim(status.value)) in ('withdrawn', 'retired', 'superseded')
      )
    )
    or nullif(pg_catalog.btrim(coalesce(p_meta->>'superseded_by', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(p_meta->>'withdrawn_by', '')), '') is not null,
    false
  );
$$;

comment on function public.playbook_rule_is_withdrawn(jsonb) is
  'True when a playbook meta marks itself withdrawn, retired, or superseded. rule_status unproven_evidence_lost stays in force.';

create or replace function public.playbook_rule_supersedes(p_meta jsonb, p_id uuid)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    p_meta->>'supersedes' = p_id::text
    or (
      coalesce(pg_catalog.jsonb_typeof(p_meta->'supersedes') = 'array', false)
      and (p_meta->'supersedes') ? p_id::text
    ),
    false
  );
$$;

comment on function public.playbook_rule_supersedes(jsonb, uuid) is
  'True when meta.supersedes names p_id (a text id, or an array of ids).';

revoke all on function public.playbook_rule_is_withdrawn(jsonb) from public, anon;
revoke all on function public.playbook_rule_supersedes(jsonb, uuid) from public, anon;
grant execute on function public.playbook_rule_is_withdrawn(jsonb), public.playbook_rule_supersedes(jsonb, uuid)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create or replace view public.active_playbook_rules
with (security_invoker = true) as
select
  b.id,
  b.thesis_id,
  b.domain_id,
  d.slug as domain_slug,
  b.agent_id,
  b.prior_confidence,
  b.new_confidence,
  b.rationale,
  b.observed_at,
  coalesce(b.meta->'rules', '[]'::jsonb) as rules,
  nullif(b.meta->>'steward', '') as steward,
  nullif(b.meta->>'research_lesson_id', '') as research_lesson_id
from public.belief_updates b
left join public.desk_domains d on d.id = b.domain_id
where coalesce(b.meta->>'kind', '') = 'playbook_rule'
  and not public.playbook_rule_is_withdrawn(b.meta)
  and not exists (
    select 1
    from public.belief_updates newer
    where coalesce(newer.meta->>'kind', '') = 'playbook_rule'
      and newer.id <> b.id
      and public.playbook_rule_supersedes(newer.meta, b.id)
  );

comment on view public.active_playbook_rules is
  'Playbook rules still in force. Cumulative: a row drops only when it is withdrawn, retired, or superseded, or a newer playbook_rule names its id in meta.supersedes. Order with observed_at desc. Do not invent rows.';

create or replace function public.active_playbook_rules(p_domain_or_thesis text default null)
returns setof public.active_playbook_rules
language sql
stable
security invoker
set search_path = ''
as $$
  select r.*
  from public.active_playbook_rules r
  where p_domain_or_thesis is null
     or pg_catalog.btrim(p_domain_or_thesis) = ''
     or r.thesis_id = p_domain_or_thesis
     or r.domain_id::text = p_domain_or_thesis
     or r.domain_slug = p_domain_or_thesis
  order by r.observed_at desc nulls last, r.id desc;
$$;

comment on function public.active_playbook_rules(text) is
  'Active playbook rules, newest first. Same rows as the view. Filter by thesis_id, desk_domains.slug, or domain uuid. Null/empty = all.';

revoke all on function public.active_playbook_rules(text) from public, anon;
grant execute on function public.active_playbook_rules(text)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

grant select on public.active_playbook_rules
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker;
