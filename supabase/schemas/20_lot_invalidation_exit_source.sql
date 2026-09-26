-- Exits read the lot's own invalidation first (position_episodes.invalidation_price /
-- invalidation_note), then the linked thesis falsifier; otherwise the steward's judgment.
update public.risk_controls
set threshold_json = threshold_json || jsonb_build_object(
      'exit_source',
      'lot invalidation first (position_episodes.invalidation_price: exit when the mark is at or below it; invalidation_note: written invalidation), then the linked thesis falsifier; otherwise steward judgment; no global stop-loss'),
    updated_at = now()
where control_key = 'autonomous-position-management';
