-- Learning-loop stalls, and ontology freshness from the proposer's own run.
--
-- A queued strategy test is a stall after five NYSE sessions, not after a
-- historical sample window has already ended. Retired stewards stay out of
-- the heartbeat list the same way the desk already drops them. This file
-- does not score a test, does not change a lesson, and does not call the
-- proposer. A successful cron run is copied into the run log so "nothing
-- new qualified" is visible before the next sweep.
--
-- /api/health stays ok. The stall is the sentence list learning_stalls,
-- which grasshopper_touch_heartbeat returns beside the sell-now list.

-- ---------------------------------------------------------------- 1. five trading days
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
    and p_tested_at is not null
    and p_at is not null
    and (
      select count(*)
      from generate_series(
        ((p_tested_at at time zone 'America/New_York')::date + 1),
        (p_at at time zone 'America/New_York')::date,
        interval '1 day'
      ) as g(day)
      where extract(isodow from g.day::date) between 1 and 5
        and not exists (
          select 1
          from public.us_equity_market_calendar c
          where c.day = g.day::date
            and c.kind = 'holiday'
        )
    ) >= 5;
$$;

comment on function public.strategy_test_is_stale_queued(text, timestamptz, date, timestamptz) is
  'True when a strategy test is still queued and at least five NYSE sessions have opened after the New York date it was written. Weekends and us_equity_market_calendar holidays are not sessions. A historical sample window is not itself a stall. p_window_end is kept so existing callers do not change.';

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
  end as age_days,
  case
    when t.tested_at is null then null
    else (
      select count(*)::integer
      from generate_series(
        ((t.tested_at at time zone 'America/New_York')::date + 1),
        (now() at time zone 'America/New_York')::date,
        interval '1 day'
      ) as g(day)
      where extract(isodow from g.day::date) between 1 and 5
        and not exists (
          select 1
          from public.us_equity_market_calendar c
          where c.day = g.day::date
            and c.kind = 'holiday'
        )
    )
  end as trading_days
from public.strategy_tests t
join public.research_cycles rc on rc.id = t.cycle_id
where public.strategy_test_is_stale_queued(
  t.status,
  t.tested_at,
  public.strategy_test_window_end(t.window_end, t.params_json),
  now()
);

comment on view public.v_stale_queued_tests is
  'Queued strategy tests that have waited at least five NYSE sessions since tested_at. trading_days counts those sessions. Does not change a test. Retired stewards are filtered later, on learning_stalls.';

-- ---------------------------------------------------------------- 2. proposer run log
create table if not exists public.ontology_proposer_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  considered integer not null,
  proposed integer not null,
  skipped integer not null,
  evidence_through timestamptz,
  detail jsonb not null default '{}'::jsonb,
  constraint ontology_proposer_runs_counts_check check (
    considered >= 0 and proposed >= 0 and skipped >= 0
  )
);

comment on table public.ontology_proposer_runs is
  'One row per ontology proposer run. considered is the notes it looked at, proposed is new candidate keys, skipped is the rest. evidence_through is the newest bookmark or lesson stamp that existed at the run. Read-only for the desk.';

create index if not exists ontology_proposer_runs_ran_at_idx
  on public.ontology_proposer_runs (ran_at desc);

alter table public.ontology_proposer_runs enable row level security;

revoke all on table public.ontology_proposer_runs from public, anon, authenticated;
grant select on table public.ontology_proposer_runs
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

drop policy if exists ontology_proposer_runs_read on public.ontology_proposer_runs;
create policy ontology_proposer_runs_read on public.ontology_proposer_runs
  for select to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader
  using (true);

-- ---------------------------------------------------------------- 3. record a run, without changing who may propose
create or replace function private.record_ontology_proposer_run(p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_considered integer := 0;
  v_newest timestamptz;
  v_proposed integer := 0;
  v_skipped integer := 0;
  v_ok boolean := coalesce((p_result->>'ok')::boolean, false);
begin
  select count(*)::integer
    into v_considered
  from (
    select 1
    from public.bookmarks b
    where b.is_market_related
      and b.classified_at >= timestamptz '2026-09-13 00:00:00+00'
    union all
    select 1
    from public.research_lessons l
    where l.created_at >= timestamptz '2026-09-13 00:00:00+00'
  ) seen;

  select max(stamps.v)
    into v_newest
  from (
    select b.created_at as v from public.bookmarks b
    union all
    select b.fetched_at from public.bookmarks b
    union all
    select b.classified_at from public.bookmarks b
    union all
    select l.created_at from public.research_lessons l
  ) stamps(v);

  v_proposed := coalesce((p_result->>'inserted')::integer, 0);
  v_skipped := case
    when v_proposed = 0 then v_considered
    else greatest(0, v_considered - coalesce((p_result->>'evidence')::integer, 0))
  end;

  insert into public.ontology_proposer_runs (
    ran_at, ok, considered, proposed, skipped, evidence_through, detail
  ) values (
    clock_timestamp(), v_ok, v_considered, v_proposed, v_skipped, v_newest, coalesce(p_result, '{}'::jsonb)
  );

  return coalesce(p_result, '{}'::jsonb) || jsonb_build_object(
    'ran_at', clock_timestamp(),
    'considered', v_considered,
    'proposed', v_proposed,
    'skipped', v_skipped,
    'evidence_through', v_newest
  );
end;
$$;

comment on function private.record_ontology_proposer_run(jsonb) is
  'Append one ontology_proposer_runs row for a proposer result. considered counts market bookmarks classified since 2026-09-13 and lessons written since then. proposed is inserted keys. skipped is the rest, or every considered note when nothing new was inserted. Does not propose.';

revoke all on function private.record_ontology_proposer_run(jsonb) from public, anon, authenticated;

create or replace function private.propose_ontology_candidates_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $trg$
declare
  v_result jsonb;
begin
  v_result := private.propose_ontology_candidates();
  perform private.record_ontology_proposer_run(v_result);
  return null;
end;
$trg$;

comment on function private.propose_ontology_candidates_trigger() is
  'After a bookmark classification or a research lesson, propose ontology candidates and record considered, proposed, and skipped. Statement-level so a batch is one pass.';

create or replace function public.propose_ontology_candidates()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.propose_ontology_candidates();
  return private.record_ontology_proposer_run(v_result);
end;
$$;

comment on function public.propose_ontology_candidates() is
  'Steward sweep: propose ontology candidates, then record the run. Re-runnable. Anon cannot call this. The actor check stays inside private.propose_ontology_candidates.';

revoke all on function public.propose_ontology_candidates() from public, anon;

-- ---------------------------------------------------------------- 4. watchdog
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
  ), '[]'::jsonb) as learning_stalls;

comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, learning_stalls, unlinked_named_lessons, and ontology_freshness are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests that have waited at least five NYSE sessions, by steward and thesis. learning_stalls is that list in plain sentences, with retired stewards left out, and grasshopper_touch_heartbeat returns it beside escalated. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null. ontology_freshness is the proposer run: last_run_at, evidence_through, considered, proposed, skipped, and lagging only when that run is missing, older than eight hours, or newer notes arrived after evidence_through. A run that proposed nothing is not lagging.';

comment on column public.v_ledger_watchdog.stale_queued_tests is
  'Queued strategy tests in public.v_stale_queued_tests. n is the count of tests that have waited at least five NYSE sessions. quantanamo, oddsborne, bandit, and unknown are that count by steward. theses lists thesis_id, steward, and n. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.unlinked_named_lessons is
  'Open research lessons whose summary names a preregistered or queued strategy test and whose test_id is still null. The bind triggers and the backfill in this migration are what keep it at zero. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.ontology_freshness is
  'Ontology proposer freshness. last_run_at is the newest ok row in ontology_proposer_runs. evidence_through is the newest bookmark or lesson stamp that run recorded. considered, proposed, and skipped are that row''s counts. lagging is true when there is no successful run, the run is older than eight hours, or newest_evidence_at is after evidence_through. proposed 0 with lagging false means the proposer ran and nothing new qualified. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.learning_stalls is
  'Plain sentences for queued strategy tests that have waited at least five NYSE sessions, excluding stewards whose desk_agents.status is retired. The same list is returned by grasshopper_touch_heartbeat as learning_stalls, beside the sell-now escalated list. It does not make /api/health not-ok.';

-- Existing readers already select this view. Restate the grant so a replay
-- still has it. This is not a new role.
grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 5. heartbeat returns the stall list
create or replace function public.grasshopper_touch_heartbeat(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
  v_stalls jsonb;
begin
  update public.desk_agents set heartbeat_at = now(), updated_at = now()
   where slug = 'grasshopper' returning heartbeat_at into v_at;
  perform public.note_actionable_breaches(jsonb_build_object(
    'check_key', 'heartbeat:grasshopper:' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI')));
  select coalesce(w.learning_stalls, '[]'::jsonb) into v_stalls
    from public.v_ledger_watchdog w;
  return jsonb_build_object(
    'heartbeat_at', v_at,
    'escalated', public.escalated_breaches('{}'::jsonb),
    'learning_stalls', coalesce(v_stalls, '[]'::jsonb)
  );
end;
$$;

comment on function public.grasshopper_touch_heartbeat(jsonb) is
  'Ledger steward heartbeat. select public.grasshopper_touch_heartbeat(''{}''::jsonb). Returns heartbeat_at, escalated (sell now), and learning_stalls (queued tests waiting at least five trading days, retired stewards excluded). service_role only; no grasshopper_worker login. Does not change a test or a lesson.';

-- ---------------------------------------------------------------- 6. the run that already succeeded, without proposing again
insert into public.ontology_proposer_runs (
  ran_at, ok, considered, proposed, skipped, evidence_through, detail
)
select
  d.end_time,
  true,
  census.considered,
  0,
  census.considered,
  census.newest,
  jsonb_build_object(
    'source', 'cron.job_run_details',
    'job', 'propose_ontology_candidates',
    'return_message', d.return_message,
    'seeded', true
  )
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
cross join lateral (
  select
    (
      select count(*)::integer
      from (
        select 1
        from public.bookmarks b
        where b.is_market_related
          and b.classified_at >= timestamptz '2026-09-13 00:00:00+00'
          and b.classified_at <= d.end_time
        union all
        select 1
        from public.research_lessons l
        where l.created_at >= timestamptz '2026-09-13 00:00:00+00'
          and l.created_at <= d.end_time
      ) seen
    ) as considered,
    (
      select max(stamps.v)
      from (
        select b.created_at as v from public.bookmarks b
        union all
        select b.fetched_at from public.bookmarks b
        union all
        select b.classified_at from public.bookmarks b
        union all
        select l.created_at from public.research_lessons l
      ) stamps(v)
      where stamps.v <= d.end_time
    ) as newest
) census
where j.jobname = 'propose_ontology_candidates'
  and d.status = 'succeeded'
  and not exists (
    select 1
    from public.ontology_candidates c
    where c.first_seen_at >= d.start_time
      and c.first_seen_at <= d.end_time
  )
  and not exists (select 1 from public.ontology_proposer_runs)
order by d.end_time desc
limit 1;
