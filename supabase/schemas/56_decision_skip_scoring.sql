-- Score the passes, not only the bets taken.
--
-- What was wrong: private.decision_candidate_from_pm_note copied market_id, my_probability
-- and book_probability off the pm_notes row. Since 2026-09-27 ODDSBORNE writes one note for a
-- whole session (several markets in the body or in meta), those columns are null, and the
-- trigger still inserted one decision_candidates row with side defaulted to yes. The scorecard
-- counted it. Nothing could resolve it.
--
-- A decision is scoreable when it names the instrument, the side, and the price at decision
-- time. Prediction markets also need the steward's probability (0 to 1). A row that cannot be
-- scored is stored with meta.unscoreable = 'true' and is not counted as a pass. A batch note
-- that did contain per-market prices and probabilities is split; the original row is kept and
-- marked meta.superseded = 'true' (not deleted).
--
-- Horizons (fixed, documented; never a made-up price):
--   prediction  the market's resolution (pm_markets.resolution_outcome). One contract, USD.
--   equity      the close of the 5th regular NYSE session after the decision. One share, USD.
--               Mark = the earliest portfolio_exposure.last_price or broker_fills.price at or
--               after that close. No mark -> counterfactual_pnl stays null and
--               meta.resolve_status = 'no_mark_yet'.
--   meme        4 hours after the decision (BANDIT's own 4h stop). One token, SOL.
--               Mark = the earliest meme fill, token last price, or position mark whose
--               timestamp is at or after that instant.
-- Positive counterfactual_pnl on a skip means passing on it left that much on the table.

-- ——— columns and checks ———

alter table public.decision_candidates
  add column if not exists expected_move numeric;

comment on column public.decision_candidates.expected_move is
  'Equity or meme only: the move the steward stated at decision time, as a fraction of price (0.08 = +8%). Not filled from the later mark. Null when they did not state one.';

comment on column public.decision_candidates.counterfactual_pnl is
  'P/L of one unit bought at book_price. Prediction: one contract in USD, payoff 0 or 1. Equity: one share in USD after 5 regular sessions. Meme: one token in SOL after 4 hours. Positive on a skip means the pass left money on the table. Null until a real resolution or a later ledger mark exists.';

alter table public.decision_candidates drop constraint if exists decision_candidates_book_price_check;
alter table public.decision_candidates add constraint decision_candidates_book_price_check
  check (book_price is null or book_price > 0);

alter table public.decision_candidates drop constraint if exists decision_candidates_side_check;
alter table public.decision_candidates add constraint decision_candidates_side_check
  check (side is null or side in ('yes', 'no', 'long', 'short'));

-- ——— scoreable? ———

create or replace function public.decision_is_scoreable(
  p_instrument text,
  p_side text,
  p_book_price numeric,
  p_venue text,
  p_meta jsonb
) returns boolean
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(coalesce(p_instrument, '')), '') is not null
    and p_side is not null
    and p_book_price is not null
    and p_book_price > 0
    and (p_venue is distinct from 'prediction' or p_book_price <= 1)
    and coalesce(p_meta->>'unscoreable', '') is distinct from 'true'
    and coalesce(p_meta->>'superseded', '') is distinct from 'true';
$$;

revoke all on function public.decision_is_scoreable(text, text, numeric, text, jsonb) from public, anon;
grant execute on function public.decision_is_scoreable(text, text, numeric, text, jsonb)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

comment on function public.decision_is_scoreable(text, text, numeric, text, jsonb) is
  'True when a decision names an instrument, a side, and a positive price (prediction prices also <= 1) and is not flagged unscoreable or superseded. Probability is required for new prediction writes by the check constraint and steward_log_decision, not here, so older scored rows that never stated one stay on the scorecard. Lives in public: the scorecard, the watchdog, and the check run as the desk reader and the steward workers. Steward workers have USAGE on schema private for scoreable decision writes (steward_log_decision); private helpers stay revoked from anon and authenticated.';

-- ——— equity horizon: close of the Nth regular session after the decision ———

create or replace function private.nth_equity_session_close(p_at timestamptz, p_n integer)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  d date;
  n integer := 0;
  v_kind text;
  v_close time;
  v_close_at timestamptz;
