-- PR 6 data run: retro-tag SNOW and OCC to earnings_gap_structure (QUANTANAMO flag, verified
-- by GRASSHOPPER against SEC filing times). Both are manual_backfill outcomes with no
-- position_episodes row and untagged trade_intents (no thesis column), so the outcome row is
-- the source of record and is tagged directly. IREN is a theme trade and stays untagged.
-- trade_outcome_rescore_upd re-scores earnings_gap_structure; it is also re-scored explicitly.
update public.trade_outcomes o
set thesis_id = 'earnings_gap_structure',
    confidence_at_entry = private.thesis_confidence_at('earnings_gap_structure', o.opened_at),
    meta = coalesce(o.meta, '{}'::jsonb) || jsonb_build_object('retro_tag', jsonb_build_object(
      'thesis_id', 'earnings_gap_structure',
      'tagged_by', 'GRASSHOPPER',
      'tagged_at', now(),
      'flagged_by', 'QUANTANAMO',
      'reason', v.reason)),
    updated_at = now()
from (values
  ('quantanamo:SNOW:2026-09-02',
   'tagged by GRASSHOPPER: bought 2026-09-02 12:42 ET, same day and before the FQ2 print (8-K 2026-09-02 16:08 ET, after hours); sold 16:11 ET into the post-print gap. Size-before-print earnings gap trade.'),
  ('quantanamo:OCC:2026-09-08',
   'tagged by GRASSHOPPER: bought 2026-09-08 09:54 ET, the session before the FQ3 AM print on 2026-09-09 (EPS 0.21 vs 0.20; 10-Q 2026-09-09 13:00 ET); sold 2026-09-09 09:36 ET after a soft open. Size-before-print earnings gap trade.')
) as v(source_id, reason)
where o.source_table = 'manual_backfill'
  and o.source_id = v.source_id
  and o.steward = 'quantanamo'
  and o.thesis_id is null;

select private.rescore_thesis_confidence('earnings_gap_structure');
