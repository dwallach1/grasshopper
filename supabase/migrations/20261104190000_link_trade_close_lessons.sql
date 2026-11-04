-- Link a trade_close_lesson belief to the research lesson written for the same close.
--
-- QUANTANAMO writes the two rows separately: a research_lessons row (invalidation,
-- partial_close, or trade_close_lesson) and a belief_updates row from
-- steward_close_lesson. Nothing put the lesson id on the belief, so a close that
-- already moved confidence still looked like an open lesson.
--
-- 1. steward_close_lesson can write both in one call (lesson_summary + lesson_type +
--    cycle_id) or stamp a research_lesson_id the caller already has. Otherwise it
--    links the one lesson that matches. dry_run still writes nothing.
-- 2. Stewards that keep writing the two rows separately are linked by a trigger:
--    same thesis, the lot's symbol mentioned in the lesson, created within 10 minutes.
--    Two lessons or two beliefs in that window stay unlinked.
-- 3. The same rule backfills rows already on the ledger.
--
-- Confidence, sizing, and the loss clamp are unchanged. The link is meta.research_lesson_id
-- only. gate_outcome, outcome_rescore, belief_check, and autopsy_score are not touched.

-- ---------------------------------------------------------------- 1. match
create or replace function private.lesson_mentions_symbol(p_summary text, p_symbol text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_summary is not null
    and btrim(coalesce(p_symbol, '')) ~ '^[A-Za-z0-9][A-Za-z0-9-]{1,63}$'
    and p_summary ~ (
      '(^|[^A-Za-z0-9])'
      || btrim(p_symbol)
      || '([^A-Za-z0-9]|$)'
    );
$$;

comment on function private.lesson_mentions_symbol(text, text) is
  'True when the lesson names the lot symbol as its own token. Case-sensitive. A symbol with regex punctuation does not match.';

revoke all on function private.lesson_mentions_symbol(text, text) from public, anon, authenticated;
grant execute on function private.lesson_mentions_symbol(text, text)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create or replace function private.close_lot_symbol(p_meta jsonb)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with lot as (
    select case
      when coalesce(p_meta->>'lot_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (p_meta->>'lot_id')::uuid
      else null
    end as id
  )
  select coalesce(
    case
      when btrim(coalesce(p_meta->>'symbol', '')) ~ '^[A-Za-z0-9][A-Za-z0-9-]{1,63}$'
        then btrim(p_meta->>'symbol')
      else null
    end,
    case p_meta->>'lot_table'
      when 'position_episodes' then (
        select pe.symbol
        from public.position_episodes pe
        cross join lot
        where pe.id = lot.id
      )
      when 'meme_positions' then (
        select t.symbol
        from public.meme_positions mp
        join public.meme_tokens t on t.id = mp.token_id
        cross join lot
        where mp.id = lot.id
      )
      when 'pm_positions' then (
        select coalesce(nullif(btrim(m.slug), ''), nullif(btrim(p.outcome), ''))
        from public.pm_positions p
        left join public.pm_markets m on m.id = p.market_id
        cross join lot
        where p.id = lot.id
      )
      else null
    end
  );
$$;

comment on function private.close_lot_symbol(jsonb) is
  'Symbol for a close-lesson belief: meta.symbol, else the lot named by meta.lot_table and meta.lot_id. Null when the id is not a uuid.';

revoke all on function private.close_lot_symbol(jsonb) from public, anon, authenticated;
grant execute on function private.close_lot_symbol(jsonb)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create or replace function private.match_trade_close_lesson(
  p_thesis text,
  p_at timestamptz,
  p_symbol text,
  p_belief_id uuid
) returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  with lesson_hits as (
    select l.id, l.created_at, l.summary
    from public.research_lessons l
    where l.thesis_id = p_thesis
      and p_at is not null
      and private.lesson_mentions_symbol(l.summary, p_symbol)
      and abs(extract(epoch from (l.created_at - p_at))) <= 600
  ),
  only_lesson as (
    select id, created_at, summary
    from lesson_hits
    where (select count(*) from lesson_hits) = 1
  )
  select ol.id
  from only_lesson ol
  where not exists (
    select 1
    from public.belief_updates b
    where b.id is distinct from p_belief_id
      and b.thesis_id = p_thesis
      and coalesce(b.meta->>'kind', '') = 'trade_close_lesson'
      and nullif(b.meta->>'research_lesson_id', '') is null
      and abs(extract(epoch from (coalesce(b.observed_at, b.created_at) - ol.created_at))) <= 600
      and private.lesson_mentions_symbol(ol.summary, private.close_lot_symbol(b.meta))
  )
  and not exists (
    select 1
    from public.belief_updates b
    where b.id is distinct from p_belief_id
      and coalesce(b.meta->>'kind', '') = 'trade_close_lesson'
      and b.meta->>'research_lesson_id' = ol.id::text
  );
$$;

comment on function private.match_trade_close_lesson(text, timestamptz, text, uuid) is
  'The one research lesson for this close, or null. Same thesis, the symbol as its own token, and created within 10 minutes. Null when zero or several lessons match, or another unlinked close belief matches that lesson. Does not write.';

revoke all on function private.match_trade_close_lesson(text, timestamptz, text, uuid) from public, anon, authenticated;
grant execute on function private.match_trade_close_lesson(text, timestamptz, text, uuid)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create or replace function private.match_belief_for_lesson(p_lesson_id bigint)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  with hits as (
    select b.id
    from public.belief_updates b
    join public.research_lessons l on l.id = p_lesson_id
    where b.thesis_id = l.thesis_id
      and coalesce(b.meta->>'kind', '') = 'trade_close_lesson'
      and nullif(b.meta->>'research_lesson_id', '') is null
      and private.match_trade_close_lesson(
        b.thesis_id,
        coalesce(b.observed_at, b.created_at),
        private.close_lot_symbol(b.meta),
        b.id
      ) = p_lesson_id
  )
  select id from hits where (select count(*) from hits) = 1;
$$;

comment on function private.match_belief_for_lesson(bigint) is
  'The one unlinked trade_close_lesson belief this lesson matches, or null. Used when the lesson is written after the belief.';

revoke all on function private.match_belief_for_lesson(bigint) from public, anon, authenticated;
grant execute on function private.match_belief_for_lesson(bigint)
  to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- Workers can insert belief_updates but cannot update them. The link on a lesson
-- that arrives second has to update meta, so this trigger runs as its owner.
-- It lives in private (not exposed) and only fills a null research_lesson_id.
create or replace function private.link_trade_close_lesson()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lesson bigint;
  v_belief uuid;
begin
  if tg_table_name = 'belief_updates' then
    if coalesce(new.meta->>'kind', '') <> 'trade_close_lesson' then
      return new;
    end if;
    if nullif(new.meta->>'research_lesson_id', '') is not null then
      return new;
    end if;
    v_lesson := private.match_trade_close_lesson(
      new.thesis_id,
      coalesce(new.observed_at, new.created_at, now()),
      private.close_lot_symbol(new.meta),
      new.id
    );
    if v_lesson is not null then
      new.meta := coalesce(new.meta, '{}'::jsonb)
        || jsonb_build_object('research_lesson_id', v_lesson);
    end if;
    return new;
  end if;

  if tg_table_name = 'research_lessons' and tg_op = 'INSERT' then
    v_belief := private.match_belief_for_lesson(new.id);
    if v_belief is not null then
      update public.belief_updates b
         set meta = coalesce(b.meta, '{}'::jsonb)
           || jsonb_build_object('research_lesson_id', new.id)
       where b.id = v_belief
         and coalesce(b.meta->>'kind', '') = 'trade_close_lesson'
         and nullif(b.meta->>'research_lesson_id', '') is null;
    end if;
  end if;
  return new;
end;
$$;

comment on function private.link_trade_close_lesson() is
  'BEFORE a trade_close_lesson belief, or AFTER a research lesson: set meta.research_lesson_id when exactly one close matches. Does not change confidence. Private security definer because lesson-after-belief must update a row the worker cannot update.';

revoke all on function private.link_trade_close_lesson() from public, anon, authenticated;

drop trigger if exists belief_updates_link_trade_close_lesson on public.belief_updates;
create trigger belief_updates_link_trade_close_lesson
  before insert on public.belief_updates
  for each row
  execute function private.link_trade_close_lesson();

drop trigger if exists research_lessons_link_trade_close_lesson on public.research_lessons;
create trigger research_lessons_link_trade_close_lesson
  after insert on public.research_lessons
  for each row
  execute function private.link_trade_close_lesson();

create unique index if not exists belief_updates_trade_close_lesson_idx
  on public.belief_updates ((meta->>'research_lesson_id'))
  where coalesce(meta->>'kind', '') = 'trade_close_lesson'
    and nullif(meta->>'research_lesson_id', '') is not null;

-- ---------------------------------------------------------------- 2. one call, or the match, inside steward_close_lesson
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
begin
  if current_user::text like '%\_worker' then
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
                              'symbol', v_symbol);
  end if;
  if v_lesson_summary is not null then
    insert into public.research_lessons (
      cycle_id, thesis_id, lesson_type, summary, incorporated, created_at
    ) values (
      v_cycle, v_thesis, v_lesson_type, v_lesson_summary, false, now()
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
  'Close lesson for a steward lot. Moves confidence from the ledger and, for trade_close_lesson, stamps meta.research_lesson_id from the lesson written in this call or the one lesson within 10 minutes. dry_run writes nothing. A losing close cannot raise confidence.';

revoke all on function public.steward_close_lesson(jsonb) from public, anon, authenticated;
grant execute on function public.steward_close_lesson(jsonb) to quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ---------------------------------------------------------------- 3. backfill
-- Same conservative match. Ambiguous closes stay null.
update public.belief_updates b
   set meta = b.meta || jsonb_build_object('research_lesson_id', matched.lesson_id)
  from (
    select b2.id,
           private.match_trade_close_lesson(
             b2.thesis_id,
             coalesce(b2.observed_at, b2.created_at),
             private.close_lot_symbol(b2.meta),
             b2.id
           ) as lesson_id
    from public.belief_updates b2
    where coalesce(b2.meta->>'kind', '') = 'trade_close_lesson'
      and nullif(b2.meta->>'research_lesson_id', '') is null
  ) matched
 where b.id = matched.id
   and matched.lesson_id is not null;
