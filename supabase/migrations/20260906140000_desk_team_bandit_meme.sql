-- BANDIT + Meme coins. Soft stewardship on desk_domain_stewards — no table rename.
--
-- Live `meme_ledger_v1` creates meme_* and GRANTs SELECT to quantanamo_worker.
-- GRANT is not enough for desk:publish: every new domain lane also needs
-- policy quantanamo_worker_select ... using (true) — see
-- 20260906155358_meme_quantanamo_worker_select_rls.sql (same as pm_*).

insert into public.desk_domains (slug, name, kind, description, accent, status, sort_order)
values (
  'meme',
  'Meme coins',
  'trading',
  'Meme / pump-style venues. Steward soft-assigned — BANDIT today, rotatable without migration.',
  '#f59e0b',
  'active',
  30
)
on conflict (slug) do nothing;

insert into public.desk_agents (slug, display_name, role_title, charter, accent, avatar_key, status, heartbeat_at, sort_order)
values (
  'bandit',
  'BANDIT',
  'Meme-coin trader',
  'Owns meme-coin research and execution under Grasshopper. Domain: Meme coins. Never invent marks — write venue fills and marks into the ledger only.',
  '#f59e0b',
  'bandit',
  'idle',
  null,
  4
)
on conflict (slug) do nothing;

insert into public.desk_domain_stewards (domain_id, agent_id, is_primary, note)
select d.id, a.id, true, 'Initial seed'
from public.desk_domains d
join public.desk_agents a
  on d.slug = 'meme' and a.slug = 'bandit'
where not exists (
  select 1
  from public.desk_domain_stewards s
  where s.domain_id = d.id
    and s.agent_id = a.id
    and s.ended_at is null
);
