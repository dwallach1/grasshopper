-- Earnings sheet entry session and a staleness watchdog (lesson 260).
-- An AM printer can be entered only on the prior RTH session. A Friday sheet
-- has to include Monday AM, and the session before a holiday has to include
-- the next trading morning. earnings_sheet.py ranks by that entry session.
-- The watchdog flags a missing source=earnings_sheet row for the latest
-- entry session. It does not change a belief, a playbook rule, or
-- incorporated, and it does not make /api/health not-ok.
-- Retired seats (oddsborne_worker, bandit_worker) get no grant.
-- desk_public_reader already selects research_queue and the calendar. Execute
-- on this function is what the security-invoker view needs to call it.

create or replace function public.earnings_sheet_staleness(p_now timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with clock as (
  select (p_now at time zone 'America/New_York')::date as et_day
),
sessions as (
  select days.day,
         (
           (days.day::timestamp + case
             when c.kind = 'early_close' then c.close_et
             else time '16:00'
           end) at time zone 'America/New_York'
         ) as closes_at
  from clock
  cross join generate_series(clock.et_day - 40, clock.et_day + 14, interval '1 day') as span(day_ts)
  cross join lateral (select span.day_ts::date as day) days
  left join public.us_equity_market_calendar c on c.day = days.day
  where extract(isodow from days.day) between 1 and 5
    and coalesce(c.kind, '') <> 'holiday'
),
sheets as (
  select q.created_at,
         (q.created_at at time zone 'America/New_York')::date as et_day
  from public.research_queue q
  where q.source = 'earnings_sheet'
),
covered as (
  select s.created_at,
         case
           when today.day is not null and s.created_at < today.closes_at then today.day
           else nxt.day
         end as entry_session
  from sheets s
  left join sessions today on today.day = s.et_day
  left join lateral (
    select n.day
    from sessions n
    where n.day > s.et_day
    order by n.day
    limit 1
  ) nxt on true
),
due as (
  select coalesce(today.day, prev.day) as entry_session
  from clock
  left join sessions today on today.day = clock.et_day
  left join lateral (
    select p.day
    from sessions p
    where p.day <= clock.et_day
    order by p.day desc
    limit 1
  ) prev on true
),
latest as (
  select max(c.created_at) as last_sheet_at,
         max(c.entry_session) filter (
           where c.entry_session <= (select d.entry_session from due d)
         ) as anchor
  from covered c
)
select jsonb_build_object(
  'stale', due.entry_session is null
    or not exists (
      select 1
      from covered c
      where c.entry_session = due.entry_session
    ),
  'last_sheet_at', latest.last_sheet_at,
  'sessions_missed', case
    when latest.anchor is null or due.entry_session is null then null
    when exists (
      select 1 from covered c where c.entry_session = due.entry_session
    ) then 0
    else (
      select count(*)::integer
      from sessions s
      where s.day > latest.anchor
        and s.day <= due.entry_session
    )
  end,
  'latest_entry_session', due.entry_session
)
from due
cross join latest;
$$;

comment on function public.earnings_sheet_staleness(timestamptz) is
  'Whether the latest NYSE entry session has a research_queue row with source earnings_sheet. stale, last_sheet_at, sessions_missed, and latest_entry_session. A row written before that session close is for that session. A row written after the close, or on a day that is not a session, is for the next session. sessions_missed counts sessions after the last covered entry session through the latest one. Holidays are not sessions. Does not make /api/health not-ok.';

revoke all on function public.earnings_sheet_staleness(timestamptz) from public, anon, authenticated, oddsborne_worker, bandit_worker;
grant execute on function public.earnings_sheet_staleness(timestamptz)
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

-- Coverage chain 197, 223, 226, 241, 245, 260. Lesson 260 (2026-11-17) is the
-- Monday-AM miss. This PR windows the sheet by entry session.
insert into public.research_lesson_fixes (lesson_id, fix_ref, fix_kind, shipped_at)
select 260, 'PR #208', 'tool', timestamptz '2026-11-17 18:40:00+00'
where exists (select 1 from public.research_lessons where id = 260)
on conflict (lesson_id, fix_ref) do nothing;

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
  ), '{"quantanamo":0,"oddsborne":0,"bandit":0,"lots":[]}'::jsonb) as learning_gaps,
  coalesce((
    select jsonb_build_object(
      'quantanamo', count(*) filter (where c.steward = 'quantanamo'),
      'oddsborne', count(*) filter (where c.steward = 'oddsborne'),
      'bandit', count(*) filter (where c.steward = 'bandit')
    )
    from public.decision_candidates c
    where not public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and coalesce(c.meta->>'superseded', '') <> 'true'
  ), '{"quantanamo":0,"oddsborne":0,"bandit":0}'::jsonb) as unscoreable_decisions,
  (select count(*) from public.v_invalidation_breaches where escalated)::integer as breaches_escalated,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'steward', b.steward,
      'lot_table', b.lot_table,
      'lot_id', b.lot_id,
      'instrument', b.instrument,
      'first_seen_at', b.first_seen_at,
      'breach_age_minutes', b.breach_age_minutes,
      'escalation', b.escalation,
      'sentence', b.sentence
    ) order by b.first_seen_at)
    from public.v_invalidation_breaches b
    where b.escalated
  ), '[]'::jsonb) as escalated,
  (select count(*)::integer from public.v_equity_implied_move_gaps) as equity_implied_move_gaps,
  coalesce((
    select jsonb_build_object(
      'n', count(*)::integer,
      'quantanamo', count(*) filter (where s.steward = 'quantanamo')::integer,
      'oddsborne', count(*) filter (where s.steward = 'oddsborne')::integer,
      'bandit', count(*) filter (where s.steward = 'bandit')::integer,
      'unknown', count(*) filter (
        where s.steward is distinct from 'quantanamo'
          and s.steward is distinct from 'oddsborne'
          and s.steward is distinct from 'bandit'
      )::integer,
      'theses', coalesce((
        select jsonb_agg(jsonb_build_object(
          'thesis_id', g.thesis_id,
          'steward', g.steward,
          'n', g.n
        ) order by g.n desc, g.thesis_id)
        from (
          select thesis_id, steward, count(*)::integer as n
          from public.v_stale_queued_tests
          group by thesis_id, steward
        ) g
      ), '[]'::jsonb)
    )
    from public.v_stale_queued_tests s
  ), '{"n":0,"quantanamo":0,"oddsborne":0,"bandit":0,"unknown":0,"theses":[]}'::jsonb) as stale_queued_tests,
  (
    select count(*)::integer
    from public.research_lessons l
    where l.incorporated = false
      and l.test_id is null
      and public.lesson_names_preregistered_test(l.summary)
  ) as unlinked_named_lessons,
  (
    select jsonb_build_object(
      'last_first_seen_at', agg.first_seen,
      'last_seen_at', agg.last_seen,
      'newest_evidence_at', ev.newest,
      'last_run_at', run.ran_at,
      'evidence_through', run.evidence_through,
      'considered', run.considered,
      'proposed', run.proposed,
      'skipped', run.skipped,
      'lag_hours', case
        when run.ran_at is null then null::numeric
        when ev.newest is not null and (run.evidence_through is null or run.evidence_through < ev.newest)
          then round((extract(epoch from (ev.newest - coalesce(run.evidence_through, run.ran_at))) / 3600.0)::numeric, 1)
        else round((extract(epoch from (now() - run.ran_at)) / 3600.0)::numeric, 1)
      end,
      'lagging',
        run.ran_at is null
        or run.ok is distinct from true
        or run.ran_at < now() - interval '8 hours'
        or (
          ev.newest is not null
          and (run.evidence_through is null or run.evidence_through < ev.newest)
        ),
      'created_7d', agg.created_7d,
      'pending', agg.pending,
      'starved', agg.starved
    )
    from (
      select
        max(c.first_seen_at) as first_seen,
        max(c.last_seen_at) as last_seen,
        count(*) filter (where c.first_seen_at >= now() - interval '7 days')::integer as created_7d,
        count(*) filter (where c.status = 'pending')::integer as pending,
        max(c.first_seen_at) is null
          or max(c.first_seen_at) < now() - interval '7 days' as starved
      from public.ontology_candidates c
    ) agg
    cross join (
      select max(stamps.v) as newest
      from (
        select b.created_at as v from public.bookmarks b
        union all
        select b.fetched_at from public.bookmarks b
        union all
        select b.classified_at from public.bookmarks b
        union all
        select l.created_at from public.research_lessons l
      ) stamps(v)
    ) ev
    left join lateral (
      select r.ran_at, r.ok, r.considered, r.proposed, r.skipped, r.evidence_through
      from public.ontology_proposer_runs r
      where r.ok
      order by r.ran_at desc
      limit 1
    ) run on true
  ) as ontology_freshness,
  coalesce((
    select jsonb_agg(stalled.line order by stalled.trading_days desc, stalled.test_id)
    from (
      select
        s.trading_days,
        s.test_id,
        format(
          'A test of %s has been waiting %s trading %s. Lessons that depend on it still have no verdict.',
          replace(s.thesis_id, '_', ' '),
          s.trading_days,
          case when s.trading_days = 1 then 'day' else 'days' end
        ) as line
      from public.v_stale_queued_tests s
      where not exists (
        select 1
        from public.desk_agents a
        where a.slug = s.steward
          and a.status = 'retired'
      )
    ) stalled
  ), '[]'::jsonb) as learning_stalls,
  jsonb_build_object(
    'research_cycles', public.research_id_sequence_state('research_cycles'),
    'research_lessons', public.research_id_sequence_state('research_lessons')
  ) as research_id_sequences,
  lineage.rules_not_taking,
  lineage.lesson_came_back
