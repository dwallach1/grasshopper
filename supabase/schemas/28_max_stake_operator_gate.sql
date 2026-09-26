-- thesis_max_stakes() is SECURITY DEFINER and executable by authenticated.
-- Gate signed-in callers to ledger operators; same columns and body otherwise.

create or replace function public.thesis_max_stakes()
returns table (
  steward text, thesis_id text, name text, status text, confidence smallint,
  max_stake numeric, unit text, trades integer, lcb numeric, reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.steward, t.id, t.name, t.status, t.confidence,
         m.max_stake, case s.steward when 'bandit' then 'SOL' else 'USD' end,
         m.trades, m.lcb, m.reason
  from public.theses t
  cross join lateral (
    select coalesce(
      (select o.steward from public.trade_outcomes o where o.thesis_id = t.id
        group by o.steward order by count(*) desc limit 1),
      (select a.slug from public.thesis_domains td
         join public.desk_domain_stewards ds on ds.domain_id = td.domain_id and ds.ended_at is null
         join public.desk_agents a on a.id = ds.agent_id
        where td.thesis_id = t.id and a.slug in ('quantanamo', 'oddsborne', 'bandit')
        order by ds.is_primary desc limit 1),
      'quantanamo') as steward
  ) s
  cross join lateral private.edge_max_stake(s.steward, t.id,
    (select e.equity from private.steward_book_equity(s.steward) e)) m
  where t.status not in ('rejected', 'killed')
    -- A signed-in caller must be a ledger operator (advisor 0029); worker roles,
    -- desk_public_reader and direct Postgres are unchanged.
    and (coalesce((select auth.role()), '') <> 'authenticated' or (select public.is_ledger_operator()));
$$;

