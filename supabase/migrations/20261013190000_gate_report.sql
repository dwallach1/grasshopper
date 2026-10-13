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
-- A gate speaks only once 8 skips are scored and the mean percent is not zero.
-- Below that the verdict is 'too few to tell'. 8 is the smallest sample that is not a
-- handful of coin flips (the court waits for 10 before promoting a rule; this card
-- only names protecting / costing growth, and a later flip writes a new belief).
-- Positive mean: the passes would have made money, so the gate is costing growth.
-- Negative mean: they would have lost, so the gate is protecting the book.
-- Beliefs record that evidence. They do not loosen or tighten any rule.
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
        when coalesce(p_reason, '') ~* '^morning skips' then 'morning_rollup'
        when coalesce(p_reason, '') ~* '^afternoon (skips|sports)' then 'afternoon_rollup'
        when coalesce(p_reason, '') ~* '^wx pass'
          or coalesce(p_meta->>'pattern', '') = 'fav_vs_forecast' then 'weather_forecast_gate'
        when coalesce(p_reason, '') ~* 'same_game|same game' then 'same_game'
        when coalesce(p_reason, '') ~* 'guidance_cap' then 'guidance_cap'
        when coalesce(p_reason, '') ~* 'not_live' then 'not_live'
        when coalesce(p_reason, '') ~* 'not_placed' then 'not_placed'
        when coalesce(p_reason, '') ~* 'cancelled resting' then 'cancelled_resting'
        when coalesce(p_reason, '') ~* 'no two-way|devig fail|methods disagree' then 'devig_gate'
        when coalesce(p_reason, '') ~* 'post-fee|makerΔ|bovada fair|^fair | pass:|^pm |fair=' then 'edge_below_gate'
        else 'unlabeled'
      end
    else 'unlabeled'
  end
  from (
    select nullif(btrim(coalesce(p_meta->>'blocked_by', '')), '') as given
  ) g;
$$;

comment on function public.decision_gate_key(text, text, jsonb) is
  'Gate that blocked a skip. meta.blocked_by wins when it is set (QUANTANAMO and BANDIT). ODDSBORNE reasons derive edge_below_gate, devig_gate, morning_rollup, weather_forecast_gate, same_game, and a few entry-lock keys. Unknown stays unlabeled and is counted.';

