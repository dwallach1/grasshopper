-- The ontology proposer was reporting ok and writing nothing.
--
-- Since 2026-11-09 the lesson path dropped every earnings_events row before
-- incoming. Lessons after 2026-11-07 are on earnings_gap_structure, which is
-- that theme, so the evidence set was empty: evidence, refreshed, and
-- recounted stayed 0. Promoted keys were also excluded from the update, so a
-- matching note could not move evidence_count, source_count, or last_seen_at.
-- A rejected key came back only when the stored count would rise by 2 against
-- the rejection snapshot, and only if the row survived that earnings filter.
--
-- An existing key now refreshes from evidence that is not already stored,
-- including a promoted candidate and its active symbol_theme_membership.
-- A rejected key returns to pending only when at least 3 new evidence rows
-- from at least 2 sources are newer than reviewed_at. The junk deny list
-- still blocks that return. A research lesson still does not open a new
-- earnings_events key. The run detail counts skipped keys by reason.
-- ontology_freshness.learning_loop is true when no candidate was first seen
-- in 72 hours and a bookmark or lesson is newer than that. It does not make
-- /api/health not-ok.
--
-- This statement does not schedule cron and does not grant anything. Retired
-- seats (oddsborne_worker, bandit_worker) get nothing new.

create or replace function private.propose_ontology_candidates()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor text;
  v_inserted integer := 0;
  v_refreshed integer := 0;
  v_evidence integer := 0;
  v_recounted integer := 0;
  v_ids bigint[] := '{}';
  v_rejected jsonb;
  v_already_promoted integer := 0;
  v_rejected_quiet integer := 0;
  v_junk integer := 0;
  v_below integer := 0;
  v_resurrected integer := 0;
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

  with index_etf(symbol) as (
    values
      ('SPY'::text), ('QQQ'), ('IWM'), ('DIA'),
      ('SMH'), ('SOXX'), ('XLK'), ('XLF'), ('XLE'), ('XLV'),
      ('XLY'), ('XLP'), ('XLI'), ('XLB'), ('XLU'), ('XLRE'), ('XLC'),
      ('VTI'), ('VOO'), ('IVV'), ('QQQM'), ('MDY'), ('IWB'), ('RSP'),
      ('XBI'), ('XHB'), ('XRT'), ('XOP'), ('XME'), ('KRE'), ('IBB'), ('IYR'),
      ('TQQQ'), ('SQQQ'), ('SOXL'), ('SOXS'), ('SPXL'), ('UPRO')
  ),
  open_equity as (
    select distinct upper(pe.symbol) as symbol
    from public.position_episodes pe
    where pe.status = 'open'
      and upper(pe.symbol) ~ '^[A-Z]{1,5}$'
  ),
  bookmark_raw as (
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
      and not exists (select 1 from index_etf e where e.symbol = r.symbol)
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
        and (
          not exists (
            select 1
            from public.symbol_theme_memberships m
            where m.symbol = c.symbol
              and m.theme_id = t.theme_id
              and m.status = 'active'
          )
          or exists (
            select 1
            from public.ontology_candidates oc
            where oc.candidate_type = 'membership'
              and oc.candidate_key = t.theme_id || ':' || c.symbol
          )
        )
      order by char_length(t.normalized_term) desc, t.theme_id
      limit 2
    ) hit on true
  ),
  lesson_prose(symbol) as (
    values
      ('AH'::text), ('AM'), ('PM'), ('ET'), ('QD'), ('OOS'), ('CI'), ('RTH'),
      ('EPS'), ('FY'), ('GPU'), ('CPU'), ('GAAP'), ('FOMC'), ('FOMO'),
      ('REIT'), ('ADR'), ('ETF'), ('IPO'), ('CEO'), ('CFO'), ('COO'), ('CTO'),
      ('AI'), ('US'), ('UK'), ('IT'), ('OR'), ('AND'), ('THE'), ('FOR'),
      ('ALL'), ('NEW'), ('NOT'), ('NO'), ('DUMP'), ('RUNUP'), ('HOLD'),
      ('FAIL'), ('OPEN'), ('PAPER'), ('SCORE'), ('WATCH'), ('WELL'), ('HIGH'),
      ('EVERY'), ('LONG'), ('BASE'), ('FAST'), ('SKIP'), ('LOST'), ('NEXT'),
      ('DNA'), ('USD'), ('NYSE'), ('UTC'), ('ATH'), ('EOD'), ('YTD'),
      ('QOQ'), ('YOY'), ('EST'), ('EDT'), ('SEC'), ('FDA'), ('FED'),
      ('CPI'), ('GDP'), ('WSJ'), ('NNNN'), ('PT'), ('TP')
  ),
  lesson_symbols as (
    select
      l.id,
      l.thesis_id,
      l.created_at,
      l.summary,
      upper(sym.symbol) as symbol
    from public.research_lessons l
    cross join lateral (
      select x[1] as symbol
      from regexp_matches(
        coalesce(l.summary, ''),
        '(?:^|[^A-Za-z$])([A-Z]{2,5})(?::|\s+[-+]?\d+(?:\.\d+)?%|/)',
        'g'
      ) as x
      union
      select x[1]
      from regexp_matches(
        coalesce(l.summary, ''),
        '/([A-Z]{2,5})(?=/|[^A-Za-z]|$)',
        'g'
      ) as x
      union
      select x[1]
      from regexp_matches(
        coalesce(l.summary, ''),
        '(?:[(,]\s*)([A-Z]{2,5})(?=\s*[,)])',
        'g'
      ) as x
      union
      select upper(ts.symbol)
      from public.thesis_symbols ts
      where ts.thesis_id = l.thesis_id
        and coalesce(l.summary, '') ~ ('(^|[^A-Za-z])' || upper(ts.symbol) || '([^A-Za-z]|$)')
    ) sym
    where l.created_at >= timestamptz '2026-09-13 00:00:00+00'
      and upper(sym.symbol) ~ '^[A-Z]{2,5}$'
  ),
  lesson_clean as (
    select s.*
    from lesson_symbols s
    where not private.ontology_label_is_junk('membership', s.symbol)
      and not exists (select 1 from index_etf e where e.symbol = s.symbol)
      and (
        not exists (select 1 from lesson_prose p where p.symbol = s.symbol)
        or exists (
          select 1
          from public.thesis_symbols ts
          where ts.thesis_id = s.thesis_id
            and upper(ts.symbol) = s.symbol
        )
      )
  ),
  lesson_tagged as (
    select
      l.id,
      l.thesis_id,
      l.created_at,
      l.summary,
      l.symbol,
      n.n_sym,
      (
        l.summary ~* (
          '(reported|prints?|beats?|miss(?:ed)?|gaps?|reports?).{0,80}[^A-Za-z]'
          || l.symbol || '([^A-Za-z]|$)'
        )
        or l.summary ~* (
          '(^|[^A-Za-z])' || l.symbol
          || '[^A-Za-z].{0,80}(reported|prints?|beats?|miss(?:ed)?|gaps?|reports?)'
        )
      ) as earnings_subject,
      (
        l.summary ~* (
          '\m(hold|holding|held|chase|chasing)\M[^A-Za-z]{0,16}'
          || l.symbol || '([^A-Za-z]|$)'
        )
        or l.summary ~* (
          '(^|[^A-Za-z])' || l.symbol || '[^A-Za-z]{0,12}\m(hold|chase)\M'
        )
      ) as position_note,
      l.summary ~* ('(^|[^A-Za-z])' || l.symbol || ':') as colon_subject
    from lesson_clean l
    join (
      select id, count(distinct symbol)::integer as n_sym
      from lesson_clean
      group by id
    ) n on n.id = l.id
  ),
  lesson_raw as (
    select
      l.id::text as source_key,
      'research_lesson'::text as source_type,
      l.created_at as observed_at,
      0::smallint as score,
      left(regexp_replace(coalesce(l.summary, ''), '\s+', ' ', 'g'), 180) as excerpt,
      l.symbol,
      th.id as theme_id,
      l.earnings_subject,
      l.position_note,
      l.colon_subject,
      l.n_sym
    from lesson_tagged l
    left join public.ontology_themes th
      on th.status = 'active'
     and (th.id = l.thesis_id or th.thesis_id = l.thesis_id)
    where (
        th.id is null
        or not exists (
          select 1
          from public.symbol_theme_memberships m
          where m.symbol = l.symbol
            and m.theme_id = th.id
            and m.status = 'active'
        )
        or exists (
          select 1
          from public.ontology_candidates oc
          where oc.candidate_type = 'membership'
            and oc.candidate_key = th.id || ':' || l.symbol
        )
      )
      and not (
        exists (select 1 from open_equity h where h.symbol = l.symbol)
        and l.position_note
        and not l.earnings_subject
      )
      -- Earnings lessons stay in the evidence stream so an existing key can
      -- refresh. A new earnings_events key is still not inserted: a score-0
      -- lesson ticker is below the new-key gate.
  ),
  lesson_key_stats as (
    select
      coalesce(theme_id, 'unscoped') || ':' || symbol as candidate_key,
      count(distinct source_key)::integer as n_src,
      max(observed_at) as last_at
    from lesson_raw
    group by 1
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
       or exists (
         select 1
         from public.ontology_candidates oc
         where oc.candidate_type = 'membership'
           and oc.candidate_key = 'unscoped:' || bookmark_themed.symbol
       )
       or not exists (
         select 1
         from public.ontology_candidates oc
         where oc.candidate_type = 'membership'
           and upper(oc.proposed_label) = bookmark_themed.symbol
       )
    union all
    select
      'membership'::text,
      coalesce(r.theme_id, 'unscoped') || ':' || r.symbol,
      r.theme_id,
      r.symbol,
      r.excerpt,
      r.score,
      r.source_type,
      r.source_key,
      r.observed_at
    from lesson_raw r
    join lesson_key_stats s
      on s.candidate_key = coalesce(r.theme_id, 'unscoped') || ':' || r.symbol
    where (
        exists (
          select 1
          from public.ontology_candidates oc
          where oc.candidate_type = 'membership'
            and oc.candidate_key = s.candidate_key
        )
        or (
          r.theme_id is distinct from 'earnings_events'
          and not exists (
            select 1
            from public.ontology_candidates oc
            where oc.candidate_type = 'membership'
              and oc.candidate_key = s.candidate_key
          )
          and (s.n_src >= 2 or s.last_at >= now() - interval '14 days')
          and (
            r.theme_id is not null
            or not exists (
              select 1
              from public.ontology_candidates oc
              where oc.candidate_type = 'membership'
                and upper(oc.proposed_label) = r.symbol
            )
          )
        )
      )
  ),
  admitted as (
    select i.*
    from incoming i
  ),
  revive_keys as (
    select oc.id, oc.candidate_type, oc.candidate_key
    from public.ontology_candidates oc
    join admitted i
      on i.candidate_type = oc.candidate_type
     and i.candidate_key = oc.candidate_key
    where oc.status = 'rejected'
      and not private.ontology_label_is_junk(oc.candidate_type, oc.proposed_label)
      and i.observed_at > coalesce(oc.reviewed_at, oc.first_seen_at)
      and not exists (
        select 1
        from public.ontology_candidate_evidence e
        where e.candidate_id = oc.id
          and e.source_type = i.source_type
          and e.source_key = i.source_key
      )
    group by oc.id, oc.candidate_type, oc.candidate_key
    having count(distinct i.source_type || ':' || i.source_key) >= 3
       and count(distinct i.source_key) >= 2
  ),
  dedup_evidence as (
    select distinct on (candidate_type, candidate_key, source_type, source_key)
      candidate_type, candidate_key, proposed_theme_id, proposed_label,
      description, score, source_type, source_key, observed_at
    from admitted
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
  writable as (
    select c.*
    from candidate_rows c
    left join public.ontology_candidates oc
      on oc.candidate_type = c.candidate_type
     and oc.candidate_key = c.candidate_key
    where oc.id is null
       or oc.last_seen_at < c.last_seen
       or exists (
         select 1
         from revive_keys rk
         where rk.candidate_type = c.candidate_type
           and rk.candidate_key = c.candidate_key
       )
       or exists (
         select 1
         from dedup_evidence d
         where d.candidate_type = c.candidate_type
           and d.candidate_key = c.candidate_key
           and oc.id is not null
           and not exists (
             select 1
             from public.ontology_candidate_evidence e
             where e.candidate_id = oc.id
               and e.source_type = d.source_type
               and e.source_key = d.source_key
           )
       )
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
    from writable
    on conflict (candidate_type, candidate_key) do update set
      last_seen_at = greatest(public.ontology_candidates.last_seen_at, excluded.last_seen_at),
      status = case
        when public.ontology_candidates.status = 'rejected'
          and exists (
            select 1 from revive_keys rk
            where rk.candidate_type = public.ontology_candidates.candidate_type
              and rk.candidate_key = public.ontology_candidates.candidate_key
          )
          then 'pending'
        else public.ontology_candidates.status
      end,
      reviewed_at = case
        when public.ontology_candidates.status = 'rejected'
          and exists (
            select 1 from revive_keys rk
            where rk.candidate_type = public.ontology_candidates.candidate_type
              and rk.candidate_key = public.ontology_candidates.candidate_key
          )
          then null
        else public.ontology_candidates.reviewed_at
      end,
      review_note = case
        when public.ontology_candidates.status = 'rejected'
          and exists (
            select 1 from revive_keys rk
            where rk.candidate_type = public.ontology_candidates.candidate_type
              and rk.candidate_key = public.ontology_candidates.candidate_key
          )
          then null
        else public.ontology_candidates.review_note
      end,
      sample_context = case
        when public.ontology_candidates.status = 'rejected'
          and exists (
            select 1 from revive_keys rk
            where rk.candidate_type = public.ontology_candidates.candidate_type
              and rk.candidate_key = public.ontology_candidates.candidate_key
          )
          then excluded.sample_context
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
    where public.ontology_candidate_evidence.observed_at is distinct from excluded.observed_at
       or public.ontology_candidate_evidence.evidence_score is distinct from excluded.evidence_score
       or public.ontology_candidate_evidence.context is distinct from excluded.context
    returning 1 as wrote
  )
  select
    (select count(*)::integer from new_keys),
    (select count(*)::integer from evidenced),
    (select coalesce(array_agg(id), '{}'::bigint[]) from upserted),
    greatest(
      0,
      (select count(*)::integer from upserted) - (select count(*)::integer from new_keys)
    ),
    (select count(distinct a.candidate_key)::integer
     from admitted a
     join public.ontology_candidates oc
       on oc.candidate_type = a.candidate_type
      and oc.candidate_key = a.candidate_key
     where oc.status = 'promoted'),
    (select count(distinct a.candidate_key)::integer
     from admitted a
     join public.ontology_candidates oc
       on oc.candidate_type = a.candidate_type
      and oc.candidate_key = a.candidate_key
     where oc.status = 'rejected'
       and not exists (select 1 from revive_keys rk where rk.id = oc.id)),
    (select count(distinct j.symbol)::integer
     from (
       select r.symbol
       from bookmark_raw r
       where private.ontology_label_is_junk('membership', r.symbol)
       union
       select s.symbol
       from lesson_symbols s
       where private.ontology_label_is_junk('membership', s.symbol)
     ) j),
    (select count(distinct k.candidate_key)::integer
     from (
       select coalesce(r.theme_id, 'unscoped') || ':' || r.symbol as candidate_key
       from lesson_raw r
       union
       select 'unscoped:' || c.symbol
       from bookmark_clean c
       where not exists (
         select 1
         from bookmark_themed bt
         where bt.source_key = c.source_key
           and bt.symbol = c.symbol
           and bt.theme_id is not null
       )
     ) k
     where not exists (
       select 1
       from public.ontology_candidates oc
       where oc.candidate_type = 'membership'
         and oc.candidate_key = k.candidate_key
     )
     and not exists (
       select 1
       from admitted a
       where a.candidate_type = 'membership'
         and a.candidate_key = k.candidate_key
     )),
    (select count(*)::integer from revive_keys)
  into v_inserted, v_evidence, v_ids, v_refreshed,
       v_already_promoted, v_rejected_quiet, v_junk, v_below, v_resurrected;

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
    ),
    last_seen_at = greatest(
      c.last_seen_at,
      coalesce((
        select max(e.observed_at)
        from public.ontology_candidate_evidence e
        where e.candidate_id = c.id
      ), c.last_seen_at)
    )
  where c.id = any(v_ids);
  get diagnostics v_recounted = row_count;

  update public.symbol_theme_memberships m
  set
    evidence_count = c.evidence_count,
    source_count = c.source_count,
    last_seen_at = greatest(m.last_seen_at, c.last_seen_at)
  from public.ontology_candidates c
  where c.id = any(v_ids)
    and c.status = 'promoted'
    and c.candidate_type = 'membership'
    and c.proposed_theme_id is not null
    and m.theme_id = c.proposed_theme_id
    and m.symbol = upper(c.proposed_label)
    and m.status = 'active';

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
    'refreshed', v_refreshed,
    'evidence', v_evidence,
    'recounted', v_recounted,
    'pending', (
      select count(*)::integer
      from public.ontology_candidates
      where status = 'pending'
    ),
    'rejected', v_rejected,
    'last_first_seen_at', (select max(first_seen_at) from public.ontology_candidates),
    'created_7d', (
      select count(*)::integer
      from public.ontology_candidates
      where first_seen_at >= now() - interval '7 days'
    ),
    'resurrected', v_resurrected,
    'new_keys', v_inserted,
    'skipped_reasons', jsonb_build_object(
      'already_promoted', v_already_promoted,
      'rejected_no_new_evidence', v_rejected_quiet,
      'junk', v_junk,
      'below_threshold', v_below
    ),
    'note', case
      when v_inserted = 0 then 'new evidence carried no new keys'
      else 'new keys proposed'
    end
  );
