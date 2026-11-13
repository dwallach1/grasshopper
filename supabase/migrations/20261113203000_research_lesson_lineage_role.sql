-- A repeat of an incorporated lesson is a violation, a confirmation, or a
-- refinement. Writers set research_lessons.lineage_role. When they leave it
-- empty, the lesson text fills it, and only when the text is clear. A repeat
-- the text does not classify is read as a violation, so a real break still
-- alarms. The column does not change a belief, a playbook rule, or
-- incorporated, and it does not make /api/health not-ok.
-- Retired seats (oddsborne_worker, bandit_worker) get no execute on the
-- helpers. They keep the close-lesson grant they already have.

alter table public.research_lessons
  add column if not exists lineage_role text;

alter table public.research_lessons
  drop constraint if exists research_lessons_lineage_role_check;

alter table public.research_lessons
  add constraint research_lessons_lineage_role_check
  check (lineage_role is null or lineage_role in ('violation', 'confirmation', 'refinement'));

comment on column public.research_lessons.lineage_role is
  'What this lesson does to an older lesson it cites. violation: the steward acted against the incorporated rule, or a miss that rule was meant to prevent happened again. confirmation: the rule held, a rule-correct pass, the rule stands, or no rule change with evidence it held. refinement: the lesson narrows or conditions the rule. Null on a lesson that does not take a side. Writers set it. The text fills it only when the wording is clear.';