begin
  if p_at is null or p_n is null or p_n < 1 then
    return null;
  end if;
  d := (p_at at time zone 'America/New_York')::date;
  loop
    if d > (p_at at time zone 'America/New_York')::date + 40 then
      return null;
    end if;
    select c.kind,
           case when c.kind = 'early_close' then c.close_et else time '16:00' end
      into v_kind, v_close
    from public.us_equity_market_calendar c
    where c.day = d;
    if not found then
      v_kind := null;
      v_close := time '16:00';
    end if;
    if extract(isodow from d) between 1 and 5 and coalesce(v_kind, '') <> 'holiday' then
      v_close_at := (d::timestamp + v_close) at time zone 'America/New_York';
      if v_close_at > p_at then
        n := n + 1;
        if n = p_n then
          return v_close_at;
        end if;
      end if;
    end if;
    d := d + 1;
  end loop;
end;
$$;

revoke all on function private.nth_equity_session_close(timestamptz, integer) from public, anon, authenticated;

comment on function private.nth_equity_session_close(timestamptz, integer) is
  'Close (timestamptz) of the Nth regular NYSE session strictly after p_at. Weekends and us_equity_market_calendar holidays are skipped; early closes use close_et. Null if no such session within 40 days.';

-- ——— pull scoreable decisions out of one pm_note ———
-- Only fields the note actually carries. No inferred probability.

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
    select 'skip'::text,
           m[2],
           lower(m[1]),
           private.try_numeric(m[3]),
           private.try_numeric(m[4]),
           left(coalesce(p_note.title, ''), 280)
    from regexp_match(
      coalesce(p_note.body, ''),
      'SKIP[[:space:]]+[^\n]*[[:space:]](YES|NO)[[:space:]]+([a-z0-9][a-z0-9-]{8,})[[:space:]]+maker[[:space:]]+([0-9]*\.?[0-9]+)[^\n]*fair[[:space:]]+([0-9]*\.?[0-9]+)',
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

revoke all on function private.pm_note_scoreable_decisions(public.pm_notes) from public, anon, authenticated;

-- ——— resolvers ———

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
  update public.decision_candidates c
  set market_id = m.id,
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
    and (p_market_id is null or m.id = p_market_id);
  get diagnostics linked = row_count;

  with resolved as (
    select c.id,
      lower(m.resolution_outcome) as outcome,
      coalesce(m.updated_at, pg_catalog.now()) as at,
      s.counterfactual_pnl,
      s.brier
    from public.decision_candidates c
    join public.pm_markets m on m.id = c.market_id
    cross join lateral private.score_decision_candidate(
      c.side, c.my_probability, c.book_price, lower(m.resolution_outcome)
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
    meta = c.meta || jsonb_build_object(
      'horizon', 'market resolution',
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

create or replace function private.resolve_marked_decisions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched integer := 0;
  marked integer := 0;
  waiting integer := 0;
begin
  -- Equity: earliest real print at or after the 5th session close. One share.
  with marks as (
    select c.id,
      c.side,
      c.book_price,
      mk.price,
      mk.at,
      mk.source,
      private.nth_equity_session_close(c.decided_at, 5) as horizon_at
    from public.decision_candidates c
    join lateral (
      select s.price, s.at, s.source
      from (
        select e.last_price as price, e.observed_at as at, 'portfolio_exposure.last_price'::text as source
        from public.portfolio_exposure e
        where e.symbol = c.instrument
          and e.last_price is not null
          and e.last_price > 0
          and e.observed_at >= private.nth_equity_session_close(c.decided_at, 5)
        union all
        select f.price, f.executed_at, 'broker_fills.price'
        from public.broker_fills f
        join public.trade_intents i on i.id = f.trade_intent_id
        where i.symbol = c.instrument
          and f.price is not null
          and f.price > 0
          and f.executed_at >= private.nth_equity_session_close(c.decided_at, 5)
      ) s
      where s.price is not null
      order by s.at asc
      limit 1
    ) mk on true
    where c.venue = 'equity'
      and c.counterfactual_pnl is null
      and c.side in ('long', 'short')
      and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and private.nth_equity_session_close(c.decided_at, 5) is not null
      and private.nth_equity_session_close(c.decided_at, 5) <= pg_catalog.now()
  )
  update public.decision_candidates c set
    counterfactual_pnl = case
      when m.side = 'long' then m.price - m.book_price
      else m.book_price - m.price
    end,
    resolved_at = coalesce(c.resolved_at, m.at),
    meta = c.meta || jsonb_build_object(
      'horizon', '5 equity sessions',
      'horizon_at', m.horizon_at,
      'resolve_status', 'marked',
      'mark_price', m.price,
      'mark_at', m.at,
      'mark_source', m.source,
      'unit', 'USD per share'
    ),
    updated_at = pg_catalog.now()
  from marks m
  where c.id = m.id
    and m.price is not null;
  get diagnostics marked = row_count;
  touched := touched + marked;

  -- Meme: earliest real print at or after 4 hours. One token.
  with marks as (
    select c.id,
      c.side,
      c.book_price,
      mk.price,
      mk.at,
      mk.source
    from public.decision_candidates c
    join lateral (
      select s.price, s.at, s.source
      from (
        select f.price_sol as price, f.executed_at as at, 'meme_fills.price_sol'::text as source
        from public.meme_fills f
        join public.meme_orders o on o.id = f.order_id
        join public.meme_tokens t on t.id = o.token_id
        where (t.mint = c.instrument or upper(t.symbol) = upper(c.instrument))
          and f.price_sol is not null
          and f.price_sol > 0
          and f.executed_at >= c.decided_at + interval '4 hours'
        union all
        select t.last_price_sol, t.last_marked_at, 'meme_tokens.last_price_sol'
        from public.meme_tokens t
        where (t.mint = c.instrument or upper(t.symbol) = upper(c.instrument))
          and t.last_price_sol is not null
          and t.last_price_sol > 0
          and t.last_marked_at >= c.decided_at + interval '4 hours'
        union all
        select p.mark_sol, p.mark_at, 'meme_positions.mark_sol'
        from public.meme_positions p
        join public.meme_tokens t on t.id = p.token_id
        where (t.mint = c.instrument or upper(t.symbol) = upper(c.instrument))
          and p.mark_sol is not null
          and p.mark_sol > 0
          and p.mark_at >= c.decided_at + interval '4 hours'
      ) s
      where s.price is not null and s.at is not null
      order by s.at asc
      limit 1
    ) mk on true
    where c.venue = 'meme'
      and c.counterfactual_pnl is null
      and c.side in ('long', 'short')
      and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and c.decided_at + interval '4 hours' <= pg_catalog.now()
  )
  update public.decision_candidates c set
    counterfactual_pnl = case
      when m.side = 'long' then m.price - m.book_price
      else m.book_price - m.price
    end,
    resolved_at = coalesce(c.resolved_at, m.at),
    meta = c.meta || jsonb_build_object(
      'horizon', '4 hours',
      'resolve_status', 'marked',
      'mark_price', m.price,
      'mark_at', m.at,
      'mark_source', m.source,
      'unit', 'SOL per token'
    ),
    updated_at = pg_catalog.now()
  from marks m
  where c.id = m.id;
  get diagnostics marked = row_count;
  touched := touched + marked;

  -- Horizon has passed and the ledger still has no mark. Say so. Do not invent one.
  update public.decision_candidates c set
    meta = c.meta || jsonb_build_object(
      'resolve_status', 'no_mark_yet',
      'horizon', case when c.venue = 'equity' then '5 equity sessions' else '4 hours' end
    ),
    updated_at = pg_catalog.now()
  where c.venue in ('equity', 'meme')
    and c.counterfactual_pnl is null
    and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
    and coalesce(c.meta->>'resolve_status', '') is distinct from 'no_mark_yet'
    and (
      (c.venue = 'meme' and c.decided_at + interval '4 hours' <= pg_catalog.now())
      or (c.venue = 'equity'
          and private.nth_equity_session_close(c.decided_at, 5) is not null
          and private.nth_equity_session_close(c.decided_at, 5) <= pg_catalog.now())
    );
  get diagnostics waiting = row_count;
  return touched + waiting;
end;
$$;

revoke all on function private.resolve_decision_candidates(uuid) from public, anon, authenticated;
revoke all on function private.resolve_marked_decisions() from public, anon, authenticated;
grant execute on function private.resolve_decision_candidates(uuid)
  to service_role, quantanamo_worker, oddsborne_worker, bandit_worker;
grant execute on function private.resolve_marked_decisions()
  to service_role, quantanamo_worker, oddsborne_worker, bandit_worker;

-- ——— forward capture from pm_notes ———

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
        'horizon', 'market resolution',
        'resolve_status', case when m.id is null then 'no_market' else 'awaiting_resolution' end
      )
    from private.pm_note_scoreable_decisions(new) d
    left join lateral (
      select id from public.pm_markets where slug = d.instrument order by created_at limit 1
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

create or replace function private.decision_candidates_on_price()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.resolve_marked_decisions();
  exception when others then
    raise warning 'decision_candidates_on_price: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.decision_candidate_from_pm_note() from public, anon, authenticated;
revoke all on function private.decision_candidates_on_price() from public, anon, authenticated;

drop trigger if exists decision_candidates_on_equity_mark on public.portfolio_exposure;
create trigger decision_candidates_on_equity_mark
  after insert on public.portfolio_exposure
  for each statement
  execute function private.decision_candidates_on_price();

drop trigger if exists decision_candidates_on_equity_fill on public.broker_fills;
create trigger decision_candidates_on_equity_fill
  after insert on public.broker_fills
  for each statement
  execute function private.decision_candidates_on_price();

drop trigger if exists decision_candidates_on_meme_fill on public.meme_fills;
create trigger decision_candidates_on_meme_fill
  after insert on public.meme_fills
  for each statement
  execute function private.decision_candidates_on_price();

drop trigger if exists decision_candidates_on_meme_token on public.meme_tokens;
create trigger decision_candidates_on_meme_token
  after update of last_price_sol, last_marked_at on public.meme_tokens
  for each statement
  execute function private.decision_candidates_on_price();

drop trigger if exists decision_candidates_on_meme_position on public.meme_positions;
create trigger decision_candidates_on_meme_position
  after update of mark_sol, mark_at on public.meme_positions
  for each statement
  execute function private.decision_candidates_on_price();

-- ——— the write stewards call ———

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

  if v_venue = 'prediction' then
    v_horizon := 'market resolution';
    if nullif(btrim(coalesce(p->>'market_id', '')), '') is not null then
      v_market := (p->>'market_id')::uuid;
    end if;
    if v_market is null then
      select id into v_market from public.pm_markets where slug = v_instrument order by created_at limit 1;
    end if;
    v_status := case when v_market is null then 'no_market' else 'awaiting_resolution' end;
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
    'resolve_status', v_status
  );
exception
  when invalid_text_representation then
    raise exception 'refusal:unscoreable: market_id is not a uuid'
      using errcode = 'P0001';
end;
$$;

comment on function public.steward_log_decision(jsonb) is
  'Log one enter or skip that can be scored later. Refuses (refusal:unscoreable) when the market, side, price, or (for prediction) probability is missing. Does not size or gate a trade. Equity resolves after 5 regular sessions, memes after 4 hours, prediction markets at resolution. No price is invented.';

revoke all on function public.steward_log_decision(jsonb) from public, anon, authenticated;
grant execute on function public.steward_log_decision(jsonb)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— repair the 19 session notes written since 2026-09-27 ———
-- Children get one row per market the note actually priced. The original row stays.

insert into public.decision_candidates (
  steward, venue, decided_at, decision, market_id, instrument, thesis_id, side,
  my_probability, book_price, edge, reason, source_table, source_id, meta
)
select 'oddsborne', 'prediction', c.decided_at, d.decision, m.id, d.instrument,
  nullif(btrim(coalesce(n.thesis_id, '')), ''), d.side,
  d.my_probability, d.book_price, d.my_probability - d.book_price,
  coalesce(d.reason, left(coalesce(n.title, ''), 280)),
  'pm_notes', n.id::text || ':' || d.instrument || ':' || d.side,
  jsonb_build_object(
    'origin', 'repair',
    'note_id', n.id,
    'note_type', n.note_type,
    'horizon', 'market resolution',
    'resolve_status', case when m.id is null then 'no_market' else 'awaiting_resolution' end
  )
from public.decision_candidates c
join public.pm_notes n on n.id::text = c.source_id
cross join lateral private.pm_note_scoreable_decisions(n) d
left join lateral (
  select id from public.pm_markets where slug = d.instrument order by created_at limit 1
) m on true
where c.source_table = 'pm_notes'
  and c.decided_at >= timestamptz '2026-09-27'
  and c.book_price is null
  and c.market_id is null
  and c.source_id not like '%:%'
on conflict (source_table, source_id) do nothing;

update public.decision_candidates c
set meta = c.meta || jsonb_build_object(
      'superseded', 'true',
      'repair', 'split',
      'child_count', (
        select count(*)::int from public.decision_candidates ch
        where ch.source_table = 'pm_notes'
          and ch.source_id like c.source_id || ':%'
      )
    ),
    updated_at = pg_catalog.now()
where c.source_table = 'pm_notes'
  and c.decided_at >= timestamptz '2026-09-27'
  and c.book_price is null
  and c.market_id is null
  and c.source_id not like '%:%'
  and exists (
    select 1 from public.decision_candidates ch
    where ch.source_table = 'pm_notes' and ch.source_id like c.source_id || ':%'
  );

-- Anything still missing a price (the session notes with no per-market probability,
-- plus any older row that never had one) is flagged. Not deleted, not counted.
update public.decision_candidates c
set meta = c.meta || jsonb_build_object(
      'unscoreable', 'true',
      'unscoreable_reason', 'missing the market, the side, or the price'
    ),
    updated_at = pg_catalog.now()
where coalesce(c.meta->>'superseded', '') <> 'true'
  and coalesce(c.meta->>'unscoreable', '') <> 'true'
  and not (
    public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, '{}'::jsonb)
    and (
      c.venue <> 'prediction'
      or c.my_probability is not null
      or c.created_at < timestamptz '2026-10-06 00:00:00+00'
    )
  );

alter table public.decision_candidates drop constraint if exists decision_candidates_must_be_scoreable;
alter table public.decision_candidates add constraint decision_candidates_must_be_scoreable
  check (
    coalesce(meta->>'superseded', '') = 'true'
    or coalesce(meta->>'unscoreable', '') = 'true'
    or (
      public.decision_is_scoreable(instrument, side, book_price, venue, '{}'::jsonb)
      and (
        venue <> 'prediction'
        or my_probability is not null
        or created_at < timestamptz '2026-10-06 00:00:00+00'
      )
    )
  );

select private.resolve_decision_candidates(null);

-- ——— scorecard: count only scoreable passes; surface the ones that cannot be scored ———

create or replace view public.v_steward_scorecard
with (security_invoker = true)
as
with stewards(steward, venue, unit, sort_order) as (
  values ('quantanamo', 'equity', 'USD', 1), ('oddsborne', 'prediction', 'USD', 2), ('bandit', 'meme', 'SOL', 3)
),
o as (
  select * from public.trade_outcomes where not is_paper
),
agg as (
  select o.steward,
    count(*)::int as trades,
    count(o.realized_pnl)::int as priced_trades,
    count(*) filter (where o.realized_pnl > 0)::int as wins,
    count(*) filter (where o.realized_pnl < 0)::int as losses,
    sum(o.realized_pnl) as realized_pnl,
    avg(o.realized_pnl) filter (where o.realized_pnl > 0) as avg_win,
    avg(o.realized_pnl) filter (where o.realized_pnl < 0) as avg_loss,
    avg(o.realized_pnl) as expectancy,
    sum(o.fees) as fees_recorded,
    count(*) filter (where o.fees is null)::int as fees_missing,
    count(*) filter (where o.realized_pnl is not null and (o.pnl_source = 'fills'
      or (o.pnl_source = 'settlement' and coalesce(o.meta->>'fills', '') ~ '^[1-9][0-9]*$')))::int as from_fills,
    count(*) filter (where o.pnl_source = 'cash_delta')::int as from_cash_delta,
    count(*) filter (where o.pnl_source = 'settlement')::int as from_settlement,
    count(*) filter (where o.pnl_source = 'manual')::int as from_manual,
    count(*) filter (where o.realized_pnl is null)::int as unpriced,
    min(o.closed_at) as first_closed_at,
    max(o.closed_at) as last_closed_at
  from o
  group by o.steward
),
qnt_marks as (
  select e.quantity, e.average_buy_price, e.last_price, e.observed_at
  from public.portfolio_exposure e
  where e.account_last4 = '7638'
    and e.observed_at = (select max(x.observed_at) from public.portfolio_exposure x where x.account_last4 = '7638')
    and e.quantity > 0
),
unreal as (
  select 'quantanamo'::text as steward,
    count(*)::int as open_positions,
    sum(q.quantity * (q.last_price - q.average_buy_price)) as unrealized_pnl,
    max(q.observed_at) as marked_at
  from qnt_marks q
  union all
  select 'oddsborne', count(*)::int, sum(p.quantity * (p.mark - p.average_cost)), max(p.mark_at)
  from public.pm_positions p where p.status = 'open'
  union all
  select 'bandit', count(*)::int, sum(p.quantity * (p.mark_sol - p.average_cost_sol)), max(p.mark_at)
  from public.meme_positions p where p.status = 'open'
),
dec as (
  select c.steward,
    count(*) filter (where c.decision = 'skip' and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta))::int as skips_logged,
    count(*) filter (where c.decision = 'skip' and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and (c.resolved_outcome is not null or c.counterfactual_pnl is not null))::int as skips_resolved,
    count(*) filter (where c.decision = 'skip' and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and c.counterfactual_pnl is not null)::int as skips_scored,
    count(*) filter (where c.decision = 'skip' and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and c.counterfactual_pnl > 0)::int as skips_would_have_won,
    sum(c.counterfactual_pnl) filter (where c.decision = 'skip'
      and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)) as skip_counterfactual_pnl,
    count(*) filter (where c.decision = 'enter' and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta))::int as enters_logged,
    avg(c.brier) filter (where public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)) as brier_mean,
    count(c.brier) filter (where public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta))::int as brier_n,
    count(*) filter (where not public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta)
      and coalesce(c.meta->>'superseded', '') <> 'true')::int as decisions_unscoreable
  from public.decision_candidates c
  group by c.steward
),
fill_fees as (
  select 'bandit'::text as steward,
    sum(f.fee_sol) as fees_from_fills,
    count(*) filter (where f.fee_sol is null)::int as fills_missing_fee
  from public.meme_fills f
)
select
  s.steward,
  s.venue,
  s.unit,
  s.sort_order,
  coalesce(a.trades, 0) as trades,
  coalesce(a.priced_trades, 0) as priced_trades,
  coalesce(a.wins, 0) as wins,
  coalesce(a.losses, 0) as losses,
  round(a.wins::numeric / nullif(a.priced_trades, 0), 4) as hit_rate,
  a.realized_pnl,
  a.avg_win,
  a.avg_loss,
  a.expectancy,
  coalesce(a.priced_trades, 0) < 10 as thin,
  a.fees_recorded,
  coalesce(a.fees_missing, 0) as fees_missing,
  coalesce(a.from_fills, 0) as from_fills,
  coalesce(a.from_cash_delta, 0) as from_cash_delta,
  coalesce(a.from_settlement, 0) as from_settlement,
  coalesce(a.from_manual, 0) as from_manual,
  coalesce(a.unpriced, 0) as unpriced,
  coalesce(a.trades, 0) - coalesce(a.from_fills, 0) as not_from_fills,
  a.first_closed_at,
  a.last_closed_at,
  coalesce(u.open_positions, 0) as open_positions,
  case when coalesce(u.open_positions, 0) = 0 then 0 else u.unrealized_pnl end as unrealized_pnl,
  u.marked_at as unrealized_marked_at,
  coalesce(d.skips_logged, 0) as skips_logged,
  coalesce(d.skips_resolved, 0) as skips_resolved,
  coalesce(d.skips_scored, 0) as skips_scored,
  coalesce(d.skips_would_have_won, 0) as skips_would_have_won,
  d.skip_counterfactual_pnl,
  coalesce(d.enters_logged, 0) as enters_logged,
  d.brier_mean,
  coalesce(d.brier_n, 0) as brier_n,
  ff.fees_from_fills,
  ff.fills_missing_fee,
  coalesce(d.decisions_unscoreable, 0) as decisions_unscoreable
from stewards s
left join agg a on a.steward = s.steward
left join unreal u on u.steward = s.steward
left join dec d on d.steward = s.steward
left join fill_fees ff on ff.steward = s.steward;

comment on view public.v_steward_scorecard is
  'Per-steward realized scorecard from trade_outcomes (live only). Skip counts include only scoreable decisions (instrument, side, price). decisions_unscoreable is the rest, excluding batch rows superseded by a per-market split. thin = priced_trades < 10. from_fills = priced from fills, or settlement with cost from venue fills. fees_from_fills = BANDIT sum(meme_fills.fee_sol).';

-- ——— watchdog sibling: unscoreable decisions, not a trading breach ———

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
  ), '{"quantanamo":0,"oddsborne":0,"bandit":0}'::jsonb) as unscoreable_decisions;

comment on view public.v_ledger_watchdog is
  'Read-only ledger counts. learning_gaps = closed lots past the grace with no lesson. unscoreable_decisions = enter/skip rows that cannot be scored (no market, side, or price), per steward. Neither is a trading breach; neither makes /api/health not-ok.';

grant select on public.v_ledger_watchdog
  to authenticated, quantanamo_worker, desk_public_reader, service_role;