from (select 1) as one
left join lateral (
  with recursive walk as (
    select l.id as root_id,
           l.id as lesson_id,
           array[l.id] as path,
           0 as depth
    from public.research_lessons l
    union all
    select w.root_id,
           e.lesson_id,
           w.path || e.lesson_id,
           w.depth + 1
    from walk w
    join public.research_lesson_repeats e on e.earlier_lesson_id = w.lesson_id
    where e.lesson_id <> all (w.path)
      and w.depth < 12
  ),
  sized as (
    select root_id,
           array_agg(distinct lesson_id order by lesson_id) as lesson_ids
    from walk
    group by root_id
  ),
  long_enough as (
    select s.root_id, s.lesson_ids
    from sized s
    join public.research_lessons root on root.id = s.root_id
    where root.incorporated
      and cardinality(s.lesson_ids) >= 3
  ),
  kept as (
    select le.root_id, le.lesson_ids
    from long_enough le
    where not exists (
      select 1
      from long_enough other
      where other.root_id <> le.root_id
        and le.root_id = any (other.lesson_ids)
    )
  ),
  repeat_roles as (
    select k.root_id,
           l.id as lesson_id,
           l.created_at,
           coalesce(
             case
               when l.lineage_role in ('violation', 'confirmation', 'refinement') then l.lineage_role
             end,
             'violation'
           ) as role
    from kept k
    join public.research_lessons l on l.id = any (k.lesson_ids)
    where l.id <> k.root_id
  )
  select
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'lesson_ids', to_jsonb(k.lesson_ids),
          'thesis_id', root.thesis_id,
          'summary', latest.summary,
          'came_back', cardinality(k.lesson_ids) - 1,
          'violations', (
            select count(*)::integer
            from repeat_roles r
            where r.root_id = k.root_id
              and r.role = 'violation'
          ),
          'fix_ref', fx.fix_ref,
          'shipped_at', fx.shipped_at,
          'status', case
            when fx.shipped_at is not null and not exists (
              select 1
              from repeat_roles r
              where r.root_id = k.root_id
                and r.created_at > fx.shipped_at
            ) then 'fix_shipped_watching'
            when exists (
              select 1
              from repeat_roles v
              where v.root_id = k.root_id
                and v.role = 'violation'
                and (fx.shipped_at is null or v.created_at > fx.shipped_at)
                and not exists (
                  select 1
                  from repeat_roles c
                  where c.root_id = v.root_id
                    and c.role = 'confirmation'
                    and (c.created_at, c.lesson_id) > (v.created_at, v.lesson_id)
                    and (fx.shipped_at is null or c.created_at > fx.shipped_at)
                )
            ) then case
              when fx.shipped_at is null then 'not_taking'
              else 'fix_failed'
            end
            when not exists (
              select 1
              from repeat_roles r
              where r.root_id = k.root_id
                and (fx.shipped_at is null or r.created_at > fx.shipped_at)
                and r.role is distinct from 'confirmation'
            ) then 'holding'
            when not exists (
              select 1
              from repeat_roles r
              where r.root_id = k.root_id
                and (fx.shipped_at is null or r.created_at > fx.shipped_at)
                and r.role is distinct from 'refinement'
            ) then 'refining'
            else case
              when (
                select r.role
                from repeat_roles r
                where r.root_id = k.root_id
                  and (fx.shipped_at is null or r.created_at > fx.shipped_at)
                order by r.created_at desc, r.lesson_id desc
                limit 1
              ) = 'confirmation' then 'holding'
              else 'refining'
            end
          end,
          'failed_lesson_id', case
            when fx.shipped_at is null then null
            else (
              select v.lesson_id
              from repeat_roles v
              where v.root_id = k.root_id
                and v.role = 'violation'
                and v.created_at > fx.shipped_at
                and not exists (
                  select 1
                  from repeat_roles c
                  where c.root_id = v.root_id
                    and c.role = 'confirmation'
                    and (c.created_at, c.lesson_id) > (v.created_at, v.lesson_id)
                    and c.created_at > fx.shipped_at
                )
              order by v.created_at, v.lesson_id
              limit 1
            )
          end
        )
        order by k.lesson_ids[cardinality(k.lesson_ids)] desc
      )
      from kept k
      join public.research_lessons root on root.id = k.root_id
      join public.research_lessons latest
        on latest.id = k.lesson_ids[cardinality(k.lesson_ids)]
      left join lateral (
        select f.fix_ref, f.shipped_at
        from public.research_lesson_fixes f
        where f.lesson_id = any (k.lesson_ids)
        order by f.shipped_at desc, f.id desc
        limit 1
      ) fx on true
    ), '[]'::jsonb) as rules_not_taking,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'lesson_id', s.root_id,
          'came_back', cardinality(s.lesson_ids) - 1
        )
        order by cardinality(s.lesson_ids) desc, s.root_id
      )
      from sized s
      where cardinality(s.lesson_ids) > 1
    ), '[]'::jsonb) as lesson_came_back,
  public.earnings_sheet_staleness(now()) as earnings_sheet_stale
) lineage on true;


comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, learning_stalls, unlinked_named_lessons, ontology_freshness, and research_id_sequences are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests that have waited at least five NYSE sessions, by steward and thesis. learning_stalls is that list in plain sentences, with retired stewards left out, and grasshopper_touch_heartbeat returns it beside escalated. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null. ontology_freshness is the proposer run: last_run_at, evidence_through, considered, proposed, skipped, and lagging only when that run is missing, older than eight hours, or newer notes arrived after evidence_through. A run that proposed nothing is not lagging. research_id_sequences is max(id), identity last_value, is_called, and lagging for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). It does not call setval. rules_not_taking lists an incorporated lesson that later lessons cite again, directly or through the ones in between, when that chain is at least 3 lessons long. A lesson already inside a longer chain is not listed on its own. lesson_ids run oldest first. summary is the newest lesson in the chain. came_back is how many lessons followed the first. violations is how many of those broke the rule. fix_ref and shipped_at are the newest research_lesson_fixes row whose lesson is in the chain. violations counts later lessons that broke the incorporated rule. came_back still counts every later lesson. status is not_taking when a later lesson broke the rule and no later lesson says it held, holding when the later lessons say the rule held, and refining when they only narrow it. fix_shipped_watching stays when a fix is recorded and no lesson citing the chain was created after shipped_at. fix_failed is a later lesson that broke the rule after shipped_at. failed_lesson_id is that lesson. A confirmation after the fix does not fail it. Only not_taking and fix_failed are the alarm. lesson_came_back is that count for every lesson cited at least once, including a single repeat. rules_not_taking and lesson_came_back do not make /api/health not-ok. earnings_sheet_stale is stale, last_sheet_at, sessions_missed, and latest_entry_session. stale is true when no research_queue row with source earnings_sheet covers the latest NYSE entry session. A row written before that session close is for that session. A row written after the close, or on a day that is not a session, is for the next session. sessions_missed counts NYSE sessions after the last covered entry session through the latest one, and is null when no sheet has covered a session up to that day. Holidays in us_equity_market_calendar are not sessions. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.research_id_sequences is
  'Identity sequence versus max(id) for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). An empty table is not lagging. It does not call setval and it does not make /api/health not-ok.';


