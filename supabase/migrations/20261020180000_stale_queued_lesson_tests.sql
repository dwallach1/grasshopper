-- Queued strategy tests that have sat past a week, or past the date window they
-- named, and open lessons that are waiting on a test.
--
-- Nothing in this repo runs or expires a queued strategy_tests row when its
-- window has passed. tested_at on a queued row is when the row was written.
-- A lesson is often inserted before that test row exists, so test_id stays
-- null even when the summary names the test ("Test 42 preregistered").
--
-- This file does not score or change a test's status. It counts the stall,
-- shows each open lesson the test it waits on, and fills test_id when the
-- summary names exactly one preregistered test on the same thesis.
-- Idempotent. Not a trading rule. Does not make /api/health not-ok.
-- Not applied to production (xqungxapqicdmboniezz) by this migration file.

-- ---------------------------------------------------------------- 1. dates and the stall predicate
create or replace function public.safe_date(p_text text)
returns date
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_text is null or p_text !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p_text::date;
exception
  when others then
    return null;
end;
$$;

comment on function public.safe_date(text) is
  'A calendar date, or null when the text is not a real YYYY-MM-DD. A bad day does not fail the watchdog.';

revoke all on function public.safe_date(text) from public, anon;
grant execute on function public.safe_date(text)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create or replace function public.strategy_test_window_end(p_window_end date, p_params jsonb)
returns date
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    p_window_end,
    public.safe_date(p_params->>'window_end'),
    public.safe_date(p_params->'price_request'->>'end_date')
  );
$$;

comment on function public.strategy_test_window_end(date, jsonb) is
  'The test window end: the column, else params_json.window_end, else params_json.price_request.end_date. Null when none of those is a date.';

revoke all on function public.strategy_test_window_end(date, jsonb) from public, anon;
grant execute on function public.strategy_test_window_end(date, jsonb)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- Seven days is the same horizon v_learning_loop_gaps uses for a close with no
-- lesson. A queued test whose window end is already before today's New York
-- date is stale even sooner: the prices it asked for are in the past.
create or replace function public.strategy_test_is_stale_queued(
  p_status text,
  p_tested_at timestamptz,
  p_window_end date,
  p_at timestamptz
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select p_status = 'queued'
    and p_at is not null
    and (
      (p_tested_at is not null and p_tested_at <= p_at - interval '7 days')
      or (
        p_window_end is not null
        and p_window_end < (p_at at time zone 'America/New_York')::date
      )
    );
$$;

comment on function public.strategy_test_is_stale_queued(text, timestamptz, date, timestamptz) is
  'True when a strategy test is still queued and either tested_at is at least 7 days before p_at, or its window end is before today in America/New_York. A queued test inside its window and younger than 7 days is not stale.';

revoke all on function public.strategy_test_is_stale_queued(text, timestamptz, date, timestamptz) from public, anon;
grant execute on function public.strategy_test_is_stale_queued(text, timestamptz, date, timestamptz)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- Steward from the thesis's current domain assignment. Unknown when the
-- thesis has none, so a missing roster is not reported as QUANTANAMO.
-- Public and security invoker. desk_public_reader already selects these
-- tables. It does not get usage on schema private: execute is already
-- granted there on security-definer functions, and usage would make those
-- functions reachable.
create or replace function public.thesis_steward(p_thesis_id text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select a.slug
    from public.thesis_domains td
    join public.desk_domain_stewards ds
      on ds.domain_id = td.domain_id
     and ds.ended_at is null
    join public.desk_agents a on a.id = ds.agent_id
    where td.thesis_id = p_thesis_id
      and a.slug in ('quantanamo', 'oddsborne', 'bandit')
    order by ds.is_primary desc, a.slug
    limit 1
  ), 'unknown');
$$;

comment on function public.thesis_steward(text) is
  'quantanamo, oddsborne, or bandit from the thesis domain assignment. unknown when that assignment is missing. Read-only. The caller reads the public roster tables.';

revoke all on function public.thesis_steward(text) from public, anon;
grant execute on function public.thesis_steward(text)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- The watchdog runs as the caller. These three roles select the roster in
-- production; a replay still needs the grant. A policy is what lets row
-- security return the assignment instead of an empty read.
grant select on public.thesis_domains to quantanamo_worker, oddsborne_worker, bandit_worker;
grant select on public.desk_domain_stewards to quantanamo_worker, oddsborne_worker, bandit_worker;
grant select on public.desk_agents to quantanamo_worker, oddsborne_worker, bandit_worker;

