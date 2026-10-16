-- RLS is enabled on public.theses. oddsborne_worker and bandit_worker had SELECT grants but no policy
-- (they are not in `authenticated`), so they saw 0 rows. public.oddsborne_insert_note (72, security invoker)
-- checks thesis_id existence against public.theses, so every thesis-tagged note returned
-- 'refusal:input: unknown thesis_id' (422) after the cutover off the pooler path (~12:06 PM ET 2026-10-16).
-- Read-only, same shape as quantanamo_worker_select (which already existed on theses). No write policies.
-- Applied live as version 20261016210536 (theses_worker_select_policies).

drop policy if exists oddsborne_worker_select on public.theses;
create policy oddsborne_worker_select on public.theses
  for select to oddsborne_worker using (true);

drop policy if exists bandit_worker_select on public.theses;
create policy bandit_worker_select on public.theses
  for select to bandit_worker using (true);