-- Clear phrases only. Anything else stays null, and the watchdog reads a
-- null repeat as a violation. Order matters: a slot that was taken is a
-- violation even when the same sentence says there is no rule change.
create or replace function private.lesson_lineage_role(p_summary text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when coalesce(p_summary, '') ~* 'was not applied' then 'violation'
    when coalesce(p_summary, '') ~* 'again outside' then 'violation'
    when coalesce(p_summary, '') ~* 'coverage miss' then 'violation'
    when coalesce(p_summary, '') ~* 'same class as' then 'violation'
    when coalesce(p_summary, '') ~* 'outside the screened universe'
     and coalesce(p_summary, '') ~* 'already lesson' then 'violation'
    when coalesce(p_summary, '') ~* 'below-gate'
     and coalesce(p_summary, '') ~* 'slot' then 'violation'
    when coalesce(p_summary, '') ~* 'chase already ruled out' then 'violation'
    when coalesce(p_summary, '') ~* 'rule stands' then 'confirmation'
    when coalesce(p_summary, '') ~* 'sizing rule worked' then 'confirmation'
    when coalesce(p_summary, '') ~* 'forward pass' then 'confirmation'
    when coalesce(p_summary, '') ~* 'rule-correct pass' then 'confirmation'
    when coalesce(p_summary, '') ~* 'reinforces lesson' then 'confirmation'
    when coalesce(p_summary, '') ~* 'rule edit' then 'refinement'
    when coalesce(p_summary, '') ~* 'sector-specific' then 'refinement'
    when coalesce(p_summary, '') ~* 'not tape-wide' then 'refinement'
    when coalesce(p_summary, '') ~* 'weakens the blanket' then 'refinement'
    when coalesce(p_summary, '') ~* 'size any' then 'refinement'
    else null
  end;
$$;

comment on function private.lesson_lineage_role(text) is
  'violation, confirmation, or refinement when the summary says so in a fixed phrase. Null when the text is not that clear. Does not write the row. The watchdog reads a null repeat as a violation, so this function stays off the view.';

revoke all on function private.lesson_lineage_role(text) from public, anon, authenticated, desk_public_reader;
revoke execute on function private.lesson_lineage_role(text) from oddsborne_worker, bandit_worker;
grant execute on function private.lesson_lineage_role(text)
  to quantanamo_worker, service_role;

-- A confirmation that names no lesson number still continues the previous
-- lesson of the same type. "The rule stands" and "forward pass" are the
-- phrases. A cited lesson number is left to the citation links.
create or replace function private.lesson_continues_uncited(p_summary text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(p_summary, '') ~* '(rule stands|forward pass|pass-only-after-open rule|pass-after-open rule)'
    and not exists (select 1 from private.cited_lesson_ids(p_summary));
$$;

comment on function private.lesson_continues_uncited(text) is
  'True when a summary says the rule stands or was a forward pass and names no lesson number. The link target is the newest older lesson of the same type on the same thesis.';

revoke all on function private.lesson_continues_uncited(text) from public, anon, authenticated, desk_public_reader;
revoke execute on function private.lesson_continues_uncited(text) from oddsborne_worker, bandit_worker;
grant execute on function private.lesson_continues_uncited(text)
  to quantanamo_worker, service_role;

create or replace function private.assign_lesson_lineage_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lineage_role is null then
    new.lineage_role := private.lesson_lineage_role(new.summary);
  end if;
  return new;
end;
$$;

comment on function private.assign_lesson_lineage_role() is
  'BEFORE insert or summary change: fill lineage_role from the summary when the writer left it empty. Does not replace a role the writer set. Does not change a belief or incorporated.';

revoke all on function private.assign_lesson_lineage_role() from public, anon, authenticated, desk_public_reader;
revoke execute on function private.assign_lesson_lineage_role() from oddsborne_worker, bandit_worker;
grant execute on function private.assign_lesson_lineage_role()
  to quantanamo_worker, service_role;

drop trigger if exists research_lessons_assign_lineage_role on public.research_lessons;
create trigger research_lessons_assign_lineage_role
  before insert or update of summary, lineage_role on public.research_lessons
  for each row
  execute function private.assign_lesson_lineage_role();

create or replace function private.link_research_lesson_repeats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.research_lesson_repeats
   where lesson_id = new.id;

  insert into public.research_lesson_repeats (lesson_id, earlier_lesson_id)
  select new.id, earlier.id
    from private.cited_lesson_ids(new.summary) cited
    join public.research_lessons earlier on earlier.id = cited.lesson_id
   where (earlier.created_at, earlier.id) < (new.created_at, new.id);

  if not exists (
    select 1 from public.research_lesson_repeats where lesson_id = new.id
  ) and private.lesson_continues_uncited(new.summary) then
    insert into public.research_lesson_repeats (lesson_id, earlier_lesson_id)
    select new.id, prior.id
    from public.research_lessons prior
    where prior.thesis_id = new.thesis_id
      and prior.lesson_type = new.lesson_type
      and (prior.created_at, prior.id) < (new.created_at, new.id)
    order by prior.created_at desc, prior.id desc
    limit 1;
  end if;

  return null;
end;
$$;

comment on function private.link_research_lesson_repeats() is
  'AFTER insert or summary change: replace this lesson''s links with citations of older lessons. When the summary names none and says the rule stands or was a forward pass, link the newest older lesson of the same type on the same thesis. Does not change the lesson row, a belief, or incorporated.';

-- Roles the text states. Unclear rows stay null; the watchdog reads those
-- repeats as violations. Does not touch incorporated or a belief.
update public.research_lessons l
   set lineage_role = private.lesson_lineage_role(l.summary)
 where l.lineage_role is null
   and private.lesson_lineage_role(l.summary) is not null;

-- Same-rule checks that say the rule stands without naming a lesson number.
insert into public.research_lesson_repeats (lesson_id, earlier_lesson_id)
select l.id, prior.id
from public.research_lessons l
join lateral (
  select p.id
  from public.research_lessons p
  where p.thesis_id = l.thesis_id
    and p.lesson_type = l.lesson_type
    and (p.created_at, p.id) < (l.created_at, l.id)
  order by p.created_at desc, p.id desc
  limit 1
) prior on true
where private.lesson_continues_uncited(l.summary)
  and not exists (
    select 1 from public.research_lesson_repeats e where e.lesson_id = l.id
  )
on conflict do nothing;


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
    ), '[]'::jsonb) as lesson_came_back
) lineage on true;


comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, learning_stalls, unlinked_named_lessons, ontology_freshness, and research_id_sequences are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests that have waited at least five NYSE sessions, by steward and thesis. learning_stalls is that list in plain sentences, with retired stewards left out, and grasshopper_touch_heartbeat returns it beside escalated. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null. ontology_freshness is the proposer run: last_run_at, evidence_through, considered, proposed, skipped, and lagging only when that run is missing, older than eight hours, or newer notes arrived after evidence_through. A run that proposed nothing is not lagging. research_id_sequences is max(id), identity last_value, is_called, and lagging for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). It does not call setval. rules_not_taking lists an incorporated lesson that later lessons cite again, directly or through the ones in between, when that chain is at least 3 lessons long. A lesson already inside a longer chain is not listed on its own. lesson_ids run oldest first. summary is the newest lesson in the chain. came_back is how many lessons followed the first. violations is how many of those broke the rule. fix_ref and shipped_at are the newest research_lesson_fixes row whose lesson is in the chain. violations counts later lessons that broke the incorporated rule. came_back still counts every later lesson. status is not_taking when a later lesson broke the rule and no later lesson says it held, holding when the later lessons say the rule held, and refining when they only narrow it. fix_shipped_watching stays when a fix is recorded and no lesson citing the chain was created after shipped_at. fix_failed is a later lesson that broke the rule after shipped_at. failed_lesson_id is that lesson. A confirmation after the fix does not fail it. Only not_taking and fix_failed are the alarm. lesson_came_back is that count for every lesson cited at least once, including a single repeat. rules_not_taking and lesson_came_back do not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.research_id_sequences is
  'Identity sequence versus max(id) for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). An empty table is not lagging. It does not call setval and it does not make /api/health not-ok.';


comment on column public.v_ledger_watchdog.rules_not_taking is
  'Incorporated lessons re-taught at least twice (chain length at least 3), oldest lesson in the chain first. Each item has lesson_ids, thesis_id, the newest summary, came_back, violations, fix_ref, shipped_at, status, and failed_lesson_id. violations counts later lessons that broke the incorporated rule. came_back still counts every later lesson. status is not_taking when a later lesson broke the rule and no later lesson says it held, holding when the later lessons say the rule held, and refining when they only narrow it. fix_shipped_watching stays when a fix is recorded and no lesson citing the chain was created after shipped_at. fix_failed is a later lesson that broke the rule after shipped_at. failed_lesson_id is that lesson. A confirmation after the fix does not fail it. Only not_taking and fix_failed are the alarm. A lesson already inside a longer chain is left out. Does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.lesson_came_back is
  'How many later lessons cite this lesson, directly or through the ones in between. One repeat is included. Absent from rules_not_taking until the chain reaches 3. Does not make /api/health not-ok.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