end;
$fn$;

comment on function private.propose_ontology_candidates() is
  'Propose membership ontology_candidates from market bookmarks classified since 2026-09-13 and from research lessons. A new earnings_events key is not opened from a research lesson. An existing key, including a promoted one, gets evidence_count, source_count, and last_seen_at refreshed when new evidence matches, and an active symbol_theme_membership for that promoted key is refreshed the same way. A rejected key returns to pending only when at least 3 new evidence rows from at least 2 sources arrived after reviewed_at, and the junk deny list still blocks that return. skipped_reasons counts already_promoted, rejected_no_new_evidence, junk, and below_threshold. Applies private.ontology_label_is_junk, then private.reject_junk_ontology_candidates.';

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
  public.earnings_sheet_staleness(now()) as earnings_sheet_stale
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
           -- A null lineage_role is read as a violation on purpose. An
           -- unclassified repeat still counts, so a real break is not dropped.
           -- rule_cost is explicit: the rule was obeyed and the pass left a
           -- qualified winner behind. It is not a violation.
           coalesce(
             case
               when l.lineage_role in ('violation', 'confirmation', 'refinement', 'rule_cost') then l.lineage_role
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
              when (
                select r.role
                from repeat_roles r
                where r.root_id = k.root_id
                  and (fx.shipped_at is null or r.created_at > fx.shipped_at)
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
    ), '[]'::jsonb) as lesson_came_back
) lineage on true;


comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. breaches_escalated and escalated are actionable breaches past the next check or the 15-minute window. learning_gaps, unscoreable_decisions, equity_implied_move_gaps, stale_queued_tests, learning_stalls, unlinked_named_lessons, ontology_freshness, and research_id_sequences are not trading breaches and do not make /api/health not-ok. Escalation does not make /api/health not-ok either: it is the sell-now line. stale_queued_tests counts queued strategy tests that have waited at least five NYSE sessions, by steward and thesis. learning_stalls is that list in plain sentences, with retired stewards left out, and grasshopper_touch_heartbeat returns it beside escalated. unlinked_named_lessons counts open lessons whose summary names a preregistered test and whose test_id is still null. ontology_freshness is the proposer run: last_run_at, evidence_through, considered, proposed, skipped, and lagging only when that run is missing, older than eight hours, or newer notes arrived after evidence_through. A run that proposed nothing is not lagging. learning_loop is true when last_first_seen_at is null or older than 72 hours and a bookmark or lesson is newer than that first-seen. It is the learning-loop flag for a starved ontology grind. It does not make /api/health not-ok. research_id_sequences is max(id), identity last_value, is_called, and lagging for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). It does not call setval. rules_not_taking lists an incorporated lesson that later lessons cite again, directly or through the ones in between, when that chain is at least 3 lessons long. A lesson already inside a longer chain is not listed on its own. lesson_ids run oldest first. summary is the newest lesson in the chain. came_back is how many lessons followed the first. violations is how many later lessons have role violation. A null lineage_role on a repeat is read as a violation on purpose, so an unclassified repeat still counts. rule_cost means the rule was obeyed and the pass left a qualified winner behind. It is not a violation. rule_costs counts those lessons. cost_summaries are their texts. fix_ref and shipped_at are the newest research_lesson_fixes row whose lesson is in the chain. came_back still counts every later lesson. status is costing when every lesson after the latest incorporated lesson in the chain, and after a shipped fix when there is one, is rule_cost. status is not_taking when a later lesson broke the rule and no later lesson says it held, holding when the later lessons say the rule held, and refining when they only narrow it. fix_shipped_watching stays when a fix is recorded and no lesson citing the chain was created after shipped_at. fix_failed is a later lesson that broke the rule after shipped_at. failed_lesson_id is that lesson. A confirmation after the fix does not fail it. A rule_cost after the fix does not fail it. Only not_taking and fix_failed are the alarm. costing is a review, not the alarm. lesson_came_back is that count for every lesson cited at least once, including a single repeat. rules_not_taking and lesson_came_back do not make /api/health not-ok. earnings_sheet_stale is stale, last_sheet_at, sessions_missed, and latest_entry_session. stale is true when no research_queue row with source earnings_sheet covers the latest NYSE entry session. A row written before that session close is for that session. A row written after the close, or on a day that is not a session, is for the next session. sessions_missed counts NYSE sessions after the last covered entry session through the latest one, and is null when no sheet has covered a session up to that day. Holidays in us_equity_market_calendar are not sessions. It does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.research_id_sequences is
  'Identity sequence versus max(id) for research_cycles and research_lessons. lagging is true when last_value is behind max(id), or the sequence has not been called and last_value is not past max(id). An empty table is not lagging. It does not call setval and it does not make /api/health not-ok.';


