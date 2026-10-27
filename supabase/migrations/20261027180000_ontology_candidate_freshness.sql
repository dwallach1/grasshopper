-- Ontology candidates stopped landing on 2026-08-24, when bookmark_ingest
-- runs ended. The Sept 13 rows are review probes, not extraction. Live scans
-- still classify bookmarks (stewards/quantanamo/classify.py and ad-hoc
-- writers) and stewards still write research_lessons, but nothing inserted
-- ontology_candidates. This proposes membership candidates from those two
-- sources, then runs the existing junk sweep.
--
-- Bookmarks: cashtags and bookmark_symbols on market-related rows classified
-- on or after 2026-09-13. A theme is attached only when the post names at
-- most four tickers and an active term of length >= 6 is in the text, and
-- the symbol is not already an active member of that theme. Otherwise the
-- ticker is unscoped, and only when no membership candidate exists yet.
-- Lessons: a thesis symbol written in the lesson, on the theme bound to that
-- thesis. Scores are the bookmark market_score, or 0 for a lesson (no
-- confidence was stated). Status of an existing candidate is left alone.

create or replace function private.propose_ontology_candidates()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor text;
  v_inserted integer := 0;
  v_evidence integer := 0;
  v_recounted integer := 0;
  v_ids bigint[] := '{}';
  v_rejected jsonb;
