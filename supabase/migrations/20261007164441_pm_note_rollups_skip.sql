-- 62: ODDSBORNE pm_notes rollups ("Morning skips AM ...", "... scan ...") name no single market, yet the
-- pm_notes trigger turned each into an unscoreable decision_candidates row. The trigger now writes the
-- unscoreable placeholder only when the note names a market (market_id, or meta market_id/slug/instrument);
-- rollups are skipped. Real passes still arrive via steward_log_decision. The 10 existing rollup rows are
-- superseded (same pattern as 60); 9371dc04 (has a market, no price) stays genuinely unscoreable.

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
        'price_terms', 'yes',
        'horizon', 'market resolution',
        'resolve_status', case when m.id is null then 'no_market' else 'awaiting_resolution' end
      )
    from private.pm_note_scoreable_decisions(new) d
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

-- Supersede the 10 ODDSBORNE rollup rows (uuid prefixes; each must resolve to exactly one marketless
-- oddsborne pm_notes row).
do $$
declare
  p text;
  v_n integer;
begin
  foreach p in array array['a427b18c','4fde2c0f','30b69822','fdcc668c','3eef8064',
                           '9c1e440a','cb896093','3ef7da7f','256d4d79','069d030c'] loop
    select count(*) into v_n from public.decision_candidates d
    where d.id::text like p || '-%' and d.steward = 'oddsborne';
    if v_n <> 1 then
      raise exception '62: prefix % resolves to % oddsborne rows', p, v_n;
    end if;
    update public.decision_candidates d
    set meta = d.meta || jsonb_build_object('superseded', 'true',
                 'superseded_why', 'pm_notes rollup naming no market, not a decision (62)')
    where d.id::text like p || '-%' and d.steward = 'oddsborne'
      and d.source_table = 'pm_notes' and d.market_id is null and d.instrument is null
      and coalesce(d.meta->>'superseded', '') <> 'true';
  end loop;
end;
$$;
