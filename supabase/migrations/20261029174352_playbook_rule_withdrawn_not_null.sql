-- Missing meta keys made playbook_rule_is_withdrawn return null (false OR null).
-- NOT NULL dropped every row that lacked rule_status. Coalesce to false.
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
