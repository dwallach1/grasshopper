-- PR 7: "Kill the old rules!" (David, 2026-09-26). No global stop-loss and no portfolio
-- drawdown limit. Exits come from each thesis's own written invalidation (theses.falsifier);
-- with none written, from the steward's judgment and its learned beliefs.
update public.risk_controls
set status = 'retired',
    threshold_json = jsonb_build_object(
      'retired', '2026-09-26 David: Kill the old rules! No portfolio drawdown limit',
      'replaced_by', 'exits come from each thesis''s own invalidation (theses.falsifier) or steward judgment'),
    updated_at = now()
where control_key = 'portfolio-drawdown';

update public.risk_controls
set threshold_json = (threshold_json - 'hard_loss_exit_percent')
      || jsonb_build_object('exit_source', 'linked thesis falsifier (written invalidation); otherwise steward judgment; no global stop-loss'),
    updated_at = now()
where control_key = 'autonomous-position-management';