create or replace function public.gate_outcome_verdict(p_scored integer, p_mean numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_scored is null or p_scored < 8 or p_mean is null or p_mean = 0 then 'too few to tell'
    when p_mean > 0 then 'costing growth'
    else 'protecting'
  end;
$$;

comment on function public.gate_outcome_verdict(integer, numeric) is
  'protecting when scored skips lost money on average, costing growth when they made money, too few to tell below 8 scored or when the mean is exactly zero. Does not change a rule.';

create or replace function public.gate_belief_due(p_latest text, p_scored integer, p_verdict text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_scored, 0) >= 8
    and p_verdict in ('protecting', 'costing growth')
    and p_latest is distinct from p_verdict;
$$;

comment on function public.gate_belief_due(text, integer, text) is
  'True when a gate has crossed 8 scored skips and its verdict is not the one already on the latest gate_outcome belief. A re-run with the same verdict is false. A flip is true. too few to tell never writes.';

revoke all on function public.decision_stored_mark(jsonb) from public, anon;
revoke all on function public.decision_logged_stake(jsonb) from public, anon;
revoke all on function public.decision_outcome_pct(text, text, numeric, numeric, text, jsonb) from public, anon;
revoke all on function public.decision_gate_key(text, text, jsonb) from public, anon;
revoke all on function public.gate_outcome_verdict(integer, numeric) from public, anon;
revoke all on function public.gate_belief_due(text, integer, text) from public, anon;

grant execute on function public.decision_stored_mark(jsonb),
  public.decision_logged_stake(jsonb),
  public.decision_outcome_pct(text, text, numeric, numeric, text, jsonb),
  public.decision_gate_key(text, text, jsonb),
  public.gate_outcome_verdict(integer, numeric),
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
  public.gate_outcome_verdict(r.scored, r.mean_outcome_pct) as verdict,
  th.thesis_id,
  r.at_stake_pnl,
  r.unit
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
  'Per steward, per gate, skips only (superseded rows left out). scored and the mean are percent returns from a stored mark, signed for the skipped side. verdict is protecting, costing growth, or too few to tell (under 8 scored, or a zero mean). thesis_id is the thesis most of that gate''s skips already name, when that thesis exists. at_stake_pnl is the percent times a size the row stored; null when the ledger has no size. Measurement only.';

revoke all on public.v_gate_report from public, anon;
grant select on public.v_gate_report
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

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

-- ——— beliefs: one row when the sample bar is crossed or the verdict flips ———

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
  v_name text;
  v_pct text;
  v_written integer := 0;
  v_skipped integer := 0;
begin
  for r in
    select *
    from public.v_gate_report g
    where public.gate_belief_due(
      (
        select b.meta->>'verdict'
        from public.belief_updates b
        where b.meta->>'kind' = 'gate_outcome'
          and b.meta->>'steward' = g.steward
          and b.meta->>'gate' = g.gate
        order by b.observed_at desc, b.id desc
        limit 1
      ),
      g.scored,
      g.verdict
    )
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('gate_outcome:' || r.steward || ':' || r.gate, 0)
    );
    select b.meta->>'verdict' into v_latest
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
    v_pct := case when r.mean_outcome_pct > 0 then '+' else '' end
      || pg_catalog.btrim(pg_catalog.to_char(pg_catalog.round(r.mean_outcome_pct * 100, 1), '999990.0'));
    insert into public.belief_updates (thesis_id, prior_confidence, new_confidence, rationale, observed_at, meta)
    values (
      r.thesis_id,
      null,
      null,
      format(
        '%s kept %s out of %s scored %s. %s would have won, average %s%% from the decision price. %s The rule was not changed.',
        r.gate,
        v_name,
        r.scored,
        case when r.scored = 1 then 'pass' else 'passes' end,
        r.would_have_won,
        v_pct,
        case r.verdict
          when 'protecting' then 'The gate is protecting the book.'
          when 'costing growth' then 'The gate is costing growth.'
          else 'Too few to tell yet.'
        end
      ),
      pg_catalog.now(),
      jsonb_build_object(
        'kind', 'gate_outcome',
        'steward', r.steward,
        'gate', r.gate,
        'verdict', r.verdict,
        'skips', r.skips,
        'scored', r.scored,
        'would_have_won', r.would_have_won,
        'mean_outcome_pct', r.mean_outcome_pct,
        'rule_changed', false
      )
    );
    v_written := v_written + 1;
  end loop;
  return jsonb_build_object('written', v_written, 'skipped_no_thesis', v_skipped);
end;
$$;

comment on function private.record_gate_outcome_beliefs() is
  'Writes one belief_updates row (meta.kind = gate_outcome) when a gate first reaches 8 scored skips or its verdict flips. Re-runs with the same verdict write nothing. Skips a gate that maps to no thesis. Does not update theses, desk_rules, or any sizing function.';

revoke all on function private.record_gate_outcome_beliefs() from public, anon, authenticated;
grant execute on function private.record_gate_outcome_beliefs()
  to service_role, quantanamo_worker, oddsborne_worker, bandit_worker;

-- Stamp the gate and the percent on the row. New ODDSBORNE skips get blocked_by even
-- when the caller left it off. A scored row gets outcome_pct from the stored mark only.

create or replace function private.decision_candidates_stamp_gate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pct numeric;
begin
  if new.decision is distinct from 'skip' then
    return new;
  end if;
  if coalesce(new.meta->>'superseded', '') = 'true' then
    return new;
  end if;
  new.meta := coalesce(new.meta, '{}'::jsonb);
  if new.steward = 'oddsborne' and nullif(btrim(coalesce(new.meta->>'blocked_by', '')), '') is null then
    new.meta := new.meta || jsonb_build_object(
      'blocked_by', public.decision_gate_key(new.steward, new.reason, new.meta)
    );
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

-- Backfill from marks already on the row. Listing counterfactual_pnl in SET fires the
-- belief trigger once. The BEFORE trigger writes blocked_by and outcome_pct. No new prices.
update public.decision_candidates
set counterfactual_pnl = counterfactual_pnl,
    updated_at = pg_catalog.now()
where decision = 'skip'
  and coalesce(meta->>'superseded', '') <> 'true';

select private.record_gate_outcome_beliefs();
