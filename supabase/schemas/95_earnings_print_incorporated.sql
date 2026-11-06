-- Earnings-print lessons that already have a belief are incorporated.
--
-- steward_record_earnings_lesson wrote the lesson with incorporated = false,
-- then wrote belief_updates meta.kind = earnings_print. The belief is the
-- decision. The lesson was still sitting in the open backlog (196 RDDT,
-- 229 MELI on 2026-11-06). This marks the lesson incorporated in the same
-- transaction, including a replay that already has the belief.
--
-- Not a playbook rule. new_confidence stays null. Stated confidence and
-- sizing do not move. steward_close_lesson is unchanged: a trade_close_lesson
-- binding already leaves the open pile, and structure / missed_swing lessons
-- still need a playbook decision.
--
-- Inserts into research_cycles and research_lessons do not pass an id.
-- The identity default owns the id. research_id_sequences on the watchdog
-- reports when that sequence's last_value is behind max(id). It does not
-- call setval and it does not make /api/health not-ok.
--
-- Dry count, before apply (expect the bound open rows, including 196 and 229
-- if they are still open):
--
--   select l.id, l.incorporated, l.thesis_id
--   from public.research_lessons l
--   where l.lesson_type = 'earnings_print'
--     and l.incorporated is distinct from true
--     and exists (
--       select 1
--       from public.belief_updates b
--       where b.meta->>'kind' = 'earnings_print'
--         and (
--           b.meta->>'research_lesson_id' = l.id::text
--           or (
--             nullif(b.meta->>'lot_id', '') is not null
--             and exists (
--               select 1
--               from public.research_cycles c
--               where c.id = l.cycle_id
--                 and c.external_key = 'earnings-print:' || (b.meta->>'lot_id')
--             )
--           )
--         )
--     )
--   order by l.id;
--
-- After apply that select returns no rows. Confirm the named examples:
--
--   select id, lesson_type, incorporated
--   from public.research_lessons
--   where id in (196, 229);