begin
  -- A bookmark or lesson write already passed that table's grants. The
  -- trigger may propose. A direct call still needs an operator or a steward role.
  if pg_trigger_depth() = 0 then
    v_actor := coalesce((select auth.uid())::text, '');
    if v_actor <> '' then
      if not (select private.is_ledger_operator()) then
        raise exception 'not_operator' using errcode = '42501';
      end if;
    elsif session_user not in (
      'service_role', 'postgres', 'supabase_admin',
      'quantanamo_worker', 'oddsborne_worker', 'bandit_worker'
    ) then
      raise exception 'not_operator' using errcode = '42501';
    else
      v_actor := session_user;
    end if;
  else
    v_actor := session_user;
  end if;

  with bookmark_raw as (
    select
      b.id as source_key,
      'bookmark'::text as source_type,
      b.classified_at as observed_at,
      least(100, greatest(0, coalesce(b.market_score, 0)))::smallint as score,
      left(regexp_replace(coalesce(b.text, ''), '\s+', ' ', 'g'), 180) as excerpt,
      b.text,
      upper(sym.symbol) as symbol
    from public.bookmarks b
    cross join lateral (
      select distinct m[1] as symbol
      from regexp_matches(coalesce(b.text, ''), '\$([A-Z]{2,5})([^A-Za-z]|$)', 'g') as m
      union
      select upper(bs.symbol)
      from public.bookmark_symbols bs
      where bs.bookmark_id = b.id
        and bs.symbol ~ '^[A-Za-z]{2,5}$'
    ) sym
    where b.is_market_related
      and b.classified_at >= timestamptz '2026-09-13 00:00:00+00'
      and sym.symbol ~ '^[A-Z]{2,5}$'
  ),
  bookmark_clean as (
    select *
    from bookmark_raw r
    where not private.ontology_label_is_junk('membership', r.symbol)
  ),
  bookmark_counts as (
    select source_key, count(distinct symbol)::integer as n_sym
    from bookmark_clean
    group by source_key
  ),
  bookmark_themed as (
    select
      c.source_key,
      c.source_type,
      c.observed_at,
      c.score,
      c.excerpt,
      c.symbol,
      hit.theme_id
    from bookmark_clean c
    join bookmark_counts n on n.source_key = c.source_key
    left join lateral (
      select t.theme_id
      from public.ontology_terms t
      join public.ontology_themes th on th.id = t.theme_id and th.status = 'active'
      where n.n_sym <= 4
        and t.status = 'active'
        and char_length(t.normalized_term) >= 6
        and t.normalized_term ~ '^[a-z0-9][a-z0-9 .-]*$'
        and not private.ontology_label_is_junk('term', t.normalized_term)
        and lower(c.text) ~ (
          '(^|[^a-z0-9])'
          || replace(replace(replace(t.normalized_term, '.', '\.'), '-', '[^a-z0-9]'), ' ', '[^a-z0-9]+')
          || '([^a-z0-9]|$)'
        )
        and not exists (
          select 1
          from public.symbol_theme_memberships m
          where m.symbol = c.symbol
            and m.theme_id = t.theme_id
            and m.status = 'active'
        )
      order by char_length(t.normalized_term) desc, t.theme_id
      limit 2
    ) hit on true
  ),
  lesson_raw as (
    select
      l.id::text as source_key,
      'research_lesson'::text as source_type,
      l.created_at as observed_at,
      0::smallint as score,
      left(regexp_replace(coalesce(l.summary, ''), '\s+', ' ', 'g'), 180) as excerpt,
      upper(ts.symbol) as symbol,
      th.id as theme_id
    from public.research_lessons l
    join public.thesis_symbols ts on ts.thesis_id = l.thesis_id
    left join public.ontology_themes th
      on th.status = 'active'
     and (th.id = l.thesis_id or th.thesis_id = l.thesis_id)
    where l.created_at >= timestamptz '2026-09-13 00:00:00+00'
      and upper(ts.symbol) ~ '^[A-Z]{2,5}$'
      and coalesce(l.summary, '') ~ ('(^|[^A-Za-z])' || upper(ts.symbol) || '([^A-Za-z]|$)')
      and not private.ontology_label_is_junk('membership', upper(ts.symbol))
      and (
        th.id is null
        or not exists (
          select 1
          from public.symbol_theme_memberships m
          where m.symbol = upper(ts.symbol)
            and m.theme_id = th.id
            and m.status = 'active'
        )
      )
  ),
  incoming as (
    select
      'membership'::text as candidate_type,
      coalesce(theme_id, 'unscoped') || ':' || symbol as candidate_key,
      theme_id as proposed_theme_id,
      symbol as proposed_label,
      excerpt as description,
      score,
      source_type,
      source_key,
      observed_at
    from bookmark_themed
    where theme_id is not null
       or not exists (
         select 1
         from public.ontology_candidates oc
         where oc.candidate_type = 'membership'
           and upper(oc.proposed_label) = bookmark_themed.symbol
       )
    union all
    select
      'membership'::text,
      coalesce(theme_id, 'unscoped') || ':' || symbol,
      theme_id,
      symbol,
      excerpt,
      score,
      source_type,
      source_key,
      observed_at
    from lesson_raw
    where theme_id is not null
       or not exists (
         select 1
         from public.ontology_candidates oc
         where oc.candidate_type = 'membership'
           and upper(oc.proposed_label) = lesson_raw.symbol
       )
  ),
  dedup_evidence as (
    select distinct on (candidate_type, candidate_key, source_type, source_key)
      candidate_type, candidate_key, proposed_theme_id, proposed_label,
      description, score, source_type, source_key, observed_at
    from incoming
    order by candidate_type, candidate_key, source_type, source_key, score desc, observed_at desc
  ),
  candidate_rows as (
    select
      candidate_type,
      candidate_key,
      (array_agg(proposed_theme_id order by score desc, observed_at desc))[1] as proposed_theme_id,
      (array_agg(proposed_label order by score desc, observed_at desc))[1] as proposed_label,
      (array_agg(description order by score desc, observed_at desc))[1] as description,
      max(score)::smallint as score,
      min(observed_at) as first_seen,
      max(observed_at) as last_seen,
      (array_agg(source_type order by observed_at desc))[1] as source_type
    from dedup_evidence
    group by candidate_type, candidate_key
  ),
  upserted as (
    insert into public.ontology_candidates(
      candidate_type, candidate_key, proposed_theme_id, proposed_label,
      proposed_description, score, sample_context, first_seen_at, last_seen_at
    )
    select
      candidate_type,
      candidate_key,
      proposed_theme_id,
      proposed_label,
      coalesce(description, ''),
      score,
      jsonb_build_object(
        'source', source_type,
        'evidence_excerpt', coalesce(description, ''),
        'prompt_version', 'ledger-propose-v1'
      ),
      first_seen,
      last_seen
    from candidate_rows
    on conflict (candidate_type, candidate_key) do update set
      last_seen_at = greatest(public.ontology_candidates.last_seen_at, excluded.last_seen_at),
      sample_context = case
        when public.ontology_candidates.status = 'pending'
          and excluded.last_seen_at >= public.ontology_candidates.last_seen_at
          then excluded.sample_context
        else public.ontology_candidates.sample_context
      end
    returning id, candidate_type, candidate_key
  ),
  new_keys as (
    select c.candidate_type, c.candidate_key
    from candidate_rows c
    where not exists (
      select 1
      from public.ontology_candidates o
      where o.candidate_type = c.candidate_type
        and o.candidate_key = c.candidate_key
    )
  ),
  evidenced as (
    insert into public.ontology_candidate_evidence(
      candidate_id, source_type, source_key, evidence_score, context, observed_at
    )
    select
      u.id,
      d.source_type,
      d.source_key,
      d.score,
      jsonb_build_object(
        'evidence_excerpt', coalesce(d.description, ''),
        'prompt_version', 'ledger-propose-v1'
      ),
      d.observed_at
    from upserted u
    join dedup_evidence d using (candidate_type, candidate_key)
    on conflict (candidate_id, source_type, source_key) do update set
      evidence_score = greatest(public.ontology_candidate_evidence.evidence_score, excluded.evidence_score),
      context = excluded.context,
      observed_at = greatest(public.ontology_candidate_evidence.observed_at, excluded.observed_at)
    returning 1 as wrote
  )
  select
    (select count(*)::integer from new_keys),
    (select count(*)::integer from evidenced),
    (select coalesce(array_agg(id), '{}'::bigint[]) from upserted)
  into v_inserted, v_evidence, v_ids;

  -- A later statement sees the evidence just written. A sibling CTE would not.
  update public.ontology_candidates c set
    evidence_count = (
      select count(*) from public.ontology_candidate_evidence e where e.candidate_id = c.id
    ),
    source_count = (
      select count(distinct e.source_type || ':' || e.source_key)
      from public.ontology_candidate_evidence e
      where e.candidate_id = c.id
    ),
    score = greatest(
      c.score,
      coalesce((
        select max(e.evidence_score)
        from public.ontology_candidate_evidence e
        where e.candidate_id = c.id
      ), c.score)
    )
  where c.id = any(v_ids)
    and c.status = 'pending';
  get diagnostics v_recounted = row_count;

  -- The sweep's own gate is narrower than this trigger. A skipped sweep
  -- must not roll back the bookmark or lesson that fired it. New rows are
  -- already filtered by private.ontology_label_is_junk.
  begin
    v_rejected := private.reject_junk_ontology_candidates();
  exception
    when insufficient_privilege then
      v_rejected := jsonb_build_object('ok', false, 'rejected', 0, 'note', 'junk_sweep_skipped');
  end;

  return jsonb_build_object(
    'ok', true,
    'actor', v_actor,
    'inserted', v_inserted,
    'evidence', v_evidence,
    'recounted', v_recounted,
    'rejected', v_rejected,
    'last_first_seen_at', (select max(first_seen_at) from public.ontology_candidates),
    'created_7d', (
      select count(*)::integer
      from public.ontology_candidates
      where first_seen_at >= now() - interval '7 days'
    )
  );