drop policy if exists quantanamo_worker_select on public.thesis_domains;
create policy quantanamo_worker_select on public.thesis_domains
  for select to quantanamo_worker using (true);
drop policy if exists oddsborne_worker_select on public.thesis_domains;
create policy oddsborne_worker_select on public.thesis_domains
  for select to oddsborne_worker using (true);
drop policy if exists bandit_worker_select on public.thesis_domains;
create policy bandit_worker_select on public.thesis_domains
  for select to bandit_worker using (true);

drop policy if exists quantanamo_worker_select on public.desk_domain_stewards;
create policy quantanamo_worker_select on public.desk_domain_stewards
  for select to quantanamo_worker using (true);
drop policy if exists oddsborne_worker_select on public.desk_domain_stewards;
create policy oddsborne_worker_select on public.desk_domain_stewards
  for select to oddsborne_worker using (true);

-- ---------------------------------------------------------------- 2. the queued rows
create or replace view public.v_stale_queued_tests
with (security_invoker = true)
as
select
  t.id as test_id,
  rc.thesis_id,
  public.thesis_steward(rc.thesis_id) as steward,
  t.status,
  t.tested_at,
  public.strategy_test_window_end(t.window_end, t.params_json) as window_end,
  case
    when t.tested_at is null then null
    else ((now() at time zone 'America/New_York')::date
          - (t.tested_at at time zone 'America/New_York')::date)
  end as age_days
from public.strategy_tests t
join public.research_cycles rc on rc.id = t.cycle_id
where public.strategy_test_is_stale_queued(
  t.status,
  t.tested_at,
  public.strategy_test_window_end(t.window_end, t.params_json),
  now()
);

comment on view public.v_stale_queued_tests is
  'Queued strategy tests at least 7 days old, or whose window end is before today in America/New_York. steward is unknown when the thesis has no domain assignment. Does not change a test.';

