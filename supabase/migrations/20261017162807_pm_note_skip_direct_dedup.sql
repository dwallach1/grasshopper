-- 78: pm_notes scoring must not double-count a skip ODDSBORNE already logged directly, and a comps
-- row may be the NO side.
--
-- 1. Double count. decision_candidate_capture inserts one decision_candidates row per market a
--    skip note prices (source_table 'pm_notes'). session_passlog.py and weather_pass_log.py log
--    the same skip through steward_log_decision (source_table 'direct'). Direct logging is the
--    source of truth: a note-derived skip is not inserted when a direct row already has the same
--    steward, instrument, and side and was decided within 24 hours of the note's created_at.
--    steward_log_decision is left unchanged. A direct row written after the note can still leave
--    the note-derived row in place; the one-off below removes the duplicates that exist at apply
--    time.
-- 2. NO side. session_daily.py and session_pm.py store the side on comps.outcome ('yes' or 'no').
--    bid and fair are already that side's price and probability (a NO maker is 1 - the YES ask).
--    The parser used to force side 'yes'. It now reads side, then outcome, then token, lowercased
--    and trimmed, and defaults to 'yes' only when the element has none of those fields. Both sides
--    of one market survive (distinct on instrument, side). Comps prices are not inverted; the row
--    is tagged meta.price_terms = 'side' so the resolver converts a NO to YES terms at score time.
--    The body-line "SKIP YES|NO" parser still returns YES terms (price_terms 'yes'), as before.
--
-- Cleanup. public.decision_marks.decision_id references decision_candidates(id) on delete cascade,
-- so deleting a marked row would also delete its marks. There is no separate outcome table:
-- settlement lives on the candidate (resolved_outcome, counterfactual_pnl, brier). A duplicate
-- note-derived skip with no mark and no outcome is deleted. One that has either is kept and
-- flagged meta.superseded = 'true', which public.decision_is_scoreable already excludes.

