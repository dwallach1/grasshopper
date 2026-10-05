-- Learning-loop gaps: a closed lot whose thesis got no lesson or belief after the close.
-- Not a trading breach. /api/health stays ok when this count is above zero.
--
-- Linkage is the write stewards already use (docs/playbook-rules.md): same thesis_id,
-- and the row is newer than closed_at.
--   * public.research_lessons.created_at
--   * public.belief_updates.observed_at (created_at if observed_at is null)
-- Automatic outcome_rescore rows do not count. Those fire from the scoring trigger
-- and from court re-scores, not from a steward writing what the close taught.
-- playbook_rule, trade_close_lesson, autopsy, and a belief with no kind all count.
--
-- Grace is 18 hours. BANDIT's trade_close_lesson lands within minutes of the close;
-- 18 hours covers a late-US exit plus the next morning's pass. A full day would
-- leave a Sunday-night NFL exit silent until Monday night.
-- Lookback is 7 days, and lots with no thesis_id are omitted. Older closes and
-- untagged history are not retroactive homework, and an untagged lot cannot be
-- cleared by a thesis-linked write.

create or replace view public.v_learning_loop_gaps
with (security_invoker = true)
as
with closed as (
  select 'quantanamo'::text as steward,
         'position_episodes'::text as lot_table,
         pe.id as lot_id,
         pe.symbol as instrument,
         pe.thesis_id,
         pe.closed_at
  from public.position_episodes pe
  where pe.status in ('closed', 'settled', 'resolved', 'expired', 'redeemed')
    and nullif(btrim(pe.thesis_id), '') is not null
    and pe.closed_at is not null
    and pe.closed_at <= now() - interval '18 hours'
    and pe.closed_at > now() - interval '7 days'
  union all
  select 'oddsborne', 'pm_positions', p.id,
         coalesce(m.slug, m.question, p.outcome),
         p.thesis_id, p.closed_at
  from public.pm_positions p
  left join public.pm_markets m on m.id = p.market_id
  where p.status in ('closed', 'settled', 'resolved', 'expired', 'redeemed')
    and nullif(btrim(p.thesis_id), '') is not null
    and p.closed_at is not null
    and p.closed_at <= now() - interval '18 hours'
    and p.closed_at > now() - interval '7 days'
  union all
  select 'bandit', 'meme_positions', p.id,
         coalesce(t.symbol, t.mint, p.token_id::text),
         p.thesis_id, p.closed_at
  from public.meme_positions p
  left join public.meme_tokens t on t.id = p.token_id
  where p.status in ('closed', 'settled', 'resolved', 'expired', 'redeemed')
    and nullif(btrim(p.thesis_id), '') is not null
    and p.closed_at is not null
    and p.closed_at <= now() - interval '18 hours'
    and p.closed_at > now() - interval '7 days'
)
select c.steward, c.lot_table, c.lot_id, c.instrument, c.thesis_id, c.closed_at
from closed c
where not exists (
  select 1 from public.research_lessons l
  where l.thesis_id = c.thesis_id
    and l.created_at > c.closed_at
)
and not exists (
  select 1 from public.belief_updates b
  where b.thesis_id = c.thesis_id
    and coalesce(b.observed_at, b.created_at) > c.closed_at
    and coalesce(b.meta->>'kind', '') <> 'outcome_rescore'
);

comment on view public.v_learning_loop_gaps is
  'Closed lots in the last 7 days, past an 18h grace, whose thesis has no research_lesson or non-outcome_rescore belief_update written after closed_at. Learning-loop gap, not a trading breach.';

grant select on public.v_learning_loop_gaps
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

create or replace view public.v_ledger_watchdog
with (security_invoker = true)
as
select now() as checked_at,
  (select count(*) from public.v_invalidation_breaches)::integer as invalidation_breaches,
  (select count(*) from public.v_invalidation_breaches where action_hint = 'exit_full_lot')::integer as breaches_actionable,
  (select count(*) from public.v_invalidation_breaches where action_hint = 'review_at_open')::integer as breaches_review_at_open,
  (select count(*) from public.v_open_lots_missing_invalidation)::integer as lots_missing_invalidation,
  (select count(*) from public.v_ledger_integrity)::integer as integrity_issues,
  (select count(*) from public.v_ledger_integrity where severity = 'error')::integer as integrity_errors,
  coalesce((select jsonb_object_agg(c.check_name, c.n)
            from (select check_name, count(*)::integer as n from public.v_ledger_integrity group by check_name) c),
           '{}'::jsonb) as integrity,
  (select count(*) from public.v_open_lot_marks)::integer as open_lots,
  (select count(*) from public.v_exposure_usage where risk_headroom < 0)::integer as exposure_over_budget,
  coalesce((select jsonb_object_agg(x.steward, jsonb_build_object('unit', x.unit, 'open_risk', x.open_risk,
              'risk_budget', x.risk_budget, 'used_share', x.used_share, 'headroom', x.risk_headroom,
              'risk_basis', x.risk_basis))
            from public.v_exposure_usage x), '{}'::jsonb) as exposure,
  coalesce((
    select jsonb_build_object(
      'quantanamo', count(*) filter (where g.steward = 'quantanamo'),
      'oddsborne', count(*) filter (where g.steward = 'oddsborne'),
      'bandit', count(*) filter (where g.steward = 'bandit'),
      'lots', coalesce((
        select jsonb_agg(jsonb_build_object(
          'steward', recent.steward,
          'lot_table', recent.lot_table,
          'lot_id', recent.lot_id
        ) order by recent.closed_at desc)
        from (
          select steward, lot_table, lot_id, closed_at
          from public.v_learning_loop_gaps
          order by closed_at desc
          limit 24
        ) recent
      ), '[]'::jsonb)
    )
    from public.v_learning_loop_gaps g
  ), '{"quantanamo":0,"oddsborne":0,"bandit":0,"lots":[]}'::jsonb) as learning_gaps;

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, desk_public_reader, service_role;