comment on column public.v_ledger_watchdog.rules_not_taking is
  'Incorporated lessons re-taught at least twice (chain length at least 3), oldest lesson in the chain first. Each item has lesson_ids, thesis_id, the newest summary, came_back, violations, rule_costs, cost_summaries, fix_ref, shipped_at, status, and failed_lesson_id. violations counts later lessons whose role is violation. A null lineage_role on a repeat is read as a violation on purpose, so an unclassified repeat still counts. rule_cost means the rule was obeyed and the pass left a qualified winner behind. It is not a violation. rule_costs counts those lessons. cost_summaries are their texts. came_back still counts every later lesson. status is costing when every lesson after the latest incorporated lesson in the chain, and after a shipped fix when there is one, is rule_cost. status is not_taking when a later lesson broke the rule and no later lesson says it held, holding when the later lessons say the rule held, and refining when they only narrow it. fix_shipped_watching stays when a fix is recorded and no lesson citing the chain was created after shipped_at. fix_failed is a later lesson that broke the rule after shipped_at. failed_lesson_id is that lesson. A confirmation after the fix does not fail it. A rule_cost after the fix does not fail it. Only not_taking and fix_failed are the alarm. costing is a review, not the alarm. A lesson already inside a longer chain is left out. Does not make /api/health not-ok.';

comment on column public.v_ledger_watchdog.lesson_came_back is
  'How many later lessons cite this lesson, directly or through the ones in between. One repeat is included. Absent from rules_not_taking until the chain reaches 3. Does not make /api/health not-ok.';


comment on column public.v_ledger_watchdog.earnings_sheet_stale is
  'stale, last_sheet_at, sessions_missed, and latest_entry_session for source earnings_sheet. stale is true when no row covers the latest NYSE entry session. sessions_missed counts sessions after the last covered entry session through that day, and is null when no sheet has covered a session up to that day. Does not make /api/health not-ok.';


grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, desk_public_reader, service_role;