comment on column public.v_ledger_watchdog.rules_not_taking is
  'Incorporated lessons re-taught at least twice (chain length at least 3), oldest lesson in the chain first. Each item has lesson_ids, thesis_id, the newest summary, came_back, violations, fix_ref, shipped_at, status, and failed_lesson_id. violations counts later lessons that broke the incorporated rule. came_back still counts every later lesson. status is not_taking when a later lesson broke the rule and no later lesson says it held, holding when the later lessons say the rule held, and refining when they only narrow it. fix_shipped_watching stays when a fix is recorded and no lesson citing the chain was created after shipped_at. fix_failed is a later lesson that broke the rule after shipped_at. failed_lesson_id is that lesson. A confirmation after the fix does not fail it. Only not_taking and fix_failed are the alarm. A lesson already inside a longer chain is left out. Does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.lesson_came_back is
  'How many later lessons cite this lesson, directly or through the ones in between. One repeat is included. Absent from rules_not_taking until the chain reaches 3. Does not make /api/health not-ok.';


comment on column public.v_ledger_watchdog.earnings_sheet_stale is
  'stale, last_sheet_at, sessions_missed, and latest_entry_session for source earnings_sheet. stale is true when no row covers the latest NYSE entry session. sessions_missed counts sessions after the last covered entry session through that day, and is null when no sheet has covered a session up to that day. Does not make /api/health not-ok.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

