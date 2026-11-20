-- A blank repeat role was read as a break, so an obeyed rule looked like it
-- was not taking. A null or unknown lineage_role is now unclassified: it is
-- not a violation, and it is left out of the status choice, so it cannot by
-- itself set not_taking or fix_failed. The chain counts those lessons as
-- unclassified. unclassified_repeats is that count for the watchdog.
-- violation, confirmation, refinement, and rule_cost keep their meanings.
-- rule_cost still reads as costing.
--
-- A new repeat link requires one of those four roles. The lesson text still
-- fills a clear phrase. Anything else is refused at the link, not stored as
-- a break.
--
-- Lessons 275 and 276 say the rule was obeyed. 275 is the outcome of the
-- chase already counted on lesson 233. 276 stopped at its line and did not
-- re-enter. Lesson 260 says the Monday-morning coverage miss came back, so
-- it stays blank. This file is applied with Supabase apply_migration after
-- merge. CI does not apply it.
--
-- Retired seats (oddsborne_worker, bandit_worker) get no execute on the
-- helpers. They keep the close-lesson grant they already have.
-- desk_public_reader keeps select on the watchdog view.

comment on column public.research_lessons.lineage_role is
  'What this lesson does to an older lesson it cites. violation: the steward acted against the incorporated rule, or a miss that rule was meant to prevent happened again. confirmation: the rule held, a rule-correct pass, the rule stands, or no rule change with evidence it held. refinement: the lesson narrows or conditions the rule. rule_cost: the rule was obeyed, and the pass left a qualified winner behind. Null when the lesson does not cite an older lesson. Writers set it when it does. The text fills it only when the wording is clear. A repeat link with no role is refused. A blank role already stored is unclassified on the watchdog, not a violation.';

comment on function private.lesson_lineage_role(text) is
  'violation, confirmation, refinement, or rule_cost when the summary says so in a fixed phrase. rule_cost is the pass was correct or the name was correctly passed. Null when the text is not that clear. Does not write the row. A repeat whose role is still null is refused by the link, not read as a violation.';

create or replace function private.link_research_lesson_repeats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lineage_role is null
     and (
       exists (
         select 1
         from private.cited_lesson_ids(new.summary) cited
         join public.research_lessons earlier on earlier.id = cited.lesson_id
         where (earlier.created_at, earlier.id) < (new.created_at, new.id)
       )
       or (
         private.lesson_continues_uncited(new.summary)
         and exists (
           select 1
           from public.research_lessons prior
           where prior.thesis_id = new.thesis_id
             and prior.lesson_type = new.lesson_type
             and (prior.created_at, prior.id) < (new.created_at, new.id)
         )
       )
     ) then
    raise exception 'refusal:input: a lesson that cites an older lesson needs lineage_role (violation, confirmation, refinement, or rule_cost)'
      using errcode = 'P0001';
  end if;

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
  'AFTER insert or summary change: replace this lesson''s links with citations of older lessons. When the summary names none and says the rule stands or was a forward pass, link the newest older lesson of the same type on the same thesis. Refuses the write when a link would be created and lineage_role is still null. Does not change a belief or incorporated.';

revoke all on function private.link_research_lesson_repeats() from public, anon, authenticated, desk_public_reader;
revoke execute on function private.link_research_lesson_repeats() from oddsborne_worker, bandit_worker;
grant execute on function private.link_research_lesson_repeats()
  to quantanamo_worker, service_role;

create or replace function private.guard_research_lesson_repeat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select l.lineage_role into v_role
  from public.research_lessons l
  where l.id = new.lesson_id;
  if v_role is null or v_role not in ('violation', 'confirmation', 'refinement', 'rule_cost') then
    raise exception 'refusal:input: a lesson that cites an older lesson needs lineage_role (violation, confirmation, refinement, or rule_cost), lesson %', new.lesson_id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function private.guard_research_lesson_repeat() is
  'BEFORE insert of a repeat link: the lesson must already have lineage_role violation, confirmation, refinement, or rule_cost. Does not invent a role and does not change a belief or incorporated.';