end;
$fn$;

comment on function private.propose_ontology_candidates() is
  'Propose membership ontology_candidates from market bookmarks classified since 2026-09-13 and from research lessons that name a thesis symbol. Applies private.ontology_label_is_junk, then private.reject_junk_ontology_candidates. Does not change status on an existing candidate. Re-runnable.';

revoke all on function private.propose_ontology_candidates() from public, anon;
grant execute on function private.propose_ontology_candidates()
  to authenticated, service_role, quantanamo_worker, oddsborne_worker, bandit_worker;

create or replace function public.propose_ontology_candidates()
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.propose_ontology_candidates();
$$;

comment on function public.propose_ontology_candidates() is
  'Steward sweep: propose ontology candidates from classified market bookmarks and steward lessons since 2026-09-13, then reject junk. Re-runnable. Anon cannot call this.';

revoke all on function public.propose_ontology_candidates() from public, anon;
grant execute on function public.propose_ontology_candidates()
  to authenticated, service_role, quantanamo_worker, oddsborne_worker, bandit_worker;

grant usage on schema private to oddsborne_worker, bandit_worker;

create or replace function private.propose_ontology_candidates_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $trg$
begin
  perform private.propose_ontology_candidates();
  return null;
end;
$trg$;

comment on function private.propose_ontology_candidates_trigger() is
  'After a bookmark classification or a research lesson, propose ontology candidates. Statement-level so a batch is one pass.';

