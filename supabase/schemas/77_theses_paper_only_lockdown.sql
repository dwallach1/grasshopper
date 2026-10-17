-- theses.paper_only lockdown (court ruling 2026-10-17: paper-only theses, no real-money entries).
-- court-ruling: docs/rules/paper-only-theses.md
-- Follows 20261017131644_theses_paper_only (schemas/76). Two changes plus the registry row:
--   * thesis_max_stakes() (and v_thesis_max_stake, a security-invoker view over it, which the dashboard and the
--     phone view read) shows max_stake 0 and reason 'paper_only' for a paper_only thesis, so no screen shows a
--     stake that steward_sizing_guidance would refuse. trades and lcb are unchanged (they are evidence, not a
--     stake). Body otherwise as schemas/28; columns, SECURITY DEFINER, search_path '' and grants unchanged.
--   * theses.paper_only can be set or cleared only by postgres / service_role (the captain; supabase_admin is
--     the platform superuser). Trigger theses_paper_only_guard (BEFORE INSERT OR UPDATE OF paper_only) refuses
--     every other role, including quantanamo_worker, oddsborne_worker, bandit_worker and authenticated (ledger
--     operators), with refusal:paper_only. An insert that leaves the default (false) is not a change. The
--     function is SECURITY INVOKER so current_user is the caller. Column privileges were not used:
--     quantanamo_worker's table-level UPDATE (status, confidence and the other columns it writes) stays as is.
--   * desk_rules: the paper-only-theses row (tools/court/build_rules.py --upsert paper-only-theses).
-- Applied to production (xqungxapqicdmboniezz) 2026-10-17 as version 20261017131924 (theses_paper_only_lockdown);
-- this file is that SQL plus these two lines.

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
         case when t.paper_only then 0::numeric else m.max_stake end,
         case s.steward when 'bandit' then 'SOL' else 'USD' end,
         m.trades, m.lcb,
         case when t.paper_only then 'paper_only' else m.reason end
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

revoke all on function public.thesis_max_stakes() from public, anon;
grant execute on function public.thesis_max_stakes()
  to authenticated, service_role, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader;

create or replace function private.theses_paper_only_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.paper_only)
     or (tg_op = 'UPDATE' and new.paper_only is distinct from old.paper_only) then
    if current_user::text not in ('postgres', 'service_role', 'supabase_admin') then
      raise exception 'refusal:paper_only: only the captain (service_role) may set or clear theses.paper_only; % may not (thesis %)',
        current_user, new.id
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.theses_paper_only_guard() from public, anon, authenticated;

drop trigger if exists theses_paper_only_guard on public.theses;
create trigger theses_paper_only_guard
  before insert or update of paper_only on public.theses
  for each row execute function private.theses_paper_only_guard();

-- ---------------------------------------------------------------- registry
insert into public.desk_rules (rule_id, title, purpose, mechanism, owner_paths, status, verdict, ruling_summary, growth_cost, ruin_risk_reduction, statistics_note, gaming_analysis, interactions, needs_david, ruling_file, ruling_date, next_review_date) values
  ('paper-only-theses', 'Paper-only theses: no real-money entries', 'Forward-paper rules (BANDIT edge2-edge6) need theses rows for attribution and scoring, but must not move money until they earn promotion on forward paper trades. Before this, a forming row was enough for steward_sizing_guidance to hand BANDIT the starter on an untested rule; paper-only lived only in scan code.', '`public.theses.paper_only` (default false). When true: `steward_sizing_guidance` returns entry_allowed false, entry_blocked_reason `paper_only`, sized_notional 0 and max_stake 0 (reason `paper_only`); `thesis_max_stakes()` / `v_thesis_max_stake` (the dashboard and phone view) show max_stake 0, reason `paper_only`; `steward_log_decision` refuses an enter (`refusal:paper_only`) while skips log and score exactly as before; a `meme_orders` buy on the thesis is refused (trigger `refuse_paper_only_meme_buy`) and sells always pass. Only postgres / service_role (the captain) may set or clear the flag: trigger `theses_paper_only_guard` refuses any other role, including quantanamo_worker, oddsborne_worker, bandit_worker and authenticated (ledger operators). Flagged on 2026-10-17: meme_pullback_reclaim, meme_range_breakout, meme_grad_pullback, meme_liq_accum, meme_flush_rebound. Promotion: the captain clears the flag once the rule''s forward bar is met (n >= 20 forward paper trades, mean - SE > 0, mean > 0 with the top 2 winners removed).', array['supabase/schemas/76_theses_paper_only.sql', 'supabase/schemas/77_theses_paper_only_lockdown.sql']::text[], 'in_force', 'uphold', 'Uphold (captain decision 2026-10-17). Not a risk-budget tradeoff, so not for David. Amendment: None (new rule).', 'None: blocks only untested rules; promotion = the captain clears the flag once the forward bar is met.', 'Removes real-money entries on unproven paper rules (starter 0.1104 SOL each on 2026-10-17).', 'Forward paper trades are the only evidence these rules count (their preregs: backtests and OOS checks never count toward the 20). Keeping live money off them keeps the forward sample clean and the promotion test the one that was preregistered.', 'A steward can''t promote its own rule: workers and authenticated callers can neither clear nor set the flag, only the captain can. Tagging a paper rule''s trade with an unknown id is refused (thesis-status-blocks); tagging it with the live clip''s thesis would be misattribution visible in the ledger. Skips stay scoreable, so paper logging is not discouraged.', 'thesis-status-blocks (same blocking path in guidance), starter-stake and edge-max-stake (paper theses show max_stake 0), entry-cap-snapshot (a paper buy is refused before the snapshot), portfolio-exposure. Sells are always allowed so open lots can close; skips stay scoreable.', false, 'docs/rules/paper-only-theses.md', '2026-10-17'::date, '2027-01-17'::date)
on conflict (rule_id) do update set title = excluded.title, purpose = excluded.purpose, mechanism = excluded.mechanism, owner_paths = excluded.owner_paths, status = excluded.status, verdict = excluded.verdict, ruling_summary = excluded.ruling_summary, growth_cost = excluded.growth_cost, ruin_risk_reduction = excluded.ruin_risk_reduction, statistics_note = excluded.statistics_note, gaming_analysis = excluded.gaming_analysis, interactions = excluded.interactions, needs_david = excluded.needs_david, ruling_file = excluded.ruling_file, ruling_date = excluded.ruling_date, next_review_date = excluded.next_review_date, updated_at = now();