-- ---------------------------------------------------------------- 1. sequence lag, read only
create or replace function public.research_id_sequence_state(p_table text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_max bigint;
  v_last bigint;
  v_called boolean;
begin
  if p_table = 'research_cycles' then
    select max(id) into v_max from public.research_cycles;
    select s.last_value, s.is_called into v_last, v_called from public.research_cycles_id_seq s;
  elsif p_table = 'research_lessons' then
    select max(id) into v_max from public.research_lessons;
    select s.last_value, s.is_called into v_last, v_called from public.research_lessons_id_seq s;
  else
    return null;
  end if;
  return jsonb_build_object(
    'max_id', v_max,
    'last_value', v_last,
    'is_called', coalesce(v_called, false),
    'lagging', v_max is not null and (
      v_last is null
      or v_last < v_max
      or (v_called is not true and v_last <= v_max)
    )
  );
end;
$$;

comment on function public.research_id_sequence_state(text) is
  'Read-only. max(id), identity last_value, and is_called for research_cycles or research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). Any other table name returns null. Does not call setval. Does not make /api/health not-ok.';

revoke all on function public.research_id_sequence_state(text) from public, anon;
grant execute on function public.research_id_sequence_state(text)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- SELECT lets the watchdog read last_value. UPDATE (nextval) stays with the writers who already have it.
grant select on sequence public.research_cycles_id_seq, public.research_lessons_id_seq
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

-- ---------------------------------------------------------------- 2. the writer marks the lesson incorporated once the belief exists
create or replace function public.steward_record_earnings_lesson(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_lot uuid;
  v_symbol text;
  v_thesis text;
  v_summary text := btrim(coalesce(p->>'summary', ''));
  v_ratio numeric;
  v_jumped boolean;
  v_implied numeric;
  v_cc numeric;
  v_loose boolean;
  v_n integer;
  v_cycle bigint;
  v_lesson bigint;
  v_belief uuid;
  v_key text;
begin
  if current_user like '%\_worker' and current_user::text <> 'quantanamo_worker' then
    raise exception 'refusal:auth: % may not write an earnings lesson', current_user using errcode = '42501';
  end if;
  if v_steward <> 'quantanamo' then
    raise exception 'refusal:earnings_lesson: equity lessons are for quantanamo' using errcode = 'P0001';
  end if;
  begin
    v_lot := (p->>'lot_id')::uuid;
  exception when others then
    raise exception 'refusal:earnings_lesson: lot_id is not a uuid' using errcode = 'P0001';
  end;
  if v_lot is null then
    raise exception 'refusal:earnings_lesson: lot_id is required' using errcode = 'P0001';
  end if;
  if length(v_summary) < 20 then
    raise exception 'refusal:earnings_lesson: summary (what the print did, >= 20 chars) is required'
      using errcode = 'P0001';
  end if;
  select pe.symbol, pe.thesis_id into v_symbol, v_thesis
  from public.position_episodes pe
  where pe.id = v_lot;
  if v_symbol is null then
    raise exception 'refusal:earnings_lesson: lot % is not an equity lot', v_lot using errcode = 'P0001';
  end if;
  if v_thesis is null then
    return jsonb_build_object('ok', true, 'skipped', 'no_thesis', 'lot_id', v_lot, 'symbol', v_symbol);
  end if;
  select im.realized_close_to_close, im.realized_implied_ratio, im.line_jumped, im.expiry_loose,
         case when im.straddle_price > 0 and im.underlying_price > 0
           then im.straddle_price / im.underlying_price end
    into v_cc, v_ratio, v_jumped, v_loose, v_implied
  from public.equity_implied_moves im
  where im.lot_id = v_lot;
  if not found then
    raise exception 'refusal:earnings_lesson: lot % has no implied-move row', v_lot using errcode = 'P0001';
  end if;
  if not (coalesce(v_ratio > 1.5, false) or coalesce(v_jumped, false)) then
    return jsonb_build_object('ok', true, 'skipped', 'not_outlier', 'lot_id', v_lot, 'symbol', v_symbol);
  end if;
  if v_cc is null and not coalesce(v_jumped, false) then
    return jsonb_build_object('ok', true, 'skipped', 'score_incomplete', 'lot_id', v_lot, 'symbol', v_symbol);
  end if;

  select b.id into v_belief
  from public.belief_updates b
  where b.meta->>'kind' = 'earnings_print'
    and b.meta->>'lot_id' = v_lot::text
  order by b.observed_at desc
  limit 1;
  if v_belief is not null then
    update public.research_lessons l
    set incorporated = true
    where l.incorporated is distinct from true
      and (
        l.id = (
          select case
            when b.meta->>'research_lesson_id' ~ '^[0-9]+$'
              then (b.meta->>'research_lesson_id')::bigint
          end
          from public.belief_updates b
          where b.id = v_belief
        )
        or (
          l.lesson_type = 'earnings_print'
          and l.cycle_id = (
            select c.id
            from public.research_cycles c
            where c.external_key = 'earnings-print:' || v_lot::text
          )
        )
      );
    select l.id into v_lesson
    from public.research_lessons l
    where l.lesson_type = 'earnings_print'
      and l.cycle_id = (
        select c.id
        from public.research_cycles c
        where c.external_key = 'earnings-print:' || v_lot::text
      )
    order by l.id
    limit 1;
    if v_lesson is null then
      select case
        when b.meta->>'research_lesson_id' ~ '^[0-9]+$'
          then (b.meta->>'research_lesson_id')::bigint
      end into v_lesson
      from public.belief_updates b
      where b.id = v_belief;
    end if;
    return jsonb_build_object(
      'ok', true, 'replayed', true, 'incorporated', true,
      'belief_update_id', v_belief,
      'research_lesson_id', v_lesson,
      'lot_id', v_lot, 'symbol', v_symbol, 'thesis_id', v_thesis
    );
  end if;

  select count(*)::integer into v_n
  from public.equity_implied_moves where realized_close_to_close is not null;
  v_key := 'earnings-print:' || v_lot::text;

  insert into public.research_cycles (
    external_key, thesis_id, hypothesis, preregistered_outcome, preregistered_at,
    stage, status, iteration, created_at, updated_at
  ) values (
    v_key, v_thesis,
    'The options price bounds how far this lot can gap on the print.',
    'The close-to-close move stays inside 1.5x that price, and the open does not jump the exit.',
    pg_catalog.now(), 'research', 'open', 1, pg_catalog.now(), pg_catalog.now()
  )
  on conflict (external_key) do update set updated_at = pg_catalog.now()
  returning id into v_cycle;

  select l.id into v_lesson
  from public.research_lessons l
  where l.cycle_id = v_cycle and l.lesson_type = 'earnings_print'
  limit 1;
  if v_lesson is null then
    insert into public.research_lessons (
      cycle_id, thesis_id, lesson_type, summary, incorporated, created_at
    ) values (
      v_cycle, v_thesis, 'earnings_print', v_summary, false, pg_catalog.now()
    )
    returning id into v_lesson;
  end if;

  insert into public.belief_updates (
    thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta
  ) values (
    v_thesis, null, null, v_summary, pg_catalog.now(),
    jsonb_strip_nulls(jsonb_build_object(
      'kind', 'earnings_print',
      'steward', 'quantanamo',
      'lot_table', 'position_episodes',
      'lot_id', v_lot,
      'symbol', v_symbol,
      'writer', 'earnings_implied',
      'research_lesson_id', v_lesson,
      'realized_close_to_close', v_cc,
      'implied_fraction', v_implied,
      'realized_implied_ratio', v_ratio,
      'line_jumped', v_jumped,
      'expiry_loose', v_loose,
      'n', v_n,
      'thin', v_n < 5,
      'confidence_delta', 0
    ))
  )
  returning id into v_belief;

  update public.research_lessons
  set incorporated = true
  where id = v_lesson
    and incorporated is distinct from true;

  return jsonb_build_object(
    'ok', true,
    'incorporated', true,
    'belief_update_id', v_belief,
    'research_lesson_id', v_lesson,
    'lot_id', v_lot,
    'symbol', v_symbol,
    'thesis_id', v_thesis,
    'thin', v_n < 5,
    'n', v_n
  );
end;
$$;

comment on function public.steward_record_earnings_lesson(jsonb) is
  'One research_lessons row and one belief_updates row (kind earnings_print) when a scored print moved more than 1.5x the priced move or the open jumped the exit. The lesson is incorporated in the same transaction, including a replay that already has the belief. Idempotent per lot. new_confidence is null, so stated confidence and sizing do not move. Not a playbook_rule, so the rule in force stays.';

revoke all on function public.steward_record_earnings_lesson(jsonb) from public, anon, authenticated;
grant execute on function public.steward_record_earnings_lesson(jsonb) to quantanamo_worker, service_role;

-- ---------------------------------------------------------------- 3. backfill lessons the belief already binds
-- The notice is the dry count. The update uses that same id list.
create temporary table earnings_print_to_incorporate as
select l.id
from public.research_lessons l
where l.lesson_type = 'earnings_print'
  and l.incorporated is distinct from true
  and exists (
    select 1
    from public.belief_updates b
    where b.meta->>'kind' = 'earnings_print'
      and (
        b.meta->>'research_lesson_id' = l.id::text
        or (
          nullif(b.meta->>'lot_id', '') is not null
          and exists (
            select 1
            from public.research_cycles c
            where c.id = l.cycle_id
              and c.external_key = 'earnings-print:' || (b.meta->>'lot_id')
          )
        )
      )
  );

do $$
declare
  v_n integer;
begin
  select count(*)::integer into v_n from earnings_print_to_incorporate;
  raise notice 'earnings_print lessons with a belief, still open, about to be incorporated: %', v_n;
end $$;

update public.research_lessons l
set incorporated = true
from earnings_print_to_incorporate b
where l.id = b.id
  and l.incorporated is distinct from true;

drop table earnings_print_to_incorporate;

-- ---------------------------------------------------------------- 4. learning health sees a sequence that is behind max(id)
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
  ) as research_id_sequences;


comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, learning_stalls, unlinked_named_lessons, ontology_freshness, and research_id_sequences are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests that have waited at least five NYSE sessions, by steward and thesis. learning_stalls is that list in plain sentences, with retired stewards left out, and grasshopper_touch_heartbeat returns it beside escalated. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null. ontology_freshness is the proposer run: last_run_at, evidence_through, considered, proposed, skipped, and lagging only when that run is missing, older than eight hours, or newer notes arrived after evidence_through. A run that proposed nothing is not lagging. research_id_sequences is max(id), identity last_value, is_called, and lagging for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). It does not call setval.';

comment on column public.v_ledger_watchdog.research_id_sequences is
  'Identity sequence versus max(id) for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). An empty table is not lagging. It does not call setval and it does not make /api/health not-ok.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;
