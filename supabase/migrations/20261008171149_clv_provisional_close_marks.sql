-- Closing-line value leaves out provisional close marks, and counts what it left out.
--
-- A close mark (58) is one row per ODDSBORNE decision; a later observation replaces an earlier one
-- (steward_record_decision_mark: on conflict ... do update ... where excluded.observed_at > observed_at,
-- meta = excluded.meta). ODDSBORNE's close_mark.py also runs hours before the event as a backstop, so a
-- row can hold a morning mid until the pre-game run replaces it. Those marks stamp
-- meta.provisional = true and meta.minutes_before_start. v_decision_clv read them as closing prices.
--
-- A close mark is provisional when meta->>'provisional' = 'true' (JSON true or the string), or when the
-- event start is known and the mark was observed more than 60 minutes before it. event_start_at is a
-- decision_marks column (58 requires it on every close mark); a null start falls back to the flag alone.
--
-- public.v_decision_clv_all   every close mark on a scoreable prediction decision, with provisional,
--                              provisional_reason and minutes_before_start. Diagnostics only.
-- public.v_decision_clv        same columns as before; provisional marks left out.
-- public.v_decision_clv_summary n / means over non-provisional marks only; provisional_excluded counts the
--                              rest per steward and decision, so a group with only provisional marks still
--                              shows (n = 0) instead of vanishing.
--
-- The upsert already replaces meta wholesale (meta = excluded.meta, not meta || excluded.meta), so the
-- pre-game mark's meta overwrites provisional = true; supabase/tests/66 checks that against the function.
-- Horizon marks (BANDIT, QUANTANAMO) are not read here.

create or replace function public.decision_close_mark_provisional_reason(
  p_meta jsonb,
  p_observed_at timestamptz,
  p_event_start_at timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(coalesce(p_meta->>'provisional', '')) = 'true' then 'flagged'
    when p_event_start_at is not null and p_observed_at is not null
         and p_event_start_at - p_observed_at > interval '60 minutes' then 'early'
    else null
  end;
$$;

comment on function public.decision_close_mark_provisional_reason(jsonb, timestamptz, timestamptz) is
  'Why a close mark is not a closing price: ''flagged'' (meta.provisional = true), ''early'' (observed more than 60 minutes before a known event start), or null (a closing price). A null event start relies on the flag alone.';

revoke all on function public.decision_close_mark_provisional_reason(jsonb, timestamptz, timestamptz) from public, anon;
grant execute on function public.decision_close_mark_provisional_reason(jsonb, timestamptz, timestamptz)
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;

create or replace view public.v_decision_clv_all
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
  c.counterfactual_pnl,
  public.decision_close_mark_provisional_reason(m.meta, m.observed_at, m.event_start_at) is not null as provisional,
  public.decision_close_mark_provisional_reason(m.meta, m.observed_at, m.event_start_at) as provisional_reason,
  round((extract(epoch from (m.event_start_at - m.observed_at)) / 60)::numeric, 1) as minutes_before_start,
  m.id as mark_id
from public.decision_candidates c
join public.decision_marks m on m.decision_id = c.id and m.mark_kind = 'close'
where c.venue = 'prediction'
  and public.decision_is_scoreable(c.instrument, c.side, c.book_price, c.venue, c.meta);

comment on view public.v_decision_clv_all is
  'Every close mark on a scoreable ODDSBORNE decision, provisional or not, with the CLV columns of v_decision_clv plus provisional, provisional_reason (flagged / early) and minutes_before_start. For diagnostics: read v_decision_clv for closing-line value.';

create or replace view public.v_decision_clv
with (security_invoker = true)
as
select a.decision_id,
  a.steward,
  a.decision,
  a.instrument,
  a.side,
  a.decided_at,
  a.entry_price,
  a.my_probability,
  a.close_mid,
  a.close_observed_at,
  a.event_start_at,
  a.close_source,
  a.clv,
  a.fair_minus_close,
  a.fair_closer_than_entry,
  a.resolved_outcome,
  a.counterfactual_pnl
from public.v_decision_clv_all a
where not a.provisional;

comment on view public.v_decision_clv is
  'Closing-line value per ODDSBORNE decision with a closing mark. Provisional close marks (meta.provisional = true, or observed more than 60 minutes before a known event start) are left out; v_decision_clv_all lists them and v_decision_clv_summary.provisional_excluded counts them. entry_price, my_probability and close_mid are all in the terms of the side the decision names (YES-terms rows are flipped for a NO side). clv = close_mid - entry_price: positive means the line moved toward the steward''s side after the decision (good for an enter; for a skip, value passed up). fair_minus_close = my_probability - close_mid. fair_closer_than_entry = the steward''s probability was nearer the close than the entry price was. Separate from settlement (resolved_outcome, counterfactual_pnl, brier).';

create or replace view public.v_decision_clv_summary
with (security_invoker = true)
as
select a.steward,
  a.decision,
  count(*) filter (where not a.provisional)::int as n,
  avg(a.clv) filter (where not a.provisional) as mean_clv,
  count(*) filter (where not a.provisional and a.clv > 0)::int as beat_entry,
  count(*) filter (where not a.provisional and a.clv < 0)::int as worse_than_entry,
  avg(a.fair_minus_close) filter (where not a.provisional) as mean_fair_minus_close,
  count(*) filter (where not a.provisional and a.fair_closer_than_entry)::int as fair_closer_than_entry,
  max(a.close_observed_at) filter (where not a.provisional) as last_close_observed_at,
  count(*) filter (where a.provisional)::int as provisional_excluded,
  max(a.close_observed_at) filter (where a.provisional) as last_provisional_observed_at
from public.v_decision_clv_all a
group by a.steward, a.decision;

comment on view public.v_decision_clv_summary is
  'CLV by steward and decision kind (enter / skip), over closing marks only (the rows of v_decision_clv). provisional_excluded = close marks left out as provisional (flagged, or more than 60 minutes before event start); a group with only provisional marks shows n = 0. Not a hit rate: settlement lives in v_steward_scorecard.';

revoke all on public.v_decision_clv_all from public, anon;
grant select on public.v_decision_clv_all, public.v_decision_clv, public.v_decision_clv_summary
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