create or replace function public.steward_close_lesson(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text;
  v_kind text := coalesce(nullif(p->>'kind', ''), 'trade_close_lesson');
  v_lot uuid := (p->>'position_id')::uuid;
  v_table text;
  v_lot_thesis text;
  v_status text;
  v_closed timestamptz;
  v_symbol text;
  v_thesis text;
  v_prior numeric;
  v_new numeric := (p->>'new_confidence')::numeric;
  v_delta numeric := (p->>'confidence_delta')::numeric;
  v_asked numeric;
  v_pnl numeric;
  v_clamp text;
  v_id uuid;
  v_dry boolean := coalesce((p->>'dry_run')::boolean, false);
  v_lesson bigint;
  v_lesson_summary text := nullif(btrim(p->>'lesson_summary'), '');
  v_lesson_type text := nullif(btrim(p->>'lesson_type'), '');
  v_lesson_thesis text;
  v_cycle bigint;
  v_cycle_thesis text;
  v_lineage_role text := nullif(btrim(p->>'lineage_role'), '');
begin
  if right(current_user::text, 7) = '_worker' then
    v_steward := left(current_user::text, length(current_user::text) - length('_worker'));
    if nullif(p->>'steward', '') is not null and p->>'steward' <> v_steward then
      raise exception 'refusal:auth: % may not write a lesson for steward %', current_user, p->>'steward'
        using errcode = '42501';
    end if;
  else
    v_steward := p->>'steward';
  end if;
  if v_kind not in ('trade_close_lesson', 'playbook_rule', 'autopsy') then
    raise exception 'refusal:input: kind must be trade_close_lesson, playbook_rule or autopsy, got %', v_kind
      using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p->>'rationale', ''))) < 20 then
    raise exception 'refusal:input: rationale (what the close taught, >= 20 chars) is required' using errcode = 'P0001';
  end if;
  if v_lot is null then
    raise exception 'refusal:input: position_id is required' using errcode = 'P0001';
  end if;
  if v_steward = 'bandit' then
    v_table := 'meme_positions';
    select mp.thesis_id, mp.status, mp.closed_at, t.symbol
      into v_lot_thesis, v_status, v_closed, v_symbol
    from public.meme_positions mp
    left join public.meme_tokens t on t.id = mp.token_id
    where mp.id = v_lot;
  elsif v_steward = 'oddsborne' then
    v_table := 'pm_positions';
    select pp.thesis_id, pp.status, pp.closed_at,
           coalesce(nullif(btrim(m.slug), ''), nullif(btrim(pp.outcome), ''))
      into v_lot_thesis, v_status, v_closed, v_symbol
    from public.pm_positions pp
    left join public.pm_markets m on m.id = pp.market_id
    where pp.id = v_lot;
  elsif v_steward = 'quantanamo' then
    -- 65: QUANTANAMO's equity lots (Robinhood); their trade_outcomes rows carry source_table 'position_episodes'.
    v_table := 'position_episodes';
    select thesis_id, status, closed_at, symbol
      into v_lot_thesis, v_status, v_closed, v_symbol
    from public.position_episodes where id = v_lot;
  else
    raise exception 'refusal:input: steward % has no lot table here', v_steward using errcode = 'P0001';
  end if;
  if not found then
    raise exception 'refusal:input: % lot % not found', v_table, v_lot using errcode = 'P0001';
  end if;
  if v_status is distinct from 'closed' then
    raise exception 'refusal:state: lot % is %; a close lesson needs a closed lot', v_lot, v_status using errcode = 'P0001';
  end if;
  v_thesis := coalesce(nullif(p->>'thesis_id', ''), v_lot_thesis);
  if v_thesis is null then
    raise exception 'refusal:input: lot % has no thesis_id; pass thesis_id', v_lot using errcode = 'P0001';
  end if;
  if v_lot_thesis is not null and v_thesis <> v_lot_thesis then
    raise exception 'refusal:input: thesis % is not the lot''s thesis %', v_thesis, v_lot_thesis using errcode = 'P0001';
  end if;
  if v_new is not null and v_delta is not null then
    raise exception 'refusal:input: pass new_confidence or confidence_delta, not both' using errcode = 'P0001';
  end if;
  if v_new is not null and (v_new < 1 or v_new > 100) then
    raise exception 'refusal:input: new_confidence is on the 1-100 scale, got %', v_new using errcode = 'P0001';
  end if;
  -- 60: the prior is always the ledger's current number (the one sizing reads), never the caller's;
  -- a lesson moves confidence relative to it, and a losing close can never raise it.
  v_prior := private.thesis_ledger_confidence(v_thesis);
  if v_delta is not null then
    v_new := case when v_prior is null then null else v_prior + v_delta end;
  end if;
  v_asked := v_new;
  v_pnl := private.lot_realized_pnl(v_table, v_lot);
  if v_new is not null and v_prior is not null and v_pnl < 0 and v_new > v_prior then
    v_new := v_prior;
    v_clamp := 'losing close: confidence cannot rise above the ledger value';
  end if;
  if v_new is not null then
    v_new := least(greatest(v_new, 1), 100);
  end if;
  if nullif(p->>'research_lesson_id', '') is not null and v_lesson_summary is not null then
    raise exception 'refusal:input: pass research_lesson_id or lesson_summary, not both' using errcode = 'P0001';
  end if;
  if nullif(p->>'research_lesson_id', '') is not null then
    if p->>'research_lesson_id' !~ '^[0-9]+$' then
      raise exception 'refusal:input: research_lesson_id must be the lesson id' using errcode = 'P0001';
    end if;
    v_lesson := (p->>'research_lesson_id')::bigint;
    select l.thesis_id into v_lesson_thesis
    from public.research_lessons l
    where l.id = v_lesson;
    if not found then
      raise exception 'refusal:input: research lesson % not found', v_lesson using errcode = 'P0001';
    end if;
    if v_lesson_thesis is distinct from v_thesis then
      raise exception 'refusal:input: research lesson % is on thesis %, not %', v_lesson, v_lesson_thesis, v_thesis
        using errcode = 'P0001';
    end if;
  elsif v_lesson_summary is not null then
    if length(v_lesson_summary) < 20 then
      raise exception 'refusal:input: lesson_summary (what the close taught, >= 20 chars) is required' using errcode = 'P0001';
    end if;
    if v_lesson_type is null or length(v_lesson_type) > 80 then
      raise exception 'refusal:input: lesson_type is required with lesson_summary' using errcode = 'P0001';
    end if;
    if coalesce(p->>'cycle_id', '') !~ '^[0-9]+$' then
      raise exception 'refusal:input: cycle_id is required with lesson_summary' using errcode = 'P0001';
    end if;
    v_cycle := (p->>'cycle_id')::bigint;
    select rc.thesis_id into v_cycle_thesis
    from public.research_cycles rc
    where rc.id = v_cycle;
    if not found then
      raise exception 'refusal:input: research cycle % not found', v_cycle using errcode = 'P0001';
    end if;
    if v_cycle_thesis is not null and v_cycle_thesis <> v_thesis then
      raise exception 'refusal:input: cycle % is on thesis %, not %', v_cycle, v_cycle_thesis, v_thesis
        using errcode = 'P0001';
    end if;
  elsif v_kind = 'trade_close_lesson' then
    v_lesson := private.match_trade_close_lesson(v_thesis, now(), v_symbol, null);
  end if;
  if v_lineage_role is not null
     and v_lineage_role not in ('violation', 'confirmation', 'refinement') then
    raise exception 'refusal:input: lineage_role must be violation, confirmation, or refinement, got %', v_lineage_role
      using errcode = 'P0001';
  end if;
  -- 65: dry_run runs every check and the same arithmetic, and writes nothing.
  if v_dry then
    return jsonb_build_object('dry_run', true,
                              'would_write', case
                                when v_lesson_summary is not null then 'belief_updates,research_lessons'
                                else 'belief_updates'
                              end,
                              'steward', v_steward,
                              'lot_table', v_table, 'lot_id', v_lot, 'thesis_id', v_thesis, 'kind', v_kind,
                              'prior_confidence', v_prior, 'new_confidence', v_new,
                              'requested_new_confidence', case when v_asked is distinct from v_new then v_asked end,
                              'confidence_delta', v_delta, 'lot_closed_at', v_closed,
                              'lot_realized_pnl', v_pnl, 'clamped', v_clamp,
                              'research_lesson_id', v_lesson,
                              'symbol', v_symbol,
                              'lineage_role', v_lineage_role);
  end if;
  if v_lesson_summary is not null then
    insert into public.research_lessons (
      cycle_id, thesis_id, lesson_type, summary, lineage_role, incorporated, created_at
    ) values (
      v_cycle, v_thesis, v_lesson_type, v_lesson_summary, v_lineage_role, false, now()
    )
    returning id into v_lesson;
  end if;
  insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
  values (v_thesis, v_prior, v_new, btrim(p->>'rationale'), now(),
          coalesce(p->'meta', '{}'::jsonb) || jsonb_build_object(
            'kind', v_kind, 'steward', v_steward, 'lot_table', v_table, 'lot_id', v_lot,
            'lot_closed_at', v_closed, 'writer', 'close_lesson')
          || jsonb_strip_nulls(jsonb_build_object(
            'symbol', v_symbol,
            'research_lesson_id', v_lesson,
            'prior_source', 'ledger (theses results_confidence, else stated)',
            'caller_prior_confidence', p->'prior_confidence',
            'requested_new_confidence', case when v_asked is distinct from v_new then v_asked end,
            'confidence_delta', v_delta, 'lot_realized_pnl', v_pnl, 'clamped', v_clamp)))
  returning id into v_id;
  return jsonb_build_object('belief_update_id', v_id, 'thesis_id', v_thesis, 'kind', v_kind,
                            'prior_confidence', v_prior, 'new_confidence', v_new, 'lot_closed_at', v_closed,
                            'lot_realized_pnl', v_pnl, 'clamped', v_clamp,
                            'research_lesson_id', v_lesson);
end;
$$;

comment on function public.steward_close_lesson(jsonb) is
  'Close lesson for a steward lot. Moves confidence from the ledger and, for trade_close_lesson, stamps meta.research_lesson_id from the lesson written in this call or the one lesson within 10 minutes. lineage_role on a new research lesson is violation, confirmation, or refinement; omit it and the lesson text fills it when the text is clear. dry_run writes nothing. A losing close cannot raise confidence.';

revoke all on function public.steward_close_lesson(jsonb) from public, anon, authenticated;
grant execute on function public.steward_close_lesson(jsonb) to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
