-- Narrow the proposer run log added in 20261102184327. desk_public_reader,
-- oddsborne_worker and bandit_worker lose SELECT on public.ontology_proposer_runs.
-- v_ledger_watchdog is security_invoker and already reads bookmarks, which
-- desk_public_reader cannot select, so that role never read the view directly;
-- the desk gets the watchdog through the publication path. Nothing new is given to any role.
-- Does not score a test or change a lesson.

revoke all on table public.ontology_proposer_runs
  from public, anon, desk_public_reader, oddsborne_worker, bandit_worker;

drop policy if exists ontology_proposer_runs_read on public.ontology_proposer_runs;
create policy ontology_proposer_runs_read on public.ontology_proposer_runs
  for select to authenticated, quantanamo_worker
  using (true);
