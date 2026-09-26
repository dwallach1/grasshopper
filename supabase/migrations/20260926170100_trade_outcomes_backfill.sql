-- Backfill for the outcome ledger (PR 1, measurement only).
-- Numbers are the audit reconstruction of 2026-09-26; nothing is invented.
-- pnl_source is honest per row: fills / cash_delta / settlement / manual
-- (manual rows carry meta.basis). Re-runnable: every insert is keyed on
-- (source_table, source_id) and skips existing rows.

-- ——— 1. decision_candidates from market-linked pm_notes enter/skip ———
-- One candidate per market x decision x PT day (first note with a probability wins).
-- Kill-criteria notes are not decisions. The 2026-09-09 CPI skip is linked to
-- the hike25 market by mistake, so it is logged without a market (unscoreable).

insert into public.decision_candidates (
  steward, venue, decided_at, decision, market_id, instrument, thesis_id, side,
  my_probability, book_price, edge, reason, source_table, source_id, meta
)
select distinct on (n.market_id, n.decision, (n.created_at at time zone 'America/Los_Angeles')::date)
  'oddsborne', 'prediction', n.created_at, n.decision, n.market_id, m.slug,
  nullif(btrim(coalesce(n.thesis_id, '')), ''),
  case
    when n.my_probability is null or n.book_probability is null then 'yes'
    when n.my_probability >= n.book_probability then 'yes'
    else 'no'
  end,
  n.my_probability, n.book_probability,
  n.my_probability - n.book_probability,
  left(n.title, 280),
  'pm_notes', n.id::text,
  jsonb_build_object('origin', 'backfill', 'note_type', n.note_type)
from public.pm_notes n
join public.pm_markets m on m.id = n.market_id
where n.decision in ('enter', 'skip')
  and n.note_type <> 'kill'
  and n.id <> '164e544d-a773-4066-9c59-24fb5bd50b74'
order by n.market_id, n.decision, (n.created_at at time zone 'America/Los_Angeles')::date,
  (n.my_probability is null), n.created_at
on conflict (source_table, source_id) do nothing;

insert into public.decision_candidates (
  steward, venue, decided_at, decision, market_id, instrument, thesis_id, side,
  my_probability, book_price, edge, reason, source_table, source_id, meta
)
select 'oddsborne', 'prediction', n.created_at, n.decision, null,
  'cpic-uscpi-august-yoy-2026-09-11-gt3pt4pct', null,
  case when n.my_probability >= n.book_probability then 'yes' else 'no' end,
  n.my_probability, n.book_probability, n.my_probability - n.book_probability,
  left(n.title, 280), 'pm_notes', n.id::text,
  jsonb_build_object('origin', 'backfill', 'note_type', n.note_type,
    'mislinked_market_id', n.market_id,
    'note', 'pm_notes row points at hike25; title is the CPI gt3.4 skip. Unscored until relinked.')
from public.pm_notes n
where n.id = '164e544d-a773-4066-9c59-24fb5bd50b74'
on conflict (source_table, source_id) do nothing;

select private.resolve_decision_candidates(null);

-- ——— 2. ODDSBORNE: 8 closed round trips (USD) ———

with src(position_id, cost, proceeds, fees, pnl, pnl_source, closed_override, basis, note) as (
  values
    ('0c925f7b-94d1-4ec6-b632-5b87d1e18b6c'::uuid, 86.47, 140.38, null::numeric, 53.91, 'settlement',
      null::timestamptz, 'sells_plus_settlement',
      'sold 83@0.80 and 41@0.78, 42 settled YES at 1'),
    ('1590fe42-1604-4194-a7aa-333eb93c5d5c'::uuid, 49.05, 0, null, -49.05, 'settlement',
      null, null, 'Midway <=79 resolved NO'),
    ('ff6030d0-48bb-4086-b795-96721707e743'::uuid, 31.75, 0, 1.75, -31.75, 'settlement',
      null, null, 'LAX 9/10 87-88 resolved NO; cost includes 1.75 fees'),
    ('306fe937-741d-4fee-8260-22ae187429fd'::uuid, 12.24, 65, null, 52.76, 'settlement',
      null, null, 'LAX 9/11 84-85 resolved YES; 65 x 1'),
    ('e4b54577-782d-41a0-bb55-5b1b31a7ae41'::uuid, null, null, null, 60.12, 'manual',
      null, 'audit_approx',
      'LAX 9/12 81-82 YES. Approximate: position row qty 50 is incomplete; cash implies up to +63.70'),
    ('b4f4a00b-d820-474c-a41a-31de1cfdc819'::uuid, 23.74, 0, null, -23.74, 'cash_delta',
      null, null, 'LAX 9/13 76-77 resolved NO; position row shows qty 0, cash delta is the source'),
    ('df5a97f3-42fb-4d5e-b9bb-aceadf6785be'::uuid, 18.82, 0, null, -18.82, 'settlement',
      null, null, 'Andrews 2+ TD resolved NO'),
    ('a7e3f9fe-edec-435d-bd3b-d817415e63f0'::uuid, 200.00, 0, null, -200.00, 'settlement',
      null, null, 'MIA ML vs SF resolved NO')
)
insert into public.trade_outcomes (
  steward, venue, account_key, instrument, thesis_id, source_table, source_id,
  opened_at, closed_at, cost, proceeds, fees, realized_pnl, unit, pnl_source,
  confidence_at_entry, size_pct_nav_at_entry, edge_at_entry, exit_reason, is_paper, meta
)
select
  'oddsborne', 'prediction',
  private.canonical_account_key('prediction', p.account_key),
  coalesce(m.slug, p.market_id::text) || ' ' || upper(coalesce(p.outcome, '')),
  nullif(btrim(coalesce(p.thesis_id, '')), ''),
  'pm_positions', p.id::text,
  p.opened_at, coalesce(s.closed_override, p.closed_at),
  s.cost, s.proceeds, s.fees, s.pnl, 'USD', s.pnl_source,
  private.thesis_confidence_at(nullif(btrim(coalesce(p.thesis_id, '')), ''), p.opened_at),
  null,
  (
    select c.edge from public.decision_candidates c
    where c.market_id = p.market_id and c.decision = 'enter' and c.edge is not null
    order by c.decided_at
    limit 1
  ),
  case when lower(m.resolution_outcome) in ('yes', 'no') then 'resolved_' || lower(m.resolution_outcome) end,
  false,
  jsonb_strip_nulls(jsonb_build_object(
    'origin', 'backfill',
    'audit', '2026-09-26',
    'basis', s.basis,
    'note', s.note,
    'market_slug', m.slug,
    'source_account_key', p.account_key
  ))