revoke all on function private.guard_research_lesson_repeat() from public, anon, authenticated, desk_public_reader;
revoke execute on function private.guard_research_lesson_repeat() from oddsborne_worker, bandit_worker;
grant execute on function private.guard_research_lesson_repeat()
  to quantanamo_worker, service_role;

drop trigger if exists research_lesson_repeats_require_lineage_role on public.research_lesson_repeats;
create trigger research_lesson_repeats_require_lineage_role
  before insert on public.research_lesson_repeats
  for each row
  execute function private.guard_research_lesson_repeat();

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
     and v_lineage_role not in ('violation', 'confirmation', 'refinement', 'rule_cost') then
    raise exception 'refusal:input: lineage_role must be violation, confirmation, refinement, or rule_cost, got %', v_lineage_role
      using errcode = 'P0001';
  end if;
  if v_lesson_summary is not null and v_lineage_role is null then
    v_lineage_role := private.lesson_lineage_role(v_lesson_summary);
  end if;
  if v_lesson_summary is not null and v_lineage_role is null
     and (
       exists (
         select 1
         from private.cited_lesson_ids(v_lesson_summary) cited
         join public.research_lessons earlier on earlier.id = cited.lesson_id
       )
       or (
         private.lesson_continues_uncited(v_lesson_summary)
         and exists (
           select 1
           from public.research_lessons prior
           where prior.thesis_id = v_thesis
             and prior.lesson_type = v_lesson_type
         )
       )
     ) then
    raise exception 'refusal:input: a lesson that cites an older lesson needs lineage_role (violation, confirmation, refinement, or rule_cost)'
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
  'Close lesson for a steward lot. Moves confidence from the ledger and, for trade_close_lesson, stamps meta.research_lesson_id from the lesson written in this call or the one lesson within 10 minutes. lineage_role on a new research lesson is violation, confirmation, refinement, or rule_cost. Omit it only when the lesson cites no older lesson. The text fills a clear phrase. A citation with no role is refused. A blank role already stored is unclassified, not a break. dry_run writes nothing. A losing close cannot raise confidence.';

revoke all on function public.steward_close_lesson(jsonb) from public, anon, authenticated;
grant execute on function public.steward_close_lesson(jsonb) to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;