revoke all on function private.propose_ontology_candidates_trigger() from public, anon;
grant execute on function private.propose_ontology_candidates_trigger()
  to authenticated, service_role, quantanamo_worker, oddsborne_worker, bandit_worker;

drop trigger if exists bookmarks_propose_ontology on public.bookmarks;
create trigger bookmarks_propose_ontology
  after insert or update of text, is_market_related, classified_at, classification_output
  on public.bookmarks
  for each statement
  execute function private.propose_ontology_candidates_trigger();

drop trigger if exists bookmark_symbols_propose_ontology on public.bookmark_symbols;
create trigger bookmark_symbols_propose_ontology
  after insert or update of symbol
  on public.bookmark_symbols
  for each statement
  execute function private.propose_ontology_candidates_trigger();

drop trigger if exists research_lessons_propose_ontology on public.research_lessons;
create trigger research_lessons_propose_ontology
  after insert or update of summary, thesis_id
  on public.research_lessons
  for each statement
  execute function private.propose_ontology_candidates_trigger();

-- Backfill 2026-09-13 through today. Idempotent.
select private.propose_ontology_candidates();

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
      'last_first_seen_at', max(c.first_seen_at),
      'created_7d', count(*) filter (where c.first_seen_at >= now() - interval '7 days')::integer,
      'pending', count(*) filter (where c.status = 'pending')::integer,
      'starved', max(c.first_seen_at) is null
        or max(c.first_seen_at) < now() - interval '7 days'
    )
    from public.ontology_candidates c
  ) as ontology_freshness;

comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, unlinked_named_lessons, and ontology_freshness are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests at least 7 days old or past their window, by steward and thesis. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null. ontology_freshness is the learning loop for ontology candidates: last first_seen_at, how many candidates were first seen in 7 days, pending, and starved when that first-seen is missing or older than 7 days.';

comment on column public.v_ledger_watchdog.stale_queued_tests is
  'Queued strategy tests in public.v_stale_queued_tests. n is the count. quantanamo, oddsborne, bandit, and unknown are that count by steward (unknown when the thesis has no domain assignment). theses lists thesis_id, steward, and n. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.unlinked_named_lessons is
  'Open research lessons whose summary names a preregistered or queued strategy test and whose test_id is still null. The bind triggers and the backfill in this migration are what keep it at zero. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.ontology_freshness is
  'Ontology candidate freshness. last_first_seen_at is max(ontology_candidates.first_seen_at). created_7d counts candidates first seen in the last 7 days. pending is status = pending. starved is true when last_first_seen_at is null or older than 7 days. A pending count of 0 with starved true means the grind is empty because nothing is proposing candidates. It does not make /api/health not-ok.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;
