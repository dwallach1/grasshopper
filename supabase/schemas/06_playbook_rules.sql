-- Active playbook rules: every belief_updates row with meta.kind = playbook_rule
-- that is still in force. Rules accumulate. A newer row replaces an older one
-- only when meta.supersedes names that row, or the row marks itself withdrawn,
-- retired, or superseded. Stewards SELECT this before size.
-- Table public.belief_updates is created in meme_ledger_v1 (hosted out of band).
-- View is security_invoker so caller RLS on belief_updates applies.
-- Callers that want newest first: order by observed_at desc, id desc.
-- The function below already does.
-- Helpers stay security invoker with an empty search_path. The view calls
-- them as the reader, so execute is granted to the same roles as the view.

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

-- Public phone + stewards can read the source table. Writes stay worker/operator.
do $$
begin
  if to_regclass('public.belief_updates') is null then
    return;
  end if;
  grant select on public.belief_updates to desk_public_reader, quantanamo_worker, oddsborne_worker;
  grant insert on public.belief_updates to quantanamo_worker, oddsborne_worker, bandit_worker;
  revoke insert, update, delete, truncate on public.belief_updates from desk_public_reader;

  drop policy if exists desk_public_reader_select on public.belief_updates;
  create policy desk_public_reader_select on public.belief_updates
    for select to desk_public_reader using (true);

  if to_regclass('public.thesis_domains') is not null then
    grant select on public.thesis_domains to desk_public_reader, quantanamo_worker, oddsborne_worker;
    revoke insert, update, delete, truncate on public.thesis_domains from desk_public_reader;
    drop policy if exists desk_public_reader_select on public.thesis_domains;
    create policy desk_public_reader_select on public.thesis_domains
      for select to desk_public_reader using (true);
  end if;

  drop policy if exists belief_updates_quantanamo_select on public.belief_updates;
  create policy belief_updates_quantanamo_select on public.belief_updates
    for select to quantanamo_worker using (true);
  drop policy if exists belief_updates_quantanamo_insert on public.belief_updates;
  create policy belief_updates_quantanamo_insert on public.belief_updates
    for insert to quantanamo_worker with check (true);
  drop policy if exists belief_updates_oddsborne_select on public.belief_updates;
  create policy belief_updates_oddsborne_select on public.belief_updates
    for select to oddsborne_worker using (true);
  drop policy if exists belief_updates_oddsborne_insert on public.belief_updates;
  create policy belief_updates_oddsborne_insert on public.belief_updates
    for insert to oddsborne_worker with check (true);
  drop policy if exists belief_updates_bandit_select on public.belief_updates;
  create policy belief_updates_bandit_select on public.belief_updates
    for select to bandit_worker using (true);
  drop policy if exists belief_updates_bandit_insert on public.belief_updates;
  create policy belief_updates_bandit_insert on public.belief_updates
    for insert to bandit_worker with check (true);
end $$;