-- 275: the CEG chase already counted on lesson 233 ended at its line.
-- 276: the KKR starter stopped at its line, and the lesson says there was no re-entry.
-- 260 stays null: Monday-morning printers were still missing from the sheet.
update public.research_lessons
   set lineage_role = 'confirmation'
 where id in (275, 276)
   and lineage_role is null;

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
      'starved', agg.starved,
      'learning_loop', (
        (agg.first_seen is null or agg.first_seen < now() - interval '72 hours')
        and ev.newest is not null
        and (agg.first_seen is null or ev.newest > agg.first_seen)
      )
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
  lineage.lesson_came_back,
  public.earnings_sheet_staleness(now()) as earnings_sheet_stale,
  lineage.unclassified_repeats
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
           l.summary,
           -- A null or unknown lineage_role is unclassified. It is not a
           -- violation, and it is left out of the status choice, so it cannot
           -- by itself set not_taking or fix_failed. rule_cost stays explicit.
           coalesce(
             case
               when l.lineage_role in ('violation', 'confirmation', 'refinement', 'rule_cost') then l.lineage_role
             end,
             'unclassified'
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
          'unclassified', (
            select count(*)::integer
            from repeat_roles r
            where r.root_id = k.root_id
              and r.role = 'unclassified'
          ),
          'rule_costs', (
            select count(*)::integer
            from repeat_roles r
            where r.root_id = k.root_id
              and r.role = 'rule_cost'
          ),
          'cost_summaries', coalesce((
            select jsonb_agg(r.summary order by r.created_at, r.lesson_id)
            from repeat_roles r
            where r.root_id = k.root_id
              and r.role = 'rule_cost'
          ), '[]'::jsonb),
          'fix_ref', fx.fix_ref,
          'shipped_at', fx.shipped_at,
          'status', case
            when fx.shipped_at is not null and not exists (
              select 1
              from repeat_roles r
              where r.root_id = k.root_id
                and r.created_at > fx.shipped_at
                and r.role <> 'unclassified'
            ) then 'fix_shipped_watching'
            when exists (
              select 1
              from repeat_roles r
              where r.root_id = k.root_id
                and r.role = 'rule_cost'
                and r.created_at > coalesce((
                  select max(inc.created_at)
                  from public.research_lessons inc
                  where inc.id = any (k.lesson_ids)
                    and inc.incorporated
                ), '-infinity'::timestamptz)
                and (fx.shipped_at is null or r.created_at > fx.shipped_at)
            ) and not exists (
              select 1
              from repeat_roles r
              where r.root_id = k.root_id
                and r.created_at > coalesce((
                  select max(inc.created_at)
                  from public.research_lessons inc
                  where inc.id = any (k.lesson_ids)
                    and inc.incorporated
                ), '-infinity'::timestamptz)
                and (fx.shipped_at is null or r.created_at > fx.shipped_at)
                and r.role <> 'unclassified'
                and r.role is distinct from 'rule_cost'
            ) then 'costing'
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
                and r.role <> 'unclassified'
                and r.role is distinct from 'confirmation'
            ) then 'holding'
            when not exists (
              select 1
              from repeat_roles r
              where r.root_id = k.root_id
                and (fx.shipped_at is null or r.created_at > fx.shipped_at)
                and r.role <> 'unclassified'
                and r.role is distinct from 'refinement'
            ) then 'refining'
            else case
              when (
                select r.role
                from repeat_roles r
                where r.root_id = k.root_id
                  and (fx.shipped_at is null or r.created_at > fx.shipped_at)
                  and r.role <> 'unclassified'
                order by r.created_at desc, r.lesson_id desc
                limit 1
              ) = 'confirmation' then 'holding'
              when (
                select r.role
                from repeat_roles r
                where r.root_id = k.root_id
                  and (fx.shipped_at is null or r.created_at > fx.shipped_at)
                  and r.role <> 'unclassified'
                order by r.created_at desc, r.lesson_id desc
                limit 1
              ) = 'rule_cost' then 'costing'
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
    coalesce((
      select count(distinct r.lesson_id)::integer
      from repeat_roles r
      where r.role = 'unclassified'
    ), 0) as unclassified_repeats
) lineage on true;


comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, learning_stalls, unlinked_named_lessons, ontology_freshness, and research_id_sequences are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests that have waited at least five NYSE sessions, by steward and thesis. learning_stalls is that list in plain sentences, with retired stewards left out, and grasshopper_touch_heartbeat returns it beside escalated. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null. ontology_freshness is the proposer run: last_run_at, evidence_through, considered, proposed, skipped, and lagging only when that run is missing, older than eight hours, or newer notes arrived after evidence_through. A run that proposed nothing is not lagging. learning_loop is true when last_first_seen_at is null or older than 72 hours and a bookmark or lesson is newer than that first-seen. It is the learning-loop flag for a starved ontology grind. It does not make /api/health not-ok. research_id_sequences is max(id), identity last_value, is_called, and lagging for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). It does not call setval. rules_not_taking lists an incorporated lesson that later lessons cite again, directly or through the ones in between, when that chain is at least 3 lessons long. A lesson already inside a longer chain is not listed on its own. lesson_ids run oldest first. summary is the newest lesson in the chain. came_back is how many lessons followed the first. violations is how many later lessons have role violation. A null or unknown lineage_role on a repeat is unclassified. It is not counted in violations, and it is left out of the status choice, so it cannot by itself set not_taking or fix_failed. unclassified counts those lessons on the chain. unclassified_repeats is that count across the chains. rule_cost means the rule was obeyed and the pass left a qualified winner behind. It is not a violation. rule_costs counts those lessons. cost_summaries are their texts. fix_ref and shipped_at are the newest research_lesson_fixes row whose lesson is in the chain. came_back still counts every later lesson. status is costing when every classified lesson after the latest incorporated lesson in the chain, and after a shipped fix when there is one, is rule_cost. An unclassified lesson does not change that. status is not_taking when a later lesson broke the rule and no later lesson says it held, holding when the later lessons say the rule held, and refining when they only narrow it. fix_shipped_watching stays when a fix is recorded and no classified lesson citing the chain was created after shipped_at. An unclassified lesson does not end that watch. fix_failed is a later lesson that broke the rule after shipped_at. failed_lesson_id is that lesson. A confirmation after the fix does not fail it. A rule_cost after the fix does not fail it. Only not_taking and fix_failed are the alarm. costing is a review, not the alarm. lesson_came_back is that count for every lesson cited at least once, including a single repeat. rules_not_taking and lesson_came_back do not make /api/health not-ok. earnings_sheet_stale is stale, last_sheet_at, sessions_missed, and latest_entry_session. stale is true when no research_queue row with source earnings_sheet covers the latest NYSE entry session. A row written before that session close is for that session. A row written after the close, or on a day that is not a session, is for the next session. sessions_missed counts NYSE sessions after the last covered entry session through the latest one, and is null when no sheet has covered a session up to that day. Holidays in us_equity_market_calendar are not sessions. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.research_id_sequences is
  'Identity sequence versus max(id) for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). An empty table is not lagging. It does not call setval and it does not make /api/health not-ok.';


