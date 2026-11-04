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
