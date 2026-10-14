-- Gate report card: a scored skip becomes a percent return, a gate key, and a verdict.
--
-- counterfactual_pnl is the later mark minus the decision price, one unit, with the short
-- side flipped (steward_record_decision_mark / the resolvers). That is not comparable:
-- a meme token's move is a fraction of a SOL, a share's is dollars, a contract's is
-- the payoff minus the price. public.decision_outcome_pct is that same move divided by
-- the price of the side that was skipped. Prediction NO rows logged in YES terms are
-- converted with decision_in_side_terms first, so the denominator is what the side cost.
-- A missing mark stays null. Nothing here invents a price.
--
-- ODDSBORNE skips often have no meta.blocked_by. public.decision_gate_key keeps a
-- blocked_by that was written, and otherwise derives a stable key from the reason.
-- Anything it cannot name is 'unlabeled' and is still counted.
--
-- A gate says protecting or costing growth only when a two-sided 95% Student-t
-- interval on the mean percent excludes zero. That is the same test for a binary
-- contract (about -100% or a large plus) and for a share or a token (a small
-- percent). Below that, or with fewer than two scored skips, the verdict is
-- 'too few to tell'. Positive mean: the passes would have made money, so the gate
-- is costing growth. Negative mean: they would have lost, so the gate is protecting
-- the book. Beliefs record that evidence. They do not loosen or tighten any rule.
--
-- morning_rollup and afternoon_rollup are where a row was copied from, not a rule.
-- decision_gate_key ignores them. A repaired row carries the gate the note names.
--
-- No skip row stores a bet size (no stake / notional / size_sol). v_thesis_max_stake is
-- the entry cap, not a size the skip would have used, so at_stake_pnl stays null until
-- a row actually carries one. The desk then shows percent only.

create or replace function public.decision_stored_mark(p_meta jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_meta->>'mark_price', '') ~ '^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$'
      then (p_meta->>'mark_price')::numeric
    else null
  end;
$$;

comment on function public.decision_stored_mark(jsonb) is
  'The horizon price already stored on the decision (meta.mark_price). Null when that key is missing or not a number. Does not read a fresh quote.';

