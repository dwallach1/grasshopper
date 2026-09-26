-- Shadow (paper) exit tracking, generic across stewards (2026-09-26).
-- No new store: stewards already record a hypothetical exit per closed lot under a
-- meta key prefixed `paper_` on their own lot table (BANDIT: meme_positions.meta.paper_bank20,
-- backfilled for goon / familiars / COLLECT / YAP). Contract for each `meta.paper_<name>` object:
--   rule            text     rule id, e.g. 'bank_at_+20pct' (required)
--   triggered       boolean  did the rule fire before the real exit
--   trigger_minute  int      minutes after entry when it fired (null if not)
--   paper_exit_pct  numeric  paper exit return vs entry, % (required); = real_exit_pct if not triggered
--   real_exit_pct   numeric  real exit return vs entry on the same mark basis, % (required)
--   delta_pct_pts   numeric  paper - real, percentage points (computed if absent)
--   source, note    text     mark basis (e.g. '5min venue marks')
-- Numbers may be JSON numbers or numeric strings. Works for meme_positions, pm_positions and
-- position_episodes, so ODDSBORNE and QUANTANAMO can use the same keys.
--
--   public.v_shadow_exits           one row per closed lot x rule
--   public.v_shadow_exit_scorecard  per steward x rule: n, wins, mean / LCB of delta, promotable
-- A rule is promotable when n >= 10 closed lots and the LCB (mean - sd/sqrt(n)) of
-- paper - real is > 0, the same bar the edge-scaled cap uses. Measurement only; nothing acts on it.

create or replace function private.jsonb_num(p jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p is null or jsonb_typeof(p) = 'null' then null
    when jsonb_typeof(p) = 'number' then (p #>> '{}')::numeric
    when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^\s*[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?\s*$'
      then btrim(p #>> '{}')::numeric
    else null
  end;
$$;

grant execute on function private.jsonb_num(jsonb)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;

create or replace view public.v_shadow_exits
with (security_invoker = true)
as
with lots as (
  select 'bandit'::text as steward, 'meme_positions'::text as lot_table, p.id as lot_id,
         coalesce(t.symbol, p.meta->>'symbol', t.mint) as instrument, p.thesis_id, p.closed_at, p.meta
  from public.meme_positions p
  left join public.meme_tokens t on t.id = p.token_id
  where p.status = 'closed'
  union all
  select 'oddsborne', 'pm_positions', p.id, coalesce(m.slug, p.market_id::text) || ' ' || p.outcome,
         p.thesis_id, p.closed_at, p.meta
  from public.pm_positions p
  left join public.pm_markets m on m.id = p.market_id
  where p.status = 'closed'
  union all
  select 'quantanamo', 'position_episodes', e.id, e.symbol, e.thesis_id, e.closed_at, e.meta
  from public.position_episodes e
  where e.status = 'closed'
),
shadows as (
  select l.*, kv.key as meta_key, kv.value as v
  from lots l
  cross join lateral jsonb_each(coalesce(l.meta, '{}'::jsonb)) kv
  where kv.key like 'paper\_%'
    and jsonb_typeof(kv.value) = 'object'
    and kv.value ? 'rule'
)
select s.steward, s.lot_table, s.lot_id, s.instrument, s.thesis_id, s.closed_at,
       s.meta_key,
       s.v->>'rule' as rule,
       case when jsonb_typeof(s.v->'triggered') = 'boolean' then (s.v->>'triggered')::boolean end as triggered,
       private.jsonb_num(s.v->'trigger_minute')::int as trigger_minute,
       private.jsonb_num(s.v->'paper_exit_pct') as paper_exit_pct,
       private.jsonb_num(s.v->'real_exit_pct') as real_exit_pct,
       coalesce(private.jsonb_num(s.v->'delta_pct_pts'),
                private.jsonb_num(s.v->'paper_exit_pct') - private.jsonb_num(s.v->'real_exit_pct')) as delta_pct_pts,
       round(o.realized_pnl / nullif(o.cost, 0) * 100, 2) as real_fill_return_pct,
       o.unit,
       s.v->>'source' as source,
       s.v->>'note' as note
from shadows s
left join public.trade_outcomes o
  on o.source_table = s.lot_table and o.source_id = s.lot_id::text and not o.is_paper;

create or replace view public.v_shadow_exit_scorecard
with (security_invoker = true)
as
select steward, rule,
       count(*)::int as n,
       count(*) filter (where triggered)::int as triggered_n,
       count(*) filter (where delta_pct_pts > 0)::int as paper_better,
       count(*) filter (where delta_pct_pts < 0)::int as paper_worse,
       round(avg(real_exit_pct), 2) as mean_real_exit_pct,
       round(avg(paper_exit_pct), 2) as mean_paper_exit_pct,
       round(avg(delta_pct_pts), 2) as mean_delta_pct_pts,
       round(stddev_samp(delta_pct_pts), 2) as sd_delta_pct_pts,
       round(avg(delta_pct_pts) - stddev_samp(delta_pct_pts) / sqrt(count(*)::numeric), 2) as lcb_delta_pct_pts,
       greatest(0, 10 - count(*))::int as clips_to_decide,
       (count(*) >= 10
         and avg(delta_pct_pts) - stddev_samp(delta_pct_pts) / sqrt(count(*)::numeric) > 0) as promotable,
       max(closed_at) as last_closed_at
from public.v_shadow_exits
where delta_pct_pts is not null
group by steward, rule;

grant select on public.v_shadow_exits, public.v_shadow_exit_scorecard
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;