revoke all on public.v_stale_queued_tests from public, anon;
grant select on public.v_stale_queued_tests
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 3. a lesson that names one preregistered test
-- One id only. "Test 42 preregistered", "preregistered as strategy_test #41",
-- and "Queued test 36" count. "killed by test 30" does not: that test already
-- resolved and the sentence is not a preregistration.
create or replace function public.lesson_named_test_ids(p_summary text)
returns setof bigint
language sql
immutable
security invoker
set search_path = ''
as $$
  select distinct (coalesce(m[1], m[2], m[3], m[4]))::bigint
  from regexp_matches(
    coalesce(p_summary, ''),
    $pat$(?i)(?:preregistered\s+as\s+strategy_test\s*#\s*(\d+)|strategy_test\s*#\s*(\d+)|\mtest\s+#?\s*(\d+)\s+preregistered|\mqueued\s+test\s+#?\s*(\d+))$pat$,
    'g'
  ) as m
  where coalesce(m[1], m[2], m[3], m[4]) ~ '^[0-9]{1,18}$';
$$;

comment on function public.lesson_named_test_ids(text) is
  'Distinct strategy-test ids a lesson summary names as preregistered or queued. Empty when the text does not.';

revoke all on function public.lesson_named_test_ids(text) from public, anon;
grant execute on function public.lesson_named_test_ids(text)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create or replace function public.lesson_named_test_id(p_summary text)
returns bigint
language sql
immutable
security invoker
set search_path = ''
as $$
  select case when count(*) = 1 then min(named) else null::bigint end
  from public.lesson_named_test_ids(p_summary) as named;
$$;

comment on function public.lesson_named_test_id(text) is
  'The one strategy-test id a summary names, or null when it names none or more than one.';

revoke all on function public.lesson_named_test_id(text) from public, anon;
grant execute on function public.lesson_named_test_id(text)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create or replace function public.lesson_names_preregistered_test(p_summary text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select exists (select 1 from public.lesson_named_test_ids(p_summary));
$$;

comment on function public.lesson_names_preregistered_test(text) is
  'True when a lesson summary names at least one preregistered or queued strategy test.';

revoke all on function public.lesson_names_preregistered_test(text) from public, anon;
grant execute on function public.lesson_names_preregistered_test(text)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 4. open lessons and the test they wait on
create or replace view public.v_open_lesson_tests
with (security_invoker = true)
as
select
  l.id as lesson_id,
  l.thesis_id,
  coalesce(l.test_id, named.named_id) as test_id,
  t.status as test_status,
  case
    when t.tested_at is null then null
    else ((now() at time zone 'America/New_York')::date
          - (t.tested_at at time zone 'America/New_York')::date)
  end as age_days
from public.research_lessons l
left join lateral (
  select public.lesson_named_test_id(l.summary) as named_id
) named on true
left join public.strategy_tests t
  on t.id = coalesce(l.test_id, named.named_id)
where l.incorporated = false
  and coalesce(l.test_id, named.named_id) is not null;

comment on view public.v_open_lesson_tests is
  'Each open research lesson and the strategy test it waits on. test_id is the column, else the one id the summary names. test_status and age_days are null when that test row or its tested_at is missing. age_days is New York calendar days since tested_at. Read-only.';

revoke all on public.v_open_lesson_tests from public, anon;
grant select on public.v_open_lesson_tests
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 5. fill a null test_id when the summary names one test on the same thesis
-- Lessons are written before the test row exists (lesson 137 at 23:26:01,
-- test 42 at 23:26:48). The lesson trigger fills test_id when the test is
-- already there. The test trigger fills lessons that named the new id.
create or replace function private.bind_named_lesson_test()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_named bigint;
begin
  if new.test_id is not null then
    return new;
  end if;
  v_named := public.lesson_named_test_id(new.summary);
  if v_named is null then
    return new;
  end if;
  if exists (
    select 1
    from public.strategy_tests t
    join public.research_cycles rc on rc.id = t.cycle_id
    where t.id = v_named
      and (
        rc.thesis_id = new.thesis_id
        or t.params_json->>'thesis_id' = new.thesis_id
      )
  ) then
    new.test_id := v_named;
  end if;
  return new;
end;
$$;

comment on function private.bind_named_lesson_test() is
  'BEFORE insert or summary change: set research_lessons.test_id when it is null and the summary names exactly one existing strategy test on the same thesis. Does not overwrite a test_id already set.';

revoke all on function private.bind_named_lesson_test() from public, anon;
grant execute on function private.bind_named_lesson_test()
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create or replace function private.bind_lessons_for_new_test()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thesis text;
begin
  select rc.thesis_id into v_thesis
  from public.research_cycles rc
  where rc.id = new.cycle_id;

  update public.research_lessons l
     set test_id = new.id
   where l.test_id is null
     and public.lesson_named_test_id(l.summary) = new.id
     and (
       l.thesis_id is not distinct from v_thesis
       or coalesce(new.params_json->>'thesis_id', '') = l.thesis_id
     );
  return new;
end;
$$;

comment on function private.bind_lessons_for_new_test() is
  'AFTER a strategy test is inserted: set test_id on lessons that name this test and still have test_id null, when the thesis matches. Does not change a lesson that already has a test_id.';

revoke all on function private.bind_lessons_for_new_test() from public, anon;
grant execute on function private.bind_lessons_for_new_test()
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

drop trigger if exists research_lessons_bind_named_test on public.research_lessons;
create trigger research_lessons_bind_named_test
  before insert or update of summary on public.research_lessons
  for each row
  execute function private.bind_named_lesson_test();

drop trigger if exists strategy_tests_bind_named_lessons on public.strategy_tests;
create trigger strategy_tests_bind_named_lessons
  after insert on public.strategy_tests
  for each row
  execute function private.bind_lessons_for_new_test();

-- Existing rows. Only a null test_id, and only when the named test is on the
-- same thesis. Lesson 137 ("Test 42 preregistered") and lesson 104
-- ("Queued test 36") match. A second run changes nothing.
update public.research_lessons l
   set test_id = named.named_id
  from (
    select id, thesis_id, public.lesson_named_test_id(summary) as named_id
    from public.research_lessons
    where test_id is null
  ) named
  join public.strategy_tests t on t.id = named.named_id
  join public.research_cycles rc on rc.id = t.cycle_id
 where l.id = named.id
   and l.test_id is null
   and (
     rc.thesis_id = named.thesis_id
     or t.params_json->>'thesis_id' = named.thesis_id
   );

-- ---------------------------------------------------------------- 6. watchdog columns, appended. Same body as schema 81 otherwise.
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
  ) as unlinked_named_lessons;

comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, and unlinked_named_lessons are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests at least 7 days old or past their window, by steward and thesis. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null.';

comment on column public.v_ledger_watchdog.stale_queued_tests is
  'Queued strategy tests in public.v_stale_queued_tests. n is the count. quantanamo, oddsborne, bandit, and unknown are that count by steward (unknown when the thesis has no domain assignment). theses lists thesis_id, steward, and n. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.unlinked_named_lessons is
  'Open research lessons whose summary names a preregistered or queued strategy test and whose test_id is still null. The bind triggers and the backfill in this migration are what keep it at zero. It does not make /api/health not-ok.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;
