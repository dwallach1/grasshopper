-- ODDSBORNE decisions: the side a price is quoted in, a market row for every logged pass,
-- and venue settlement for markets nobody holds.
--
-- 1. Price terms. private.score_decision_candidate (10) is written in YES terms: book_price is the
--    YES price and my_probability is P(yes), whatever side the row names. Rows split out of
--    pm_notes follow that. public.steward_log_decision (56) rows do not: ODDSBORNE logs the
--    price and probability of the side it names (Dolphins NO at 0.2375, fair 0.2517), so a NO
--    pass would have been charged 1 - 0.2375 and its Brier taken against P(yes). Every
--    prediction row now carries meta.price_terms ('yes' or 'side'), and the resolver converts
--    to YES terms before scoring. The numbers the steward logged are kept as logged.
--    The pm_notes "SKIP <team> NO <slug> maker X ... fair Y" parser also read the last "fair"
--    on the line (another market's number); it now stops at the next SKIP and converts the NO
--    side's maker / fair to YES terms like every other note-derived row. The one row it wrote
--    (aec-nfl-hou-ten-2026-10-11) is re-derived from its note.
-- 2. Markets. A pass on a market with no pm_markets row could never resolve (resolve_status
--    'no_market'). private.ensure_pm_market gives the slug a 'watch' row (not a live market on
--    the desk); steward_log_decision and the pm_notes trigger call it, and the existing rows are
--    backfilled here. ODDSBORNE's pm_decision_markets.py fills venue ids from Polymarket US and,
--    once the venue reports MARKET_STATUS_RESOLVED with the long side settled at 1 or 0, records
--    the resolution (public.oddsborne_sync_decision_market). Markets with an open ODDSBORNE lot
--    are left to the exit path.
-- 3. v_decision_clv reads every side in the logged side's terms.
-- 4. The decision_is_scoreable comment (written into schema 56 after its migration) lives here,
--    so 56 matches its migration again.

comment on function public.decision_is_scoreable(text, text, numeric, text, jsonb) is
  'True when a decision names an instrument, a side, and a positive price (prediction prices also <= 1) and is not flagged unscoreable or superseded. Probability is required for new prediction writes by the check constraint and steward_log_decision, not here, so older scored rows that never stated one stay on the scorecard. Lives in public: the scorecard, the watchdog, and the check run as the desk reader and the steward workers. Steward workers have USAGE on schema private for scoreable decision writes (steward_log_decision); private helpers stay revoked from anon and authenticated.';

-- ——— price terms ———

create or replace function public.decision_price_terms(p_meta jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(coalesce(p_meta->>'price_terms', '')) in ('yes', 'side') then lower(p_meta->>'price_terms')
    when coalesce(p_meta->>'origin', '') = 'steward_log_decision' then 'side'
    else 'yes'
  end;
$$;

comment on function public.decision_price_terms(jsonb) is
  'Prediction decisions: ''yes'' when book_price / my_probability are the YES price and P(yes) (pm_notes rows), ''side'' when they are the price and probability of the side the row names (steward_log_decision). meta.price_terms wins when set.';

create or replace function public.decision_in_yes_terms(p_side text, p_value numeric, p_meta jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then null
    when p_side = 'no' and public.decision_price_terms(p_meta) = 'side' then 1 - p_value
    else p_value
  end;
$$;

create or replace function public.decision_in_side_terms(p_side text, p_value numeric, p_meta jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then null
    when p_side = 'no' and public.decision_price_terms(p_meta) = 'yes' then 1 - p_value
    else p_value
  end;
$$;

revoke all on function public.decision_price_terms(jsonb) from public, anon;
revoke all on function public.decision_in_yes_terms(text, numeric, jsonb) from public, anon;
revoke all on function public.decision_in_side_terms(text, numeric, jsonb) from public, anon;
grant execute on function public.decision_price_terms(jsonb)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
grant execute on function public.decision_in_yes_terms(text, numeric, jsonb)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
grant execute on function public.decision_in_side_terms(text, numeric, jsonb)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— a market row for every logged prediction decision ———

create or replace function private.ensure_pm_market(
  p_slug text,
  p_question text default null,
  p_close_time timestamptz default null,
  p_created_by text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := nullif(btrim(coalesce(p_slug, '')), '');
  v_id uuid;
begin
  if v_slug is null or v_slug !~ '^[a-z0-9][a-z0-9-]{4,}$'
     or v_slug ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pm_markets:slug:' || v_slug));
  select m.id into v_id from public.pm_markets m where m.slug = v_slug order by m.created_at limit 1;
  if v_id is null then
    insert into public.pm_markets (venue, slug, question, status, close_time, meta)
    values ('polymarket', v_slug, coalesce(nullif(btrim(coalesce(p_question, '')), ''), v_slug), 'watch', p_close_time,
            pg_catalog.jsonb_build_object(
              'stub', true,
              'created_by', coalesce(p_created_by, 'ensure_pm_market'),
              'created_for', 'logged decision',
              'note', 'no venue ids yet: oddsborne pm_decision_markets.py fills them from Polymarket US'))
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function private.ensure_pm_market(text, text, timestamptz, text) is
  'pm_markets id for a slug, inserting a status ''watch'' stub (meta.stub) when there is none, so a logged decision on a market nobody holds can resolve. Venue ids and settlement come later from Polymarket US (public.oddsborne_sync_decision_market). Returns null for anything that is not a slug.';

revoke all on function private.ensure_pm_market(text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function private.ensure_pm_market(text, text, timestamptz, text) to oddsborne_worker, service_role;

-- ——— resolver: score in YES terms whatever terms the row was logged in ———

create or replace function private.resolve_decision_candidates(p_market_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched integer := 0;
  linked integer := 0;
begin
  with l as (
    update public.decision_candidates c
    set market_id = m.id,
        meta = case when c.meta->>'resolve_status' = 'no_market'
                    then c.meta || pg_catalog.jsonb_build_object('resolve_status', 'awaiting_resolution')
                    else c.meta end,
        updated_at = pg_catalog.now()
    from (
      select distinct on (slug) slug, id
      from public.pm_markets
      where slug is not null
      order by slug, created_at
    ) m
    where c.market_id is null
      and c.venue = 'prediction'
      and c.instrument = m.slug
      and coalesce(c.meta->>'superseded', '') <> 'true'
      and (p_market_id is null or m.id = p_market_id)
    returning c.id
  )
  select count(*) into linked from l;

  with resolved as (
    select c.id,
      lower(m.resolution_outcome) as outcome,
      coalesce(m.updated_at, pg_catalog.now()) as at,
      s.counterfactual_pnl,
      s.brier,
      public.decision_price_terms(c.meta) as terms
    from public.decision_candidates c
    join public.pm_markets m on m.id = c.market_id
    cross join lateral private.score_decision_candidate(
      c.side,
      public.decision_in_yes_terms(c.side, c.my_probability, c.meta),
      public.decision_in_yes_terms(c.side, c.book_price, c.meta),
      lower(m.resolution_outcome)
    ) s
    where (p_market_id is null or c.market_id = p_market_id)
      and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and lower(coalesce(m.resolution_outcome, '')) in ('yes', 'no', 'void')
  )
  update public.decision_candidates c set
    resolved_outcome = r.outcome,
    resolved_at = coalesce(c.resolved_at, r.at),
    counterfactual_pnl = r.counterfactual_pnl,
    brier = r.brier,
    meta = c.meta || pg_catalog.jsonb_build_object(
      'horizon', 'market resolution',
      'price_terms', r.terms,
      'resolve_status', case when r.outcome = 'void' then 'void' else 'resolved' end
    ),
    updated_at = pg_catalog.now()
  from resolved r
  where c.id = r.id
    and (c.resolved_outcome is distinct from r.outcome
      or c.counterfactual_pnl is distinct from r.counterfactual_pnl
      or c.brier is distinct from r.brier);
  get diagnostics touched = row_count;
  return touched + linked;
end;
$$;

-- ——— pm_notes: the NO-side parser, and a market row for what a note priced ———
-- Every row this returns is in YES terms (book_price = YES price, my_probability = P(yes)).

create or replace function private.pm_note_scoreable_decisions(p_note public.pm_notes)
returns table (
  decision text,
  instrument text,
  side text,
  book_price numeric,
  my_probability numeric,
  reason text
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
           left(line, 280) as reason
    from regexp_split_to_table(coalesce(p_note.body, ''), E'\n') as line
    cross join lateral regexp_match(line, '^\s*-\s+([a-z0-9][a-z0-9-]{8,}):\s+.*fair=([0-9]*\.?[0-9]+).*BBO=([0-9]*\.?[0-9]+)/', 'i') as m
    where p_note.decision = 'skip'
    union all
    select 'skip'::text,
           coalesce(elem->>'market_slug', elem->>'market'),
           'yes'::text,
           private.try_numeric(elem->>'bid'),
           private.try_numeric(elem->>'fair'),
           left(coalesce(elem->>'why', p_note.title), 280)
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
           left(coalesce(p_note.title, ''), 280)
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
           left(coalesce(p_note.title, ''), 280)
    where p_note.decision = 'enter'
      and p_note.meta ? 'slug'
      and p_note.meta ? 'price'
      and (p_note.title ~* '\mYES\M' or left(coalesce(p_note.body, ''), 120) ~* '\mYES\M')
    union all
    -- "SKIP <team> YES|NO <slug> maker X ... fair Y": X and Y are that side's maker price and fair.
    -- Stop at the next SKIP (the old pattern took the line's last "fair", another market's), and
    -- return a NO side in YES terms (1 - X, 1 - Y) like every other row here.
    select 'skip'::text,
           m[2],
           lower(m[1]),
           case when lower(m[1]) = 'no' then 1 - private.try_numeric(m[3]) else private.try_numeric(m[3]) end,
           case when lower(m[1]) = 'no' then 1 - private.try_numeric(m[4]) else private.try_numeric(m[4]) end,
           left(coalesce(p_note.title, ''), 280)
    from regexp_match(
      coalesce(p_note.body, ''),
      'SKIP[[:space:]]+(?:[^\nS]|S(?!KIP))*[[:space:]](YES|NO)[[:space:]]+([a-z0-9][a-z0-9-]{8,})[[:space:]]+maker[[:space:]]+([0-9]*\.?[0-9]+)(?:[^\nS]|S(?!KIP))*?fair[[:space:]]+([0-9]*\.?[0-9]+)',
      'i'
    ) as m
    where p_note.decision = 'skip'
  )
  select distinct on (r.instrument, r.side)
    r.decision, r.instrument, r.side, r.book_price, r.my_probability, r.reason
  from raw r
  where nullif(btrim(coalesce(r.instrument, '')), '') is not null
    and r.side in ('yes', 'no')
    and r.book_price > 0 and r.book_price <= 1
    and r.my_probability >= 0 and r.my_probability <= 1
  order by r.instrument, r.side, r.book_price;
end;
$$;

create or replace function private.decision_candidate_from_pm_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

    if n = 0 and not exists (
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
$$;

-- ——— steward_log_decision: a market row for the pass, and the terms of its price ———

create or replace function public.steward_log_decision(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_steward text := lower(btrim(coalesce(p->>'steward', '')));
  v_decision text := lower(btrim(coalesce(p->>'decision', '')));
  v_instrument text := nullif(btrim(coalesce(p->>'instrument', '')), '');
  v_side text := lower(btrim(coalesce(p->>'side', '')));
  v_price numeric := private.try_numeric(p->>'price');
  v_prob numeric := private.try_numeric(p->>'probability');
  v_move numeric := private.try_numeric(p->>'expected_move');
  v_venue text;
  v_horizon text;
  v_status text;
  v_market uuid;
  v_source text := nullif(btrim(coalesce(p->>'source_id', '')), '');
  v_at timestamptz;
  v_id uuid;
  v_owner text;
  v_replayed boolean := false;
  v_edge numeric;
  v_close timestamptz;
  v_terms text;
  v_extra jsonb := case
    when jsonb_typeof(p->'meta') = 'object' then p->'meta'
    else '{}'::jsonb
  end;
begin
  if current_user like '%\_worker' and current_user::text <> v_steward || '_worker' then
    raise exception 'refusal:auth: % may not log a decision for %', current_user, v_steward
      using errcode = '42501';
  end if;
  if v_steward = 'quantanamo' then
    v_venue := 'equity';
  elsif v_steward = 'oddsborne' then
    v_venue := 'prediction';
  elsif v_steward = 'bandit' then
    v_venue := 'meme';
  else
    raise exception 'refusal:unscoreable: steward must be quantanamo, oddsborne, or bandit'
      using errcode = 'P0001';
  end if;
  if v_decision not in ('enter', 'skip') then
    raise exception 'refusal:unscoreable: decision must be enter or skip'
      using errcode = 'P0001';
  end if;
  if v_instrument is null then
    raise exception 'refusal:unscoreable: name the market or the ticker'
      using errcode = 'P0001';
  end if;
  if v_venue = 'equity' then
    v_instrument := upper(v_instrument);
  end if;

  if v_venue = 'prediction' and v_side not in ('yes', 'no') then
    raise exception 'refusal:unscoreable: side must be yes or no'
      using errcode = 'P0001';
  elsif v_venue <> 'prediction' and v_side not in ('long', 'short') then
    raise exception 'refusal:unscoreable: side must be long or short'
      using errcode = 'P0001';
  end if;

  if v_price is null or v_price <= 0 or (v_venue = 'prediction' and v_price > 1) then
    raise exception 'refusal:unscoreable: price must be the price at decision time (a prediction price is between 0 and 1, exclusive of 0)'
      using errcode = 'P0001';
  end if;
  if v_venue = 'prediction' and (v_prob is null or v_prob < 0 or v_prob > 1) then
    raise exception 'refusal:unscoreable: a prediction decision needs your probability between 0 and 1'
      using errcode = 'P0001';
  end if;
  if v_venue <> 'prediction'
     and nullif(btrim(coalesce(p->>'probability', '')), '') is not null
     and (v_prob is null or v_prob < 0 or v_prob > 1) then
    raise exception 'refusal:unscoreable: probability must be between 0 and 1'
      using errcode = 'P0001';
  end if;
  if p ? 'expected_move' and nullif(btrim(p->>'expected_move'), '') is not null and v_move is null then
    raise exception 'refusal:unscoreable: expected_move must be a fraction of price, such as 0.08 for +8%%'
      using errcode = 'P0001';
  end if;

  begin
    v_at := nullif(btrim(coalesce(p->>'decided_at', '')), '')::timestamptz;
  exception when others then
    raise exception 'refusal:unscoreable: decided_at is not a timestamp'
      using errcode = 'P0001';
  end;
  v_at := coalesce(v_at, now());
  begin
    v_close := nullif(btrim(coalesce(p->>'close_time', '')), '')::timestamptz;
  exception when others then
    raise exception 'refusal:unscoreable: close_time is not a timestamp'
      using errcode = 'P0001';
  end;

  if v_venue = 'prediction' then
    v_horizon := 'market resolution';
    if nullif(btrim(coalesce(p->>'market_id', '')), '') is not null then
      v_market := (p->>'market_id')::uuid;
    end if;
    if v_market is null then
      -- A pass on a market nobody holds still needs a row to resolve against (59).
      v_market := private.ensure_pm_market(v_instrument, p->>'question', v_close, 'steward_log_decision');
    end if;
    v_status := case when v_market is null then 'no_market' else 'awaiting_resolution' end;
    -- price and probability are the named side's own (Dolphins NO at 0.2375, fair 0.2517)
    -- unless the caller says they are YES terms; the resolver converts before scoring.
    v_terms := case when lower(coalesce(v_extra->>'price_terms', '')) = 'yes' then 'yes' else 'side' end;
    v_edge := v_prob - v_price;
  elsif v_venue = 'equity' then
    v_horizon := '5 equity sessions';
    v_status := 'awaiting_mark';
    v_edge := null;
  else
    v_horizon := '4 hours';
    v_status := 'awaiting_mark';
    v_edge := null;
  end if;

  if v_source is null then
    v_source := gen_random_uuid()::text;
  end if;

  insert into public.decision_candidates (
    steward, venue, decided_at, decision, market_id, instrument, thesis_id, side,
    my_probability, book_price, edge, expected_move, reason, source_table, source_id, meta
  ) values (
    v_steward, v_venue, v_at, v_decision, v_market, v_instrument,
    nullif(btrim(coalesce(p->>'thesis_id', '')), ''), v_side,
    v_prob, v_price, v_edge, v_move,
    left(nullif(btrim(coalesce(p->>'reason', '')), ''), 280),
    'direct', v_source,
    jsonb_strip_nulls(
      (v_extra - 'unscoreable' - 'superseded' - 'legacy_probability_absent') || jsonb_build_object(
        'origin', 'steward_log_decision',
        'horizon', v_horizon,
        'resolve_status', v_status,
        'price_terms', v_terms,
        'blocked_by', nullif(btrim(coalesce(p->>'blocked_by', '')), '')
      )
    )
  )
  on conflict (source_table, source_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id, steward into v_id, v_owner
    from public.decision_candidates
    where source_table = 'direct' and source_id = v_source;
    if v_owner is distinct from v_steward then
      raise exception 'refusal:unscoreable: source_id already belongs to %', coalesce(v_owner, 'another row')
        using errcode = 'P0001';
    end if;
    v_replayed := true;
  elsif v_venue = 'prediction' and v_market is not null then
    perform private.resolve_decision_candidates(v_market);
  elsif v_venue <> 'prediction' then
    perform private.resolve_marked_decisions();
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'replayed', v_replayed,
    'horizon', v_horizon,
    'resolve_status', v_status,
    'market_id', v_market,
    'price_terms', v_terms
  );
exception
  when invalid_text_representation then
    raise exception 'refusal:unscoreable: market_id is not a uuid'
      using errcode = 'P0001';
end;
$$;

comment on function public.steward_log_decision(jsonb) is
  'Log one enter or skip that can be scored later. Refuses (refusal:unscoreable) when the market, side, price, or (for prediction) probability is missing. Does not size or gate a trade. Equity resolves after 5 regular sessions, memes after 4 hours, prediction markets at resolution. Prediction: price and probability are the named side''s own (meta.price_terms = ''side''; pass meta.price_terms = ''yes'' for YES terms); a slug with no pm_markets row gets a ''watch'' stub so it can resolve (optional question, close_time). No price is invented.';

-- ——— entering a market that was only a logged pass makes it a live market ———

create or replace function public.oddsborne_entry_upsert_market(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_slug text := p->>'slug';
  v_yes text := p->>'yes_side_id';
  v_no text := p->>'no_side_id';
  v_id uuid;
  v_y text;
  v_n text;
begin
  if v_slug is null or v_yes is null or v_no is null then
    raise exception 'refusal:input: slug, yes_side_id and no_side_id are required' using errcode = 'P0001';
  end if;
  select id, yes_token_id, no_token_id into v_id, v_y, v_n
  from public.pm_markets where slug = v_slug order by created_at limit 1;
  if found then
    if (nullif(v_y, '') is not null and v_y <> v_yes) or (nullif(v_n, '') is not null and v_n <> v_no) then
      raise exception 'refusal:market: pm_markets side ids %/% disagree with venue %/% for %',
        v_y, v_n, v_yes, v_no, v_slug using errcode = 'P0001';
    end if;
    update public.pm_markets
       set yes_token_id = v_yes, no_token_id = v_no,
           condition_id = coalesce(condition_id, p->>'venue_market_id'),
           close_time = coalesce(close_time, (p->>'close_time')::timestamptz),
           -- a 'watch' stub (a logged pass, 59) becomes a live market once ODDSBORNE enters it
           status = case when status = 'watch' then 'open' else status end,
           meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('venue_ids', p->'venue_ids'),
           updated_at = now()
     where id = v_id;
  else
    insert into public.pm_markets (venue, condition_id, slug, question, status, close_time,
                                   yes_token_id, no_token_id, meta)
    values ('polymarket', p->>'venue_market_id', v_slug, coalesce(nullif(p->>'question', ''), v_slug), 'open',
            (p->>'close_time')::timestamptz, v_yes, v_no, jsonb_build_object('venue_ids', p->'venue_ids'))
    returning id into v_id;
  end if;
  return jsonb_build_object('pm_market_id', v_id);
end;
$$;

-- ——— ODDSBORNE: venue ids and settlement for the markets its decisions name ———

create or replace function public.oddsborne_decision_markets(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(private.try_numeric(p->>'limit')::integer, 100), 1), 300);
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.game_start_at nulls first, x.slug)
    from (
      select m.id as pm_market_id,
        m.slug,
        m.status,
        m.close_time,
        (nullif(m.yes_token_id, '') is not null and nullif(m.no_token_id, '') is not null) as has_venue_ids,
        m.meta->>'venue_status' as venue_status,
        m.meta->>'venue_checked_at' as venue_checked_at,
        m.meta->>'game_start_at' as game_start_at,
        coalesce((m.meta->>'stub')::boolean, false) as stub,
        count(*)::int as decisions
      from public.decision_candidates c
      join public.pm_markets m on m.id = c.market_id
      where c.steward = 'oddsborne'
        and c.venue = 'prediction'
        and c.resolved_outcome is null
        and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
        and m.resolution_outcome is null
        and m.slug is not null
      group by m.id
      order by m.meta->>'game_start_at' nulls first, m.slug
      limit v_limit
    ) x
  ), '[]'::jsonb);
end;
$$;

comment on function public.oddsborne_decision_markets(jsonb) is
  'ODDSBORNE: markets named by its unresolved, scoreable decisions whose pm_markets row has no resolution yet, with what the venue sync last saw (has_venue_ids, venue_status, venue_checked_at, game_start_at). Read-only. Args: limit (default 100).';

revoke all on function public.oddsborne_decision_markets(jsonb) from public, anon, authenticated;
grant execute on function public.oddsborne_decision_markets(jsonb) to oddsborne_worker, service_role;

create or replace function public.oddsborne_sync_decision_market(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_slug text := nullif(btrim(coalesce(p->>'slug', '')), '');
  v_found boolean := coalesce((p->>'found')::boolean, true);
  v_yes text := nullif(btrim(coalesce(p->>'yes_side_id', '')), '');
  v_no text := nullif(btrim(coalesce(p->>'no_side_id', '')), '');
  v_venue_status text := nullif(btrim(coalesce(p->>'venue_status', '')), '');
  v_settlement numeric := private.try_numeric(p->>'settlement');
  v_close timestamptz;
  v_start timestamptz;
  v_outcome text;
  v_id uuid;
  v_m public.pm_markets;
  v_note text;
  v_ids jsonb;
begin
  if v_slug is null then
    raise exception 'refusal:market: slug is required' using errcode = 'P0001';
  end if;
  begin
    v_close := nullif(btrim(coalesce(p->>'close_time', '')), '')::timestamptz;
    v_start := nullif(btrim(coalesce(p->>'game_start_at', '')), '')::timestamptz;
  exception when others then
    raise exception 'refusal:market: close_time / game_start_at must be timestamps' using errcode = 'P0001';
  end;
  v_id := private.ensure_pm_market(v_slug, p->>'question', v_close, 'oddsborne_sync_decision_market');
  if v_id is null then
    raise exception 'refusal:market: % is not a market slug', v_slug using errcode = 'P0001';
  end if;
  select * into v_m from public.pm_markets where id = v_id for update;

  if not v_found then
    update public.pm_markets
       set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
             'venue_status', 'not_found', 'venue_checked_at', now(),
             'venue_note', 'Polymarket US markets.retrieve_by_slug: 404'),
           updated_at = now()
     where id = v_id;
    return jsonb_build_object('ok', true, 'pm_market_id', v_id, 'slug', v_slug, 'venue_status', 'not_found');
  end if;

  if v_yes is null or v_no is null then
    raise exception 'refusal:market: yes_side_id and no_side_id are required for a market the venue has'
      using errcode = 'P0001';
  end if;
  if (nullif(v_m.yes_token_id, '') is not null and v_m.yes_token_id <> v_yes)
     or (nullif(v_m.no_token_id, '') is not null and v_m.no_token_id <> v_no) then
    raise exception 'refusal:market: pm_markets side ids %/% disagree with venue %/% for %',
      v_m.yes_token_id, v_m.no_token_id, v_yes, v_no, v_slug using errcode = 'P0001';
  end if;

  -- Settlement: only a venue-resolved market whose long (yes) side settled at exactly 1 or 0.
  if v_venue_status = 'MARKET_STATUS_RESOLVED' then
    v_outcome := case when v_settlement = 1 then 'yes' when v_settlement = 0 then 'no' end;
    if v_outcome is null then
      v_note := 'venue resolved with long-side settlement ' || coalesce(v_settlement::text, 'null') || '; not recorded';
    end if;
  end if;
  if v_outcome is not null and v_m.resolution_outcome is not null and v_m.resolution_outcome <> v_outcome then
    raise exception 'refusal:market: venue settlement % disagrees with recorded resolution % for %',
      v_outcome, v_m.resolution_outcome, v_slug using errcode = 'P0001';
  end if;
  if v_outcome is not null and v_m.resolution_outcome is null and exists (
    select 1 from public.pm_positions pp where pp.market_id = v_id and pp.status in ('open', 'active')
  ) then
    v_note := 'ODDSBORNE holds an open lot here: the exit path records this settlement';
    v_outcome := null;
  end if;

  v_ids := case when jsonb_typeof(p->'venue_ids') = 'object' then p->'venue_ids' else '{}'::jsonb end;
  update public.pm_markets
     set yes_token_id = v_yes,
         no_token_id = v_no,
         condition_id = coalesce(condition_id, nullif(p->>'venue_market_id', '')),
         question = case when question is null or question = slug
                         then coalesce(nullif(btrim(coalesce(p->>'question', '')), ''), question) else question end,
         close_time = coalesce(close_time, v_close),
         resolution_outcome = coalesce(resolution_outcome, v_outcome),
         status = case when v_outcome is not null then 'resolved' else status end,
         meta = coalesce(meta, '{}'::jsonb)
           || jsonb_strip_nulls(jsonb_build_object(
                'venue_status', v_venue_status,
                'venue_checked_at', now(),
                'game_start_at', v_start,
                'venue_settlement', v_settlement,
                'venue_note', v_note))
           || case when v_m.meta ? 'venue_ids' then '{}'::jsonb else jsonb_build_object('venue_ids', v_ids) end
           || case when v_outcome is not null and v_m.resolution_outcome is null
                   then jsonb_build_object('resolved_by', 'oddsborne_sync_decision_market',
                                           'resolution_source', coalesce(nullif(p->>'source', ''), 'polymarket_us markets.settlement'),
                                           'resolved_recorded_at', now())
                   else '{}'::jsonb end,
         updated_at = now()
   where id = v_id
   returning * into v_m;

  return jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'pm_market_id', v_id,
    'slug', v_slug,
    'status', v_m.status,
    'venue_status', v_venue_status,
    'resolution_outcome', v_m.resolution_outcome,
    'resolved_now', v_outcome is not null,
    'note', v_note,
    'decisions_resolved', (
      select count(*) from public.decision_candidates c
      where c.market_id = v_id and c.resolved_outcome is not null)
  ));
end;
$$;

comment on function public.oddsborne_sync_decision_market(jsonb) is
  'ODDSBORNE (pm_decision_markets.py): what Polymarket US says about one decision market. found=false notes a 404. Otherwise fills venue ids (refuses if they disagree with stored ones), question, close_time, game_start_at, venue_status; when venue_status is MARKET_STATUS_RESOLVED and the long (yes) side settled at exactly 1 or 0 it records resolution_outcome yes / no (the resolution trigger then scores the decisions). Never overrides a recorded resolution, and leaves markets with an open ODDSBORNE lot to the exit path.';

revoke all on function public.oddsborne_sync_decision_market(jsonb) from public, anon, authenticated;
grant execute on function public.oddsborne_sync_decision_market(jsonb) to oddsborne_worker, service_role;

-- ——— closing-line value: every side in the logged side's terms ———

create or replace view public.v_decision_clv
with (security_invoker = true)
as
select c.id as decision_id,
  c.steward,
  c.decision,
  c.instrument,
  c.side,
  c.decided_at,
  public.decision_in_side_terms(c.side, c.book_price, c.meta) as entry_price,
  public.decision_in_side_terms(c.side, c.my_probability, c.meta) as my_probability,
  m.price as close_mid,
  m.observed_at as close_observed_at,
  m.event_start_at,
  m.source as close_source,
  m.price - public.decision_in_side_terms(c.side, c.book_price, c.meta) as clv,
  public.decision_in_side_terms(c.side, c.my_probability, c.meta) - m.price as fair_minus_close,
  abs(public.decision_in_side_terms(c.side, c.my_probability, c.meta) - m.price)
    < abs(public.decision_in_side_terms(c.side, c.book_price, c.meta) - m.price) as fair_closer_than_entry,
  c.resolved_outcome,
  c.counterfactual_pnl
from public.decision_candidates c
join public.decision_marks m on m.decision_id = c.id and m.mark_kind = 'close'
where c.venue = 'prediction'
  and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta);

comment on view public.v_decision_clv is
  'Closing-line value per ODDSBORNE decision with a close mark. entry_price, my_probability and close_mid are all in the terms of the side the decision names (YES-terms rows are flipped for a NO side). clv = close_mid - entry_price: positive means the line moved toward the steward''s side after the decision (good for an enter; for a skip, value passed up). fair_minus_close = my_probability - close_mid. fair_closer_than_entry = the steward''s probability was nearer the close than the entry price was. Separate from settlement (resolved_outcome, counterfactual_pnl, brier).';

-- ——— repairs ———

-- a. Re-logs that say they supersede an event-slug row: flag the old row so it is not scored twice.
update public.decision_candidates o
set meta = o.meta || jsonb_build_object('superseded', 'true', 'superseded_by', n.id),
    updated_at = now()
from public.decision_candidates n
where n.steward = o.steward
  and n.id <> o.id
  and n.reason ~* ('supersedes [a-z-]*[[:space:]]*row ' || left(o.id::text, 8))
  and coalesce(o.meta->>'superseded', '') <> 'true';

-- b. Note-derived NO rows the old parser priced from the wrong "fair": re-derive from the note.
update public.decision_candidates c
set book_price = d.book_price,
    my_probability = d.my_probability,
    edge = d.my_probability - d.book_price,
    meta = c.meta || jsonb_build_object(
      'price_terms', 'yes',
      'repair_59', jsonb_build_object(
        'was_book_price', c.book_price, 'was_my_probability', c.my_probability,
        'why', 'pm_notes SKIP NO parser read another market''s fair; re-derived from the note in YES terms')),
    updated_at = now()
from public.pm_notes n
cross join lateral private.pm_note_scoreable_decisions(n) d
where c.source_table = 'pm_notes'
  and c.venue = 'prediction'
  and c.side = 'no'
  and coalesce(c.meta->>'origin', '') in ('trigger', 'repair')
  and n.id::text = c.meta->>'note_id'
  and d.instrument = c.instrument
  and d.side = c.side
  and (d.book_price is distinct from c.book_price or d.my_probability is distinct from c.my_probability);

-- c. Every prediction row says which terms its price is in.
update public.decision_candidates c
set meta = c.meta || jsonb_build_object('price_terms', public.decision_price_terms(c.meta)),
    updated_at = now()
where c.venue = 'prediction'
  and c.meta->>'price_terms' is null;

-- d. A market row for every scoreable prediction decision that has none.
select private.ensure_pm_market(c.instrument, null, null, 'backfill 59')
from (
  select distinct c.instrument
  from public.decision_candidates c
  where c.venue = 'prediction'
    and c.market_id is null
    and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
) c;

-- e. Link, and (re)score anything resolved under the old terms.
select private.resolve_decision_candidates(null);
