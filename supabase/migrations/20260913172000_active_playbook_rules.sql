-- Newest playbook_rule per thesis + domain. Phone reader + stewards SELECT
-- before size. No invented close rows — write path is documented INSERT.

create or replace view public.active_playbook_rules
with (security_invoker = true) as
select distinct on (b.thesis_id, b.domain_id)
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
order by b.thesis_id, b.domain_id, b.observed_at desc, b.created_at desc, b.id desc;

comment on view public.active_playbook_rules is
  'Newest playbook_rule belief per (thesis_id, domain_id). Load before size. Do not invent rows.';

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
     or btrim(p_domain_or_thesis) = ''
     or r.thesis_id = p_domain_or_thesis
     or r.domain_id::text = p_domain_or_thesis
     or r.domain_slug = p_domain_or_thesis;
$$;

comment on function public.active_playbook_rules(text) is
  'Filter active_playbook_rules by thesis_id, desk_domains.slug, or domain uuid. Null/empty = all.';

revoke all on function public.active_playbook_rules(text) from public, anon;
grant execute on function public.active_playbook_rules(text)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

grant select on public.active_playbook_rules
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker;

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