from src s
join public.pm_positions p on p.id = s.position_id
left join public.pm_markets m on m.id = p.market_id
on conflict (source_table, source_id) do nothing;

-- ——— 3. QUANTANAMO: 7 closed round trips (USD) ———
-- Thesis links only where thesis_symbols is unambiguous (ASAN noted as ambiguous).

with src(instrument, source_table, source_id, opened_at, closed_at, cost, proceeds, fees, pnl_source, thesis_id, basis, note) as (
  values
    ('IREN', 'position_episodes', 'd2c144b0-2535-4c51-bf7f-dc593dca86da',
      '2026-08-26 19:01:06+00'::timestamptz, '2026-08-28 13:46:18.317+00'::timestamptz,
      1000.00, 949.62, 0.02::numeric, 'fills', null::text, null::text,
      'thesis_symbols links IREN to four theses; left untagged'),
    ('DG', 'position_episodes', '001e52b2-654b-4d51-bfa0-92c2c1e4b2ac',
      '2026-08-27 13:21:36.632+00', '2026-09-02 16:45:10+00',
      1851.50, 1850.91, 0.04, 'cash_delta', 'earnings_gap_structure', null,
      'episode closed_at 2026-09-17 is a stale reconcile; broker sell was 2026-09-02'),
    ('SNOW', 'manual_backfill', 'quantanamo:SNOW:2026-09-02',
      '2026-09-02 16:43:00+00', '2026-09-02 20:13:45+00',
      1844.46, 2184.19, 0.05, 'cash_delta', null, null,
      '6 x 307.41 in, 6 x 364.04 out less 0.05 fee; no thesis link'),
    ('AOUT', 'manual_backfill', 'quantanamo:AOUT:2026-09-03',
      '2026-09-03 17:21:54+00', '2026-09-04 14:36:00+00',
      1796.472, 2541.618, null, 'manual', 'earnings_gap_structure', 'trade_intent_notional',
      'buy has a broker fill; sell priced from the filled intent notional'),
    ('ASAN', 'manual_backfill', 'quantanamo:ASAN:2026-09-01',
      '2026-09-01 14:01:40+00', '2026-09-04 15:05:00+00',
      1094.3491, 914.619, null, 'manual', 'earnings_gap_structure', 'trade_intent_notional',
      'thesis_symbols also links software_ai_apps; earnings-gap exit'),
    ('OCC', 'manual_backfill', 'quantanamo:OCC:2026-09-08',
      '2026-09-08 13:55:00+00', '2026-09-09 13:37:00+00',
      1982.40, 1683.04, null, 'manual', null, 'lesson_exit_price',
      '140 x 14.16 in, 140 x 12.0217 out per lesson; no intent rows; account cash delta 1682.97 agrees'),
    ('ZUMZ', 'manual_backfill', 'quantanamo:ZUMZ:2026-09-10',
      '2026-09-10 14:23:17+00', '2026-09-11 14:05:00+00',
      2792.448, 2250.59, null, 'cash_delta', 'earnings_gap_structure', null,
      'no sell intent; exit between 13:10 and 14:05 UTC from account cash delta')
)
insert into public.trade_outcomes (
  steward, venue, account_key, instrument, thesis_id, source_table, source_id,
  opened_at, closed_at, cost, proceeds, fees, realized_pnl, unit, pnl_source,
  confidence_at_entry, size_pct_nav_at_entry, edge_at_entry, exit_reason, is_paper, meta
)
select
  'quantanamo', 'equity',
  private.canonical_account_key('equity', 'agentic-7638'),
  s.instrument,
  s.thesis_id,
  s.source_table, s.source_id,
  s.opened_at, s.closed_at,
  s.cost, s.proceeds, s.fees,
  s.proceeds - s.cost,
  'USD', s.pnl_source,
  private.thesis_confidence_at(s.thesis_id, s.opened_at),
  (
    select round(100 * s.cost / a.total_value, 2)
    from public.account_snapshots a
    where a.account_label ~* '7638' and a.total_value > 0 and a.observed_at <= s.opened_at
    order by a.observed_at desc
    limit 1
  ),
  null,
  null,
  false,
  jsonb_strip_nulls(jsonb_build_object(
    'origin', 'backfill',
    'audit', '2026-09-26',
    'basis', s.basis,
    'note', s.note,
    'source_account_key', 'agentic-7638'
  ))
from src s
on conflict (source_table, source_id) do nothing;

-- ——— 4. BANDIT: every closed lot, priced from meme_fills (SOL) ———

select private.trade_outcome_from_meme(p.id)
from public.meme_positions p
where p.status = 'closed';

update public.trade_outcomes
set meta = meta || jsonb_build_object('backfilled', '2026-09-26')
where source_table = 'meme_positions' and not (meta ? 'backfilled');
