-- Quiet the lesson-ticker path added in 20261030180000. That run inserted
-- 102 score-0 earnings_events rows because one recent lesson mention was
-- enough. The grind then rejected the excerpt-only names, and the next
-- lesson could put the same key back on the queue.
--
-- Lesson-sourced earnings_events still need ticker context (colon, signed
-- percent, slash list, or a parenthetical list). A new key needs two
-- distinct lessons that name the ticker as an earnings subject: reported,
-- print, beat, miss, gap, or report inside 80 characters, and not a
-- hold/chase note. One recent themed mention still qualifies when the
-- ticker is the lesson subject (a colon name, or one of at most four
-- tickers) inside the last 14 days. A listicle co-mention does not.
-- Index and sector ETFs (QQQ, SPY, SMH, IWM, XLK, and the rest of that
-- list) are not membership candidates. A ticker already held in an open
-- position_episode is skipped when the lesson only mentions it as a
-- hold/chase note.
-- A rejected key is not touched, and is not set back to pending, unless
-- evidence_count would rise by at least 2 from the count stored on the
-- latest reject action. Promoted rows are not updated. Freshness on
-- v_ledger_watchdog and the pg_cron job propose_ontology_candidates stay
-- as they were. This statement does not call the proposer.

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
      and (
        th.id is distinct from 'earnings_events'
        or (l.earnings_subject and not l.position_note)
      )
  ),
  lesson_key_stats as (
    select
      coalesce(theme_id, 'unscoped') || ':' || symbol as candidate_key,
      count(distinct source_key)::integer as n_src,
      max(observed_at) as last_at,
      count(distinct source_key) filter (
        where theme_id = 'earnings_events'
          and earnings_subject
          and not position_note
      )::integer as n_earn,
      bool_or(
        theme_id = 'earnings_events'
        and earnings_subject
        and not position_note
        and observed_at >= now() - interval '14 days'
        and (colon_subject or n_sym <= 4)
      ) as recent_themed
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
        r.theme_id = 'earnings_events'
        and (s.n_earn >= 2 or s.recent_themed)
        and not exists (
          select 1
          from public.ontology_candidates oc
          where oc.candidate_type = 'membership'
            and oc.candidate_key = s.candidate_key
            and oc.status = 'promoted'
        )
      )
      or (
        r.theme_id is distinct from 'earnings_events'
        and (
          exists (
            select 1
            from public.ontology_candidates oc
            where oc.candidate_type = 'membership'
              and oc.candidate_key = s.candidate_key
              and oc.status <> 'promoted'
          )
          or (
            not exists (
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
      )
  ),
  admitted as (
    select i.*
    from incoming i
    left join public.ontology_candidates oc
      on oc.candidate_type = i.candidate_type
     and oc.candidate_key = i.candidate_key
    where oc.status is distinct from 'promoted'
      and (
        oc.status is distinct from 'rejected'
        or (
          (
            select count(distinct i2.source_type || ':' || i2.source_key)::bigint
            from incoming i2
            where i2.candidate_type = i.candidate_type
              and i2.candidate_key = i.candidate_key
              and not exists (
                select 1
                from public.ontology_candidate_evidence e
                where e.candidate_id = oc.id
                  and e.source_type = i2.source_type
                  and e.source_key = i2.source_key
              )
          ) + coalesce(oc.evidence_count, 0) >= coalesce((
            select nullif(a.next_state->>'evidence_count', '')::bigint
            from public.ontology_management_actions a
            where a.entity_type = 'candidate'
              and a.entity_key = oc.candidate_key
              and a.action = 'reject'
            order by a.created_at desc
            limit 1
          ), oc.evidence_count, 0) + 2
        )
      )
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
      status = case
        when public.ontology_candidates.status = 'rejected' then 'pending'
        else public.ontology_candidates.status
      end,
      reviewed_at = case
        when public.ontology_candidates.status = 'rejected' then null
        else public.ontology_candidates.reviewed_at
      end,
      review_note = case
        when public.ontology_candidates.status = 'rejected' then null
        else public.ontology_candidates.review_note
      end,
      sample_context = case
        when public.ontology_candidates.status = 'rejected'
          then excluded.sample_context
        when public.ontology_candidates.status = 'pending'
          and excluded.last_seen_at >= public.ontology_candidates.last_seen_at
          then excluded.sample_context
        else public.ontology_candidates.sample_context
      end
    where public.ontology_candidates.status in ('pending', 'rejected')
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
    (select coalesce(array_agg(id), '{}'::bigint[]) from upserted),
    greatest(
      0,
      (select count(*)::integer from upserted) - (select count(*)::integer from new_keys)
    )
  into v_inserted, v_evidence, v_ids, v_refreshed;

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
  where c.id = any(v_ids);
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
    )
  );
end;
$fn$;

comment on function private.propose_ontology_candidates() is
  'Propose membership ontology_candidates from market bookmarks classified since 2026-09-13 and from research lessons. An earnings_events lesson key needs two lessons that name the ticker as an earnings subject (reported, print, beat, miss, gap, or report nearby, not a hold or chase note), or one recent lesson where that ticker is the subject. Skips index and sector ETFs and open positions mentioned only as hold or chase notes. Refreshes a pending key. Sets a rejected key back to pending only when evidence_count would rise by at least 2 since its rejection. Does not update a promoted row. Applies private.ontology_label_is_junk, then private.reject_junk_ontology_candidates.';