create or replace function public.decision_logged_stake(p_meta jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when s.raw ~ '^[0-9]+(\.[0-9]+)?$' and s.raw::numeric > 0 then s.raw::numeric
    else null
  end
  from (
    select coalesce(
      nullif(btrim(coalesce(p_meta->>'stake', '')), ''),
      nullif(btrim(coalesce(p_meta->>'notional', '')), ''),
      nullif(btrim(coalesce(p_meta->>'size_sol', '')), ''),
      nullif(btrim(coalesce(p_meta->>'size_usd', '')), '')
    ) as raw
  ) s;
$$;

comment on function public.decision_logged_stake(jsonb) is
  'A bet size the decision itself stored (stake, notional, size_sol, size_usd). Null when none was logged. Does not substitute the starter or the thesis cap.';

create or replace function public.decision_outcome_pct(
  p_venue text,
  p_side text,
  p_book_price numeric,
  p_mark numeric,
  p_outcome text,
  p_meta jsonb
) returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_venue = 'prediction' then
      case
        when lower(coalesce(p_outcome, '')) in ('yes', 'no')
         and lower(coalesce(p_side, '')) in ('yes', 'no')
         and s.px is not null and s.px > 0
        then (((lower(p_outcome) = lower(p_side))::integer)::numeric - s.px) / s.px
      end
    when p_book_price is null or p_book_price <= 0 or p_mark is null or p_mark <= 0 then null
    when lower(coalesce(p_side, '')) = 'short' then (p_book_price - p_mark) / p_book_price
    when lower(coalesce(p_side, '')) = 'long' then (p_mark - p_book_price) / p_book_price
    else null
  end
  from (
    select public.decision_in_side_terms(p_side, p_book_price, coalesce(p_meta, '{}'::jsonb)) as px
  ) s;
$$;

comment on function public.decision_outcome_pct(text, text, numeric, numeric, text, jsonb) is
  'Signed fraction from the decision price to the mark, for the side that was named. Long: (mark - book) / book. Short: (book - mark) / book. Prediction: (1 or 0 - the side''s own price) / that price, after decision_in_side_terms, so a NO logged in YES terms is not divided by the YES price. Null without a real mark or a yes/no resolution. A meme token uses the same fraction, so a per-token SOL difference becomes a percent.';

create or replace function public.decision_gate_key(p_steward text, p_reason text, p_meta jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when g.given is not null then g.given
    when lower(coalesce(p_steward, '')) = 'oddsborne' then
      case
        when coalesce(p_reason, '') ~* '^wx pass'
          or coalesce(p_meta->>'pattern', '') = 'fav_vs_forecast' then 'weather_forecast_gate'
        when coalesce(p_reason, '') ~* 'same_game|same game' then 'same_game'
        when coalesce(p_reason, '') ~* 'guidance_cap' then 'guidance_cap'
        when coalesce(p_reason, '') ~* 'not_live' then 'not_live'
        when coalesce(p_reason, '') ~* 'not_placed|not placed|skip forced|pm_enter.{0,40}timeout|db timeout' then 'not_placed'
        when coalesce(p_reason, '') ~* 'cancelled resting' then 'cancelled_resting'
        when coalesce(p_reason, '') ~* 'no two-way|devig fail|methods disagree' then 'devig_gate'
        when coalesce(p_reason, '') ~* 'not a real positive edge|no real post-fee edge|no clear post-fee edge|under the [0-9]+[[:space:]]*c bar|edge under|thin after-spread edge|after spread edge thin|edge after .{0,80} not enough|thin edge|post-fee|makerΔ|bovada fair|^fair | pass:|^pm |fair=' then 'edge_below_gate'
        else 'unlabeled'
      end
    else 'unlabeled'
  end
  from (
    select case
      when nullif(btrim(coalesce(p_meta->>'blocked_by', '')), '') in ('morning_rollup', 'afternoon_rollup') then null
      else nullif(btrim(coalesce(p_meta->>'blocked_by', '')), '')
    end as given
  ) g;
$$;

comment on function public.decision_gate_key(text, text, jsonb) is
  'Gate that blocked a skip. A written meta.blocked_by wins, except morning_rollup and afternoon_rollup, which name the note a row was copied from. ODDSBORNE reasons otherwise derive edge_below_gate, devig_gate, weather_forecast_gate, same_game, not_placed, and the entry locks. Unknown stays unlabeled and is counted.';

-- The blocking rule named by one ODDSBORNE note for one market. The edge is the note's
-- own post-fee number (comps_top.post_fee_maker, else candidates.maker). A phrase on
-- that market's line wins over a tiny positive number. A multi-market note does not
-- lend another market's sentence. No price is invented.

create or replace function public.oddsborne_note_blocking_gate(p_body text, p_meta jsonb, p_instrument text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_edge numeric;
  v_line text;
  v_multi boolean;
  v_elem jsonb;
begin
  v_multi := jsonb_typeof(p_meta->'comps') = 'array'
    or jsonb_typeof(p_meta->'comps_top') = 'array'
    or jsonb_typeof(p_meta->'candidates') = 'array';

  if jsonb_typeof(p_meta->'comps_top') = 'array' then
    for v_elem in select value from jsonb_array_elements(p_meta->'comps_top') loop
      exit when v_edge is not null;
      if coalesce(v_elem->>'market', '') = p_instrument
         and coalesce(v_elem->>'post_fee_maker', '') ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' then
        v_edge := (v_elem->>'post_fee_maker')::numeric;
      end if;
    end loop;
  end if;
  if v_edge is null and jsonb_typeof(p_meta->'candidates') = 'array' then
    for v_elem in select value from jsonb_array_elements(p_meta->'candidates') loop
      exit when v_edge is not null;
      if coalesce(v_elem->>'slug', '') = p_instrument
         and coalesce(v_elem->>'maker', '') ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' then
        v_edge := (v_elem->>'maker')::numeric;
      end if;
    end loop;
  end if;

  -- A multi-market note may only use the line that names this market, so one
  -- market cannot borrow another's sentence. A single-market note is all about
  -- this skip, including a reason that sits on the line after the slug.
  if v_multi then
    if p_body is not null and p_instrument is not null and position(p_instrument in p_body) > 0 then
      select line into v_line
      from regexp_split_to_table(p_body, E'\n') as line
      where position(p_instrument in line) > 0
      limit 1;
    end if;
  else
    v_line := p_body;
  end if;

  if coalesce(v_line, '') ~* 'not a real positive edge|no real post-fee edge|no clear post-fee edge|under the [0-9]+[[:space:]]*c bar|edge under|thin after-spread edge|after spread edge thin|edge after .{0,80} not enough|thin edge'
     or (v_edge is not null and v_edge < 0) then
    return jsonb_build_object(
      'gate', 'edge_below_gate',
      'edge', v_edge,
      'why', coalesce(v_line, format('post-fee edge %s is under the minimum', v_edge))
    );
  end if;

  if coalesce(v_line, '') ~* 'pm_enter.{0,40}timeout|db timeout|not_placed|not placed|skip forced'
     and (v_edge is null or v_edge > 0) then
    return jsonb_build_object('gate', 'not_placed', 'edge', v_edge, 'why', v_line);
  end if;

  return jsonb_build_object('gate', 'unlabeled', 'edge', to_jsonb(v_edge), 'why', null);
end;
$$;

comment on function public.oddsborne_note_blocking_gate(text, jsonb, text) is
  'Blocking gate for one market in an ODDSBORNE note: edge_below_gate, not_placed, or unlabeled. Uses the note body and the stored post-fee edge. Does not invent a price or change a rule.';

-- Two-sided 95% Student-t critical value. df 1..30 is the table (4 d.p.). Above that,
-- a Cornish-Fisher expansion. Same coefficients as the desk twin.

create or replace function public.student_t_crit_95(p_df integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_df is null or p_df < 1 then null::numeric
    when p_df <= 30 then (
      array[
        12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.3060, 2.2622, 2.2281,
        2.2010, 2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.0930, 2.0860,
        2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423
      ]::numeric[]
    )[p_df]
    else
      1.959963984540054
      + 2.372271230298562 / p_df::numeric
      + 2.822498615739611 / (p_df::numeric ^ 2)
      + 2.555849679507722 / (p_df::numeric ^ 3)
      + 1.589534053393822 / (p_df::numeric ^ 4)
  end;
$$;

comment on function public.student_t_crit_95(integer) is
  'Critical value for a two-sided 95% Student-t interval. Null when df < 1.';

create or replace function public.gate_outcome_verdict(p_scored integer, p_mean numeric, p_sd numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_scored is null or p_scored < 2 or p_mean is null or p_mean = 0 or p_sd is null or p_sd < 0
      then 'too few to tell'
    when p_sd = 0 then
      case when p_mean > 0 then 'costing growth' else 'protecting' end
    when abs(p_mean) > public.student_t_crit_95(p_scored - 1) * p_sd / sqrt(p_scored::numeric) then
      case when p_mean > 0 then 'costing growth' else 'protecting' end
    else 'too few to tell'
  end;
$$;

comment on function public.gate_outcome_verdict(integer, numeric, numeric) is
  'protecting or costing growth only when a two-sided 95% Student-t interval on the mean percent excludes zero. Same rule for a binary contract and a share or token. Otherwise too few to tell. Does not change a rule.';

-- How many further scored skips would clear the interval if this mean and spread held.
-- Null when two scored rows still would not settle it within 500 more (the average is
-- close to a scratch). Zero when the interval already excludes zero.

create or replace function public.gate_more_needed(p_scored integer, p_mean numeric, p_sd numeric)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  n integer;
  v_cap integer;
  v_crit numeric;
begin
  if p_scored is null or p_scored < 2 or p_mean is null or p_mean = 0 or p_sd is null or p_sd < 0 then
    return null;
  end if;
  if p_sd = 0 then
    return 0;
  end if;
  v_crit := public.student_t_crit_95(p_scored - 1);
  if abs(p_mean) > v_crit * p_sd / sqrt(p_scored::numeric) then
    return 0;
  end if;
  v_cap := p_scored + 500;
  -- (1.96 * sd / |mean|)^2 > cap, written as products so a tiny mean does not overflow.
  if (v_cap::numeric * p_mean * p_mean) < (1.96 * p_sd) * (1.96 * p_sd) then
    return null;
  end if;
  n := p_scored + 1;
  while n <= v_cap loop
    v_crit := public.student_t_crit_95(n - 1);
    if abs(p_mean) > v_crit * p_sd / sqrt(n::numeric) then
      return n - p_scored;
    end if;
    n := n + 1;
  end loop;
  return null;
end;
$$;

comment on function public.gate_more_needed(integer, numeric, numeric) is
  'Further scored skips that would make the 95% interval exclude zero if the current mean and spread held. Null when that would take more than 500, or when there is nothing to extrapolate. Zero when it already excludes zero.';

create or replace function public.gate_belief_due(p_latest text, p_scored integer, p_verdict text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_latest = 'superseded' then false
    when p_verdict in ('protecting', 'costing growth') and p_latest is distinct from p_verdict then true
    when p_verdict = 'too few to tell' and p_latest in ('protecting', 'costing growth') then true
    else false
  end;
$$;

comment on function public.gate_belief_due(text, integer, text) is
  'True when a protecting or costing-growth verdict is not already the latest belief, or when that lesson has to be taken back because the interval now includes a scratch. p_scored is unused; the verdict already applied the interval. A re-run with the same verdict is false. superseded is left as history. too few to tell does not write a first belief.';

revoke all on function public.decision_stored_mark(jsonb) from public, anon;
revoke all on function public.decision_logged_stake(jsonb) from public, anon;
revoke all on function public.decision_outcome_pct(text, text, numeric, numeric, text, jsonb) from public, anon;
revoke all on function public.decision_gate_key(text, text, jsonb) from public, anon;
revoke all on function public.oddsborne_note_blocking_gate(text, jsonb, text) from public, anon;
revoke all on function public.student_t_crit_95(integer) from public, anon;
revoke all on function public.gate_outcome_verdict(integer, numeric, numeric) from public, anon;
revoke all on function public.gate_more_needed(integer, numeric, numeric) from public, anon;
revoke all on function public.gate_belief_due(text, integer, text) from public, anon;

grant execute on function public.decision_stored_mark(jsonb),
  public.decision_logged_stake(jsonb),
  public.decision_outcome_pct(text, text, numeric, numeric, text, jsonb),
  public.decision_gate_key(text, text, jsonb),
  public.oddsborne_note_blocking_gate(text, jsonb, text),
  public.student_t_crit_95(integer),
  public.gate_outcome_verdict(integer, numeric, numeric),
  public.gate_more_needed(integer, numeric, numeric),
  public.gate_belief_due(text, integer, text)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— the card ———

create or replace view public.v_gate_report
with (security_invoker = true)
as
with skips as (
  select
    c.steward,
    public.decision_gate_key(c.steward, c.reason, c.meta) as gate,
    c.thesis_id,
    public.decision_outcome_pct(
      c.venue,
      c.side,
      c.book_price,
      public.decision_stored_mark(c.meta),
      c.resolved_outcome,
      c.meta
    ) as outcome_pct,
    public.decision_logged_stake(c.meta) as stake
  from public.decision_candidates c
  where c.decision = 'skip'
    and coalesce(c.meta->>'superseded', '') <> 'true'
),
rolled as (
  select
    steward,
    gate,
    count(*)::integer as skips,
    count(outcome_pct)::integer as scored,
    count(*) filter (where outcome_pct > 0)::integer as would_have_won,
    case when count(outcome_pct) > 0
      then count(*) filter (where outcome_pct > 0)::numeric / count(outcome_pct)
    end as would_have_won_rate,
    avg(outcome_pct) as mean_outcome_pct,
    stddev_samp(outcome_pct) as sd_outcome_pct,
    case
      when count(outcome_pct) > 0
       and count(outcome_pct) = count(*) filter (where outcome_pct is not null and stake is not null)
      then sum(outcome_pct * stake) filter (where outcome_pct is not null and stake is not null)
    end as at_stake_pnl,
    case when steward = 'bandit' then 'SOL' else 'USD' end as unit
  from skips
  group by steward, gate
)
select
  r.steward,
  r.gate,
  r.skips,
  r.scored,
  r.would_have_won,
  r.would_have_won_rate,
  r.mean_outcome_pct,
  public.gate_outcome_verdict(r.scored, r.mean_outcome_pct, r.sd_outcome_pct) as verdict,
  th.thesis_id,
  r.at_stake_pnl,
  r.unit,
  r.sd_outcome_pct,
  public.gate_more_needed(r.scored, r.mean_outcome_pct, r.sd_outcome_pct) as more_needed
from rolled r
left join lateral (
  select s.thesis_id
  from skips s
  join public.theses t on t.id = s.thesis_id
  where s.steward = r.steward
    and s.gate = r.gate
  group by s.thesis_id
  order by count(*) desc, s.thesis_id
  limit 1
) th on true;

comment on view public.v_gate_report is
  'Per steward, per gate, skips only (superseded rows left out). scored and the mean are percent returns from a stored mark, signed for the skipped side. sd_outcome_pct is the sample spread of those percents. verdict is protecting or costing growth only when a 95% Student-t interval on the mean excludes zero, otherwise too few to tell. more_needed is how many further scored skips would settle it if the average held, or null when the average is close to a scratch. thesis_id is the thesis most of that gate''s skips already name, when that thesis exists. at_stake_pnl is the percent times a size the row stored; null when the ledger has no size. Measurement only.';

revoke all on public.v_gate_report from public, anon;
grant select on public.v_gate_report
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- The two-argument verdict (scored >= 8) is replaced by the interval, now that the view
-- calls the three-argument form.
drop function if exists public.gate_outcome_verdict(integer, numeric);

create or replace function public.gate_report()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select jsonb_agg(to_jsonb(r) order by r.steward, r.scored desc, r.skips desc, r.gate)
    from public.v_gate_report r
  ), '[]'::jsonb);
$$;

comment on function public.gate_report() is
  'Read-only gate report card (the rows of v_gate_report). Does not score, size, or change a rule.';

revoke all on function public.gate_report() from public, anon;
grant execute on function public.gate_report()
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

-- ——— beliefs: one row when the interval first clears, the verdict flips, or a lesson is taken back ———

create index if not exists belief_updates_gate_outcome_idx
  on public.belief_updates ((meta->>'steward'), (meta->>'gate'), observed_at desc)
  where meta->>'kind' = 'gate_outcome';

create or replace function private.record_gate_outcome_beliefs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_latest text;
  v_latest_id uuid;
  v_name text;
  v_phrase text;
  v_lead text;
  v_was text;
  v_why text;
  v_pct text;
  v_written integer := 0;
  v_skipped integer := 0;
begin
  for r in
    select g.*, b.verdict as latest_verdict, b.id as latest_id
    from public.v_gate_report g
    left join lateral (
      select b.id, b.meta->>'verdict' as verdict
      from public.belief_updates b
      where b.meta->>'kind' = 'gate_outcome'
        and b.meta->>'steward' = g.steward
        and b.meta->>'gate' = g.gate
      order by b.observed_at desc, b.id desc
      limit 1
    ) b on true
    where public.gate_belief_due(b.verdict, g.scored, g.verdict)
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('gate_outcome:' || r.steward || ':' || r.gate, 0)
    );
    select b.meta->>'verdict', b.id into v_latest, v_latest_id
    from public.belief_updates b
    where b.meta->>'kind' = 'gate_outcome'
      and b.meta->>'steward' = r.steward
      and b.meta->>'gate' = r.gate
    order by b.observed_at desc, b.id desc
    limit 1;
    if not public.gate_belief_due(v_latest, r.scored, r.verdict) then
      continue;
    end if;
    if r.thesis_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_name := case r.steward
      when 'quantanamo' then 'QUANTANAMO'
      when 'oddsborne' then 'ODDSBORNE'
      when 'bandit' then 'BANDIT'
      else upper(r.steward)
    end;
    v_phrase := case r.gate
      when 'edge_below_gate' then 'the edge minimum'
      when 'weather_forecast_gate' then 'the weather forecast'
      when 'thesis_paused' then 'a paused thesis'
      when 'quality_drawdown_fail' then 'quality and drawdown'
      when '1h_cap_30' then 'the one-hour rise cap'
      when 'not_placed' then 'an order that never went out'
      when 'unlabeled' then 'no named rule'
      when 'cancelled_resting' then 'a cancelled resting order'
      when 'devig_gate' then 'the de-vig check'
      when 'same_game' then 'a second bet on the same game'
      when 'screen_fail' then 'the screen'
      when 'paper_only' then 'paper only'
      when 'guidance_cap' then 'the size cap'
      when 'not_live' then 'a dry run'
      else replace(r.gate, '_', ' ')
    end;
    v_lead := upper(left(v_phrase, 1)) || substr(v_phrase, 2);
    v_pct := case when r.mean_outcome_pct > 0 then '+' else '' end
      || pg_catalog.btrim(pg_catalog.to_char(pg_catalog.round(r.mean_outcome_pct * 100, 1), '999990.0'));
    if r.verdict = 'too few to tell' then
      if r.more_needed is not null and r.more_needed > 0 then
        v_why := format(
          'About %s more scored trades would be needed before that lesson would hold, if the average stayed put.',
          r.more_needed
        );
      else
        v_why := 'The spread of the scored skips still includes a scratch, so more of the same would not settle it soon.';
      end if;
      v_was := case v_latest
        when 'protecting' then 'protecting the book'
        when 'costing growth' then 'costing growth'
        else coalesce(v_latest, 'settled')
      end;
      insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
      values (
        r.thesis_id,
        null,
        null,
        format(
          'The earlier lesson that %s was %s does not hold. %s The rule was not changed.',
          v_phrase, v_was, v_why
        ),
        pg_catalog.now(),
        jsonb_strip_nulls(jsonb_build_object(
          'kind', 'gate_outcome',
          'steward', r.steward,
          'gate', r.gate,
          'verdict', r.verdict,
          'skips', r.skips,
          'scored', r.scored,
          'would_have_won', r.would_have_won,
          'mean_outcome_pct', r.mean_outcome_pct,
          'sd_outcome_pct', r.sd_outcome_pct,
          'more_needed', r.more_needed,
          'method', 'student_t_95',
          'rule_changed', false,
          'supersedes', v_latest_id
        ))
      );
    else
      insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
      values (
        r.thesis_id,
        null,
        null,
        format(
          '%s kept %s out of %s scored %s. %s would have won, average %s%% from the decision price. A 95%% interval on that average leaves out a scratch, so the gate is %s. The rule was not changed.',
          v_lead,
          v_name,
          r.scored,
          case when r.scored = 1 then 'skip' else 'skips' end,
          r.would_have_won,
          v_pct,
          case r.verdict
            when 'protecting' then 'protecting the book'
            else 'costing growth'
          end
        ),
        pg_catalog.now(),
        jsonb_strip_nulls(jsonb_build_object(
          'kind', 'gate_outcome',
          'steward', r.steward,
          'gate', r.gate,
          'verdict', r.verdict,
          'skips', r.skips,
          'scored', r.scored,
          'would_have_won', r.would_have_won,
          'mean_outcome_pct', r.mean_outcome_pct,
          'sd_outcome_pct', r.sd_outcome_pct,
          'more_needed', r.more_needed,
          'method', 'student_t_95',
          'rule_changed', false,
          'supersedes', v_latest_id
        ))
      );
    end if;
    v_written := v_written + 1;
  end loop;
  return jsonb_build_object('written', v_written, 'skipped_no_thesis', v_skipped);
end;
$$;

comment on function private.record_gate_outcome_beliefs() is
  'Writes one belief_updates row (meta.kind = gate_outcome) when a gate''s 95% interval first excludes zero, the verdict flips, or an earlier protecting or costing-growth lesson no longer clears. The new row points at the previous one in meta.supersedes. Re-runs with the same verdict write nothing. Skips a gate that maps to no thesis. Does not update theses, desk_rules, or any sizing function.';

revoke all on function private.record_gate_outcome_beliefs() from public, anon, authenticated;
grant execute on function private.record_gate_outcome_beliefs()
  to service_role, quantanamo_worker, oddsborne_worker, bandit_worker;

-- Stamp the gate and the percent on the row. A new ODDSBORNE skip with no rule, or with
-- a provenance label, takes the gate the note names. A scored row gets outcome_pct from
-- the stored mark only.

create or replace function private.decision_candidates_stamp_gate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pct numeric;
  v_given text;
  v_note_id text;
  v_body text;
  v_note_meta jsonb;
  v_doc jsonb;
  v_gate text;
begin
  if new.decision is distinct from 'skip' then
    return new;
  end if;
  if coalesce(new.meta->>'superseded', '') = 'true' then
    return new;
  end if;
  new.meta := coalesce(new.meta, '{}'::jsonb);
  if new.steward = 'oddsborne' then
    v_given := nullif(btrim(coalesce(new.meta->>'blocked_by', '')), '');
    if v_given is null or v_given in ('morning_rollup', 'afternoon_rollup') then
      v_note_id := nullif(btrim(coalesce(new.meta->>'note_id', '')), '');
      if v_note_id is null and new.source_table = 'pm_notes' then
        v_note_id := nullif(split_part(coalesce(new.source_id, ''), ':', 1), '');
      end if;
      v_doc := null;
      if v_note_id is not null then
        begin
          select n.body, n.meta into v_body, v_note_meta
          from public.pm_notes n
          where n.id::text = v_note_id;
          if found then
            v_doc := public.oddsborne_note_blocking_gate(v_body, v_note_meta, new.instrument);
          end if;
        exception when others then
          v_doc := null;
        end;
      end if;
      v_gate := nullif(v_doc->>'gate', '');
      if v_gate is null or v_gate = 'unlabeled' then
        v_gate := public.decision_gate_key(new.steward, new.reason, new.meta);
      end if;
      if v_gate is null or v_gate in ('morning_rollup', 'afternoon_rollup', '') then
        v_gate := 'unlabeled';
      end if;
      if v_given in ('morning_rollup', 'afternoon_rollup') then
        new.meta := new.meta || jsonb_build_object('blocked_by_was', v_given);
      end if;
      new.meta := new.meta || jsonb_build_object('blocked_by', v_gate);
      if v_doc is not null and coalesce(v_doc->>'gate', '') not in ('', 'unlabeled') then
        new.meta := new.meta || jsonb_build_object(
          'gate_repair', jsonb_build_object(
            'note_id', v_note_id,
            'edge', v_doc->'edge',
            'why', v_doc->>'why'
          )
        );
      end if;
    end if;
  end if;
  if new.counterfactual_pnl is not null then
    v_pct := public.decision_outcome_pct(
      new.venue,
      new.side,
      new.book_price,
      public.decision_stored_mark(new.meta),
      new.resolved_outcome,
      new.meta
    );
    if v_pct is not null then
      new.meta := new.meta || jsonb_build_object('outcome_pct', round(v_pct, 6));
    end if;
  elsif new.meta ? 'outcome_pct' then
    new.meta := new.meta - 'outcome_pct';
  end if;
  return new;
end;
$$;

revoke all on function private.decision_candidates_stamp_gate() from public, anon, authenticated;

create or replace function private.decision_candidates_gate_belief()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.record_gate_outcome_beliefs();
  exception when others then
    raise warning 'decision_candidates_gate_belief: %', sqlerrm;
  end;
  return null;
end;
$$;

comment on function private.decision_candidates_gate_belief() is
  'After a decision is scored, record gate-outcome beliefs. A failure here is a warning: the mark still commits.';

revoke all on function private.decision_candidates_gate_belief() from public, anon, authenticated;

-- The research cron already writes account_snapshots. That is the schedule: each new
-- snapshot records a gate lesson that has crossed or flipped since the last one.
-- A failure here is a warning: the snapshot still commits.

create or replace function private.account_snapshot_gate_belief()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.record_gate_outcome_beliefs();
  exception when others then
    raise warning 'account_snapshot_gate_belief: %', sqlerrm;
  end;
  return null;
end;
$$;

comment on function private.account_snapshot_gate_belief() is
  'After an account snapshot is stored, record gate-outcome beliefs. A failure here is a warning: the snapshot still commits.';

revoke all on function private.account_snapshot_gate_belief() from public, anon, authenticated;

drop trigger if exists decision_candidates_stamp_gate on public.decision_candidates;
create trigger decision_candidates_stamp_gate
  before insert or update on public.decision_candidates
  for each row
  execute function private.decision_candidates_stamp_gate();

drop trigger if exists decision_candidates_gate_belief on public.decision_candidates;
create trigger decision_candidates_gate_belief
  after insert or update of counterfactual_pnl on public.decision_candidates
  for each statement
  execute function private.decision_candidates_gate_belief();

drop trigger if exists account_snapshot_gate_belief on public.account_snapshots;
create trigger account_snapshot_gate_belief
  after insert on public.account_snapshots
  for each statement
  execute function private.account_snapshot_gate_belief();

-- ——— one-time repair ———
-- morning_rollup and afternoon_rollup are the note a skip was copied from, not a rule.
-- unlabeled stays unlabeled when the note does not name a rule. Prices, marks, and P/L
-- are not touched. The false morning_rollup lesson is superseded, not deleted.

do $$
declare
  v_old public.belief_updates%rowtype;
  v_edge integer;
  v_timeout integer;
  v_other integer;
  v_total integer;
  v_pct text;
  v_rationale text;
  v_result jsonb;
begin
  with classified as (
    select
      c.id,
      n.id::text as note_id,
      c.meta->>'blocked_by' as was,
      public.oddsborne_note_blocking_gate(n.body, n.meta, c.instrument) as doc
    from public.decision_candidates c
    join public.pm_notes n
      on n.id::text = coalesce(
        nullif(btrim(coalesce(c.meta->>'note_id', '')), ''),
        case when c.source_table = 'pm_notes' then split_part(c.source_id, ':', 1) else null end
      )
    where c.steward = 'oddsborne'
      and c.decision = 'skip'
      and coalesce(c.meta->>'superseded', '') <> 'true'
      and coalesce(c.meta->>'blocked_by', '') in ('morning_rollup', 'afternoon_rollup', 'unlabeled')
  )
  update public.decision_candidates c
  set
    meta = c.meta || jsonb_build_object(
      'blocked_by', classified.doc->>'gate',
      'blocked_by_was', classified.was,
      'gate_repair', jsonb_build_object(
        'note_id', classified.note_id,
        'edge', classified.doc->'edge',
        'why', classified.doc->>'why'
      )
    ),
    updated_at = pg_catalog.now()
  from classified
  where c.id = classified.id
    and classified.doc->>'gate' <> 'unlabeled'
    and classified.doc->>'gate' is distinct from c.meta->>'blocked_by';

  if exists (
    select 1
    from public.decision_candidates c
    where c.decision = 'skip'
      and coalesce(c.meta->>'superseded', '') <> 'true'
      and coalesce(c.meta->>'blocked_by', '') in ('morning_rollup', 'afternoon_rollup')
  ) then
    raise exception 'provenance labels remain on skip rows';
  end if;

  if exists (
    select 1
    from public.decision_candidates c
    join public.pm_notes n
      on n.id::text = coalesce(
        nullif(btrim(coalesce(c.meta->>'note_id', '')), ''),
        case when c.source_table = 'pm_notes' then split_part(c.source_id, ':', 1) else null end
      )
    where c.steward = 'oddsborne'
      and c.decision = 'skip'
      and coalesce(c.meta->>'superseded', '') <> 'true'
      and coalesce(c.meta->>'blocked_by', '') = 'unlabeled'
      and public.oddsborne_note_blocking_gate(n.body, n.meta, c.instrument)->>'gate' <> 'unlabeled'
  ) then
    raise exception 'an unlabeled skip still has a named gate in its note';
  end if;

  select
    count(*) filter (where meta->>'blocked_by' = 'edge_below_gate')::integer,
    count(*) filter (where meta->>'blocked_by' = 'not_placed')::integer,
    count(*)::integer
  into v_edge, v_timeout, v_total
  from public.decision_candidates
  where steward = 'oddsborne'
    and decision = 'skip'
    and meta->>'blocked_by_was' = 'morning_rollup';
  v_other := v_total - v_edge - v_timeout;

  if not exists (
    select 1 from public.belief_updates
    where id = '1db9c2bc-0e61-4ee4-addd-d9771b5c8391'
  ) and not exists (
    select 1 from public.belief_updates
    where meta->>'kind' = 'gate_outcome'
      and meta->>'verdict' = 'superseded'
      and meta->>'supersedes' = '1db9c2bc-0e61-4ee4-addd-d9771b5c8391'
  ) then
    raise exception 'morning_rollup belief is missing';
  end if;

  select * into v_old
  from public.belief_updates
  where id = '1db9c2bc-0e61-4ee4-addd-d9771b5c8391';

  if v_old.id is not null and not exists (
    select 1 from public.belief_updates
    where meta->>'kind' = 'gate_outcome'
      and meta->>'verdict' = 'superseded'
      and meta->>'supersedes' = v_old.id::text
  ) then
    if v_total = 0 then
      raise exception 'morning_rollup rows were not reclassified';
    end if;
    v_pct := case when (v_old.meta->>'mean_outcome_pct')::numeric > 0 then '+' else '' end
      || pg_catalog.btrim(pg_catalog.to_char(
        pg_catalog.round((v_old.meta->>'mean_outcome_pct')::numeric * 100, 1),
        '999990.0'
      ));
    v_rationale := format(
      'The earlier lesson that the morning rollup was costing growth is wrong. That label is the note those skips were copied from, not a rule. %s were blocked because the post-fee edge was under the minimum. %s had a positive edge and were skipped because the enter call timed out. The earlier count was %s scored, %s would have won, average %s%%. The spread of those returns still includes a scratch. The rule was not changed.',
      v_edge,
      v_timeout,
      v_old.meta->>'scored',
      v_old.meta->>'would_have_won',
      v_pct
    );
    if v_other > 0 then
      v_rationale := v_rationale || format(' %s were filed under a different rule the note named.', v_other);
    end if;
    insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
    values (
      v_old.thesis_id,
      null,
      null,
      v_rationale,
      pg_catalog.now(),
      jsonb_build_object(
        'kind', 'gate_outcome',
        'steward', 'oddsborne',
        'gate', 'morning_rollup',
        'verdict', 'superseded',
        'supersedes', v_old.id,
        'rule_changed', false,
        'method', 'student_t_95',
        'repaired_to', jsonb_build_object(
          'edge_below_gate', v_edge,
          'not_placed', v_timeout
        ),
        'scored', (v_old.meta->>'scored')::integer,
        'would_have_won', (v_old.meta->>'would_have_won')::integer,
        'mean_outcome_pct', (v_old.meta->>'mean_outcome_pct')::numeric
      )
    );
  end if;

  v_result := private.record_gate_outcome_beliefs();
  raise notice 'gate beliefs %', v_result;
end;
$$;

notify pgrst, 'reload schema';