comment on column public.v_ledger_watchdog.rules_not_taking is
  'Incorporated lessons re-taught at least twice (chain length at least 3), oldest lesson in the chain first. Each item has lesson_ids, thesis_id, the newest summary, came_back, violations, unclassified, rule_costs, cost_summaries, fix_ref, shipped_at, status, and failed_lesson_id. violations counts later lessons whose role is violation. A null or unknown lineage_role on a repeat is unclassified. It is not counted in violations, and it is left out of the status choice, so it cannot by itself set not_taking or fix_failed. unclassified counts those lessons on the chain. unclassified_repeats is that count across the chains. rule_cost means the rule was obeyed and the pass left a qualified winner behind. It is not a violation. rule_costs counts those lessons. cost_summaries are their texts. came_back still counts every later lesson. status is costing when every classified lesson after the latest incorporated lesson in the chain, and after a shipped fix when there is one, is rule_cost. An unclassified lesson does not change that. status is not_taking when a later lesson broke the rule and no later lesson says it held, holding when the later lessons say the rule held, and refining when they only narrow it. fix_shipped_watching stays when a fix is recorded and no classified lesson citing the chain was created after shipped_at. An unclassified lesson does not end that watch. fix_failed is a later lesson that broke the rule after shipped_at. failed_lesson_id is that lesson. A confirmation after the fix does not fail it. A rule_cost after the fix does not fail it. Only not_taking and fix_failed are the alarm. costing is a review, not the alarm. A lesson already inside a longer chain is left out. Does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.lesson_came_back is
  'How many later lessons cite this lesson, directly or through the ones in between. One repeat is included. Absent from rules_not_taking until the chain reaches 3. Does not make /api/health not-ok.';


comment on column public.v_ledger_watchdog.earnings_sheet_stale is
  'stale, last_sheet_at, sessions_missed, and latest_entry_session for source earnings_sheet. stale is true when no row covers the latest NYSE entry session. sessions_missed counts sessions after the last covered entry session through that day, and is null when no sheet has covered a session up to that day. Does not make /api/health not-ok.';


grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

comment on column public.v_ledger_watchdog.unclassified_repeats is
  'How many later lessons in the rules_not_taking chains have no lineage_role, or a role outside violation, confirmation, refinement, and rule_cost. Not a break. Does not make /api/health not-ok.';

-- The live database still has an older copy, v_ledger_watchdog_base, that
-- nothing in this repo selects. Fresh installs never create it. When it is
-- already there, point it at the watchdog so a leftover reader sees the same
-- rows, including unclassified_repeats. Grants already on the view stay.
do $base$
begin
  if to_regclass('public.v_ledger_watchdog_base') is not null then
    execute 'create or replace view public.v_ledger_watchdog_base with (security_invoker = true) as select * from public.v_ledger_watchdog';
    execute $comment$comment on view public.v_ledger_watchdog_base is 'Same rows as v_ledger_watchdog. A blank repeat role is unclassified, not a break. Does not make /api/health not-ok.'$comment$;
  end if;
end
$base$;
