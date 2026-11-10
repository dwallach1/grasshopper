-- Lesson lineage. A summary that says "lesson 226" or "lessons 118/119"
-- records a link to each older lesson that exists. A newer id is ignored
-- (lesson 140 names 153, which was written later). Stewards keep the same
-- insert into research_lessons. This does not change a belief, a playbook
-- rule, or incorporated.

create table if not exists public.research_lesson_repeats (
  lesson_id bigint not null references public.research_lessons(id) on delete cascade,
  earlier_lesson_id bigint not null references public.research_lessons(id) on delete cascade,
  primary key (lesson_id, earlier_lesson_id),
  check (lesson_id <> earlier_lesson_id)
);

create index if not exists research_lesson_repeats_earlier_idx
  on public.research_lesson_repeats (earlier_lesson_id);

comment on table public.research_lesson_repeats is
  'A research lesson whose summary cites an older lesson by number. Filled by trigger from the summary. Does not change the lesson, the playbook, or a belief.';

alter table public.research_lesson_repeats enable row level security;

revoke all on table public.research_lesson_repeats from public, anon, authenticated, desk_public_reader;
grant select on table public.research_lesson_repeats
  to authenticated, quantanamo_worker, desk_public_reader, service_role;
grant all on table public.research_lesson_repeats to service_role;

drop policy if exists desk_public_reader_select on public.research_lesson_repeats;
create policy desk_public_reader_select on public.research_lesson_repeats
  for select to desk_public_reader using (true);

drop policy if exists quantanamo_worker_select on public.research_lesson_repeats;
create policy quantanamo_worker_select on public.research_lesson_repeats
  for select to quantanamo_worker using (true);

drop policy if exists authenticated_select on public.research_lesson_repeats;
create policy authenticated_select on public.research_lesson_repeats
  for select to authenticated using (true);

-- Parse "lesson 226", "lesson 188/199", and "lessons 118/119". Digits only,
-- at most 18, so a stray huge number cannot fail the lesson insert.
create or replace function private.cited_lesson_ids(p_summary text)
returns table (lesson_id bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct n.token::bigint as lesson_id
  from regexp_matches(coalesce(p_summary, ''), '\mlessons?\s+((?:\d+\s*/\s*)*\d+)', 'gi') as m
  cross join lateral regexp_split_to_table(m[1], '\s*/\s*') as n(token)
  where n.token ~ '^[0-9]{1,18}$';
$$;

comment on function private.cited_lesson_ids(text) is
  'Lesson ids named in a summary: lesson N, lesson N/M, or lessons N/M. Does not decide whether the id exists or is older.';

revoke all on function private.cited_lesson_ids(text) from public, anon, authenticated, desk_public_reader;
revoke execute on function private.cited_lesson_ids(text) from oddsborne_worker, bandit_worker;
grant execute on function private.cited_lesson_ids(text)
  to quantanamo_worker, service_role;

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

  return null;
end;
$$;

comment on function private.link_research_lesson_repeats() is
  'AFTER insert or summary change: replace this lesson''s links with citations of lessons that exist and are older. Does not change the lesson row, a belief, or incorporated.';

revoke all on function private.link_research_lesson_repeats() from public, anon, authenticated, desk_public_reader;
revoke execute on function private.link_research_lesson_repeats() from oddsborne_worker, bandit_worker;
grant execute on function private.link_research_lesson_repeats()
  to authenticated, quantanamo_worker, service_role;

drop trigger if exists research_lessons_link_repeats on public.research_lessons;
create trigger research_lessons_link_repeats
  after insert or update of summary on public.research_lessons
  for each row
  execute function private.link_research_lesson_repeats();

insert into public.research_lesson_repeats (lesson_id, earlier_lesson_id)
select l.id, earlier.id
from public.research_lessons l
cross join lateral private.cited_lesson_ids(l.summary) cited
join public.research_lessons earlier on earlier.id = cited.lesson_id
where (earlier.created_at, earlier.id) < (l.created_at, l.id)
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
  )
  select
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'lesson_ids', to_jsonb(k.lesson_ids),
          'thesis_id', root.thesis_id,
          'summary', latest.summary,
          'came_back', cardinality(k.lesson_ids) - 1
        )
        order by k.lesson_ids[cardinality(k.lesson_ids)] desc
      )
      from kept k
      join public.research_lessons root on root.id = k.root_id
      join public.research_lessons latest
        on latest.id = k.lesson_ids[cardinality(k.lesson_ids)]
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
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, learning_stalls, unlinked_named_lessons, ontology_freshness, and research_id_sequences are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests that have waited at least five NYSE sessions, by steward and thesis. learning_stalls is that list in plain sentences, with retired stewards left out, and grasshopper_touch_heartbeat returns it beside escalated. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null. ontology_freshness is the proposer run: last_run_at, evidence_through, considered, proposed, skipped, and lagging only when that run is missing, older than eight hours, or newer notes arrived after evidence_through. A run that proposed nothing is not lagging. research_id_sequences is max(id), identity last_value, is_called, and lagging for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). It does not call setval. rules_not_taking lists an incorporated lesson that later lessons cite again, directly or through the ones in between, when that chain is at least 3 lessons long. A lesson already inside a longer chain is not listed on its own. lesson_ids run oldest first. summary is the newest lesson in the chain. came_back is how many lessons followed the first. lesson_came_back is that count for every lesson cited at least once, including a single repeat. rules_not_taking and lesson_came_back do not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.research_id_sequences is
  'Identity sequence versus max(id) for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). An empty table is not lagging. It does not call setval and it does not make /api/health not-ok.';


comment on column public.v_ledger_watchdog.rules_not_taking is
  'Incorporated lessons re-taught at least twice (chain length at least 3), oldest lesson in the chain first. Each item has lesson_ids, thesis_id, the newest summary, and came_back. A lesson already inside a longer chain is left out. Does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.lesson_came_back is
  'How many later lessons cite this lesson, directly or through the ones in between. One repeat is included. Absent from rules_not_taking until the chain reaches 3. Does not make /api/health not-ok.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, desk_public_reader, service_role;