create or replace function private.pm_note_skip_covered_by_direct(
  p_steward text,
  p_instrument text,
  p_side text,
  p_at timestamptz
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select p_steward is not null
    and p_instrument is not null
    and p_side is not null
    and p_at is not null
    and exists (
      select 1
      from public.decision_candidates direct
      where direct.source_table = 'direct'
        and direct.steward = p_steward
        and direct.instrument = p_instrument
        and direct.side = p_side
        and direct.decided_at >= p_at - interval '24 hours'
        and direct.decided_at <= p_at + interval '24 hours'
    );
$$;

comment on function private.pm_note_skip_covered_by_direct(text, text, text, timestamptz) is
  'True when a direct decision_candidates row already names this steward, instrument, and side within 24 hours of p_at. Direct logging is the source of truth for a note-derived skip.';

revoke all on function private.pm_note_skip_covered_by_direct(text, text, text, timestamptz) from public, anon, authenticated;

-- Return type gains price_terms ('yes' or 'side'). create or replace cannot change OUT columns.
drop function if exists private.pm_note_scoreable_decisions(public.pm_notes);

create or replace function private.pm_note_scoreable_decisions(p_note public.pm_notes)
returns table (
  decision text,
  instrument text,
  side text,
  book_price numeric,
  my_probability numeric,
  reason text,
  price_terms text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_price numeric;
  v_prob numeric;
  v_slug text;
  v_side text;
begin
  v_price := private.try_numeric(p_note.book_probability::text);
  v_prob := private.try_numeric(p_note.my_probability::text);
  if p_note.market_id is not null
     and p_note.decision in ('enter', 'skip')
     and v_price > 0 and v_price <= 1
     and v_prob >= 0 and v_prob <= 1 then
    select m.slug into v_slug from public.pm_markets m where m.id = p_note.market_id;
    v_side := case when v_prob >= v_price then 'yes' else 'no' end;
    decision := p_note.decision;
    instrument := coalesce(v_slug, p_note.market_id::text);
    side := v_side;
    book_price := v_price;
    my_probability := v_prob;
    reason := left(coalesce(p_note.title, p_note.body), 280);
    price_terms := 'yes';
    return next;
    return;
  end if;

  return query
  with raw as (
    select 'skip'::text as decision,
           m[1] as instrument,
           'yes'::text as side,
           private.try_numeric(m[3]) as book_price,
           private.try_numeric(m[2]) as my_probability,
           left(line, 280) as reason,
           'yes'::text as price_terms
    from regexp_split_to_table(coalesce(p_note.body, ''), E'\n') as line
    cross join lateral regexp_match(line, '^\s*-\s+([a-z0-9][a-z0-9-]{8,}):\s+.*fair=([0-9]*\.?[0-9]+).*BBO=([0-9]*\.?[0-9]+)/', 'i') as m
    where p_note.decision = 'skip'
    union all
    -- comps / comps_top. session_daily.py and session_pm.py put the side on outcome.
    -- bid and fair are already that side's; do not invert. price_terms 'side'.
    select 'skip'::text,
           coalesce(elem->>'market_slug', elem->>'market'),
           coalesce(
             nullif(lower(btrim(elem->>'side')), ''),
             nullif(lower(btrim(elem->>'outcome')), ''),
             nullif(lower(btrim(elem->>'token')), ''),
             'yes'
           ),
           private.try_numeric(elem->>'bid'),
           private.try_numeric(elem->>'fair'),
           left(coalesce(elem->>'why', p_note.title), 280),
           'side'::text
    from jsonb_array_elements(
      case when jsonb_typeof(p_note.meta->'comps') = 'array' then p_note.meta->'comps' else '[]'::jsonb end
      || case when jsonb_typeof(p_note.meta->'comps_top') = 'array' then p_note.meta->'comps_top' else '[]'::jsonb end
    ) as elem
    where lower(coalesce(elem->>'decision', '')) = 'skip'
    union all
    select 'skip'::text,
           elem->>'slug',
           'yes'::text,
           private.try_numeric(elem->>'bid'),
           private.try_numeric(elem->>'fair'),
           left(coalesce(p_note.title, ''), 280),
           'yes'::text
    from jsonb_array_elements(
      case when jsonb_typeof(p_note.meta->'candidates') = 'array' then p_note.meta->'candidates' else '[]'::jsonb end
    ) as elem
    where p_note.decision = 'skip'
    union all
    select 'enter'::text,
           p_note.meta->>'slug',
           'yes'::text,
           private.try_numeric(p_note.meta->>'price'),
           private.try_numeric((regexp_match(coalesce(p_note.body, ''), 'fair[[:space:]]+([0-9]*\.?[0-9]+)', 'i'))[1]),
           left(coalesce(p_note.title, ''), 280),
           'yes'::text
    where p_note.decision = 'enter'
      and p_note.meta ? 'slug'
      and p_note.meta ? 'price'
      and (p_note.title ~* '\mYES\M' or left(coalesce(p_note.body, ''), 120) ~* '\mYES\M')
    union all
    -- "SKIP <team> YES|NO <slug> maker X ... fair Y": X and Y are that side's maker price and fair.
    -- Stop at the next SKIP, and return a NO side in YES terms (1 - X, 1 - Y).
    select 'skip'::text,
           m[2],
           lower(m[1]),
           case when lower(m[1]) = 'no' then 1 - private.try_numeric(m[3]) else private.try_numeric(m[3]) end,
           case when lower(m[1]) = 'no' then 1 - private.try_numeric(m[4]) else private.try_numeric(m[4]) end,
           left(coalesce(p_note.title, ''), 280),
           'yes'::text
    from regexp_match(
      coalesce(p_note.body, ''),
      'SKIP[[:space:]]+(?:[^\nS]|S(?!KIP))*[[:space:]](YES|NO)[[:space:]]+([a-z0-9][a-z0-9-]{8,})[[:space:]]+maker[[:space:]]+([0-9]*\.?[0-9]+)(?:[^\nS]|S(?!KIP))*?fair[[:space:]]+([0-9]*\.?[0-9]+)',
      'i'
    ) as m
    where p_note.decision = 'skip'
  )
  select distinct on (r.instrument, r.side)
    r.decision, r.instrument, r.side, r.book_price, r.my_probability, r.reason, r.price_terms
  from raw r
  where nullif(btrim(coalesce(r.instrument, '')), '') is not null
    and r.side in ('yes', 'no')
    and r.book_price > 0 and r.book_price <= 1
    and r.my_probability >= 0 and r.my_probability <= 1
  order by r.instrument, r.side, r.book_price;
end;
$$;

comment on function private.pm_note_scoreable_decisions(public.pm_notes) is
  'Per-market decisions a pm_note can be scored on. Comps and comps_top rows are in the named side''s terms (price_terms side; side, else outcome, else token, else yes). Every other row is in YES terms (price_terms yes).';

revoke all on function private.pm_note_scoreable_decisions(public.pm_notes) from public, anon, authenticated;

create or replace function private.decision_candidate_from_pm_note()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  n integer;
begin
  begin
    if new.decision not in ('enter', 'skip') or new.note_type = 'kill' then
      return null;
    end if;
    insert into public.decision_candidates (
      steward, venue, decided_at, decision, market_id, instrument, thesis_id, side,
      my_probability, book_price, edge, reason, source_table, source_id, meta
    )
    select 'oddsborne', 'prediction', new.created_at, d.decision, m.id, d.instrument,
      nullif(btrim(coalesce(new.thesis_id, '')), ''), d.side,
      d.my_probability, d.book_price, d.my_probability - d.book_price,
      coalesce(d.reason, left(coalesce(new.title, new.body), 280)),
      'pm_notes', new.id::text || ':' || d.instrument || ':' || d.side,
      jsonb_build_object(
        'origin', 'trigger',
        'note_type', new.note_type,
        'note_id', new.id,
        'price_terms', d.price_terms,
        'horizon', 'market resolution',
        'resolve_status', case when m.id is null then 'no_market' else 'awaiting_resolution' end
      )
    from (
      select scored.*
      from private.pm_note_scoreable_decisions(new) scored
      where not (
        scored.decision = 'skip'
        and private.pm_note_skip_covered_by_direct('oddsborne', scored.instrument, scored.side, new.created_at)
      )
    ) d
    left join lateral (
      select private.ensure_pm_market(d.instrument, null, null, 'pm_notes trigger') as id
    ) m on true
    on conflict (source_table, source_id) do nothing;
    get diagnostics n = row_count;

    if n = 0
      -- 62: a rollup note naming no market is not a decision; skip it.
      and (new.market_id is not null
           or nullif(btrim(coalesce(new.meta->>'market_id', new.meta->>'market_slug',
                                    new.meta->>'slug', new.meta->>'instrument', '')), '') is not null)
      and not exists (
        select 1 from public.decision_candidates ch
        where ch.source_table = 'pm_notes'
          and (ch.source_id = new.id::text or ch.source_id like new.id::text || ':%')
      )
      -- 78: a skip withheld because a direct row already logged it is not an unscoreable note.
      and not exists (
        select 1
        from private.pm_note_scoreable_decisions(new) held
        where held.decision = 'skip'
          and private.pm_note_skip_covered_by_direct('oddsborne', held.instrument, held.side, new.created_at)
      ) then
      insert into public.decision_candidates (
        steward, venue, decided_at, decision, side, reason, source_table, source_id, meta
      ) values (
        'oddsborne', 'prediction', new.created_at, new.decision, null,
        left(coalesce(new.title, new.body), 280),
        'pm_notes', new.id::text,
        jsonb_build_object(
          'origin', 'trigger',
          'note_type', new.note_type,
          'unscoreable', 'true',
          'unscoreable_reason', 'note has no market with a price and a probability'
        )
      )
      on conflict (source_table, source_id) do nothing;
    elsif n > 0 then
      perform private.resolve_decision_candidates(null);
    end if;
  exception when others then
    raise warning 'decision_candidate_from_pm_note: %', sqlerrm;
  end;
  return null;
end;
$function$;

-- One-off. Note-derived skips that duplicate a direct row (same steward, instrument, side,
-- decided within 24h). Delete only when nothing references the row and it has not been scored.
-- Otherwise set meta.superseded, the flag decision_is_scoreable already treats as excluded.
do $$
declare
  v_deleted integer := 0;
  v_superseded integer := 0;
begin
  delete from public.decision_candidates n
  where n.source_table = 'pm_notes'
    and n.decision = 'skip'
    and coalesce(n.meta->>'superseded', '') <> 'true'
    and private.pm_note_skip_covered_by_direct(n.steward, n.instrument, n.side, n.decided_at)
    and n.resolved_outcome is null
    and n.counterfactual_pnl is null
    and n.brier is null
    and not exists (
      select 1 from public.decision_marks m where m.decision_id = n.id
    );
  get diagnostics v_deleted = row_count;

  update public.decision_candidates n
  set meta = n.meta || jsonb_build_object(
        'superseded', 'true',
        'superseded_why', 'note-derived skip duplicates a direct row within 24h; kept because a mark or outcome references it'
      ),
      updated_at = pg_catalog.now()
  where n.source_table = 'pm_notes'
    and n.decision = 'skip'
    and coalesce(n.meta->>'superseded', '') <> 'true'
    and private.pm_note_skip_covered_by_direct(n.steward, n.instrument, n.side, n.decided_at)
    and (
      n.resolved_outcome is not null
      or n.counterfactual_pnl is not null
      or n.brier is not null
      or exists (select 1 from public.decision_marks m where m.decision_id = n.id)
    );
  get diagnostics v_superseded = row_count;

  raise notice '78 pm_note skip dedup: deleted %, superseded %', v_deleted, v_superseded;
end;
$$;
