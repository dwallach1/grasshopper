-- Recovered from supabase_migrations.schema_migrations on xqungxapqicdmboniezz.
-- Allow equity desk publisher / quantanamo_worker to READ pm_* for unified public snapshot.
-- No INSERT/UPDATE/DELETE — Oddsborne remains the writer.
grant select on public.pm_markets to quantanamo_worker;
grant select on public.pm_orders to quantanamo_worker;
grant select on public.pm_positions to quantanamo_worker;
grant select on public.pm_fills to quantanamo_worker;
grant select on public.pm_pnl to quantanamo_worker;
grant select on public.pm_notes to quantanamo_worker;

drop policy if exists quantanamo_worker_select on public.pm_markets;
create policy quantanamo_worker_select on public.pm_markets
  for select to quantanamo_worker using (true);
drop policy if exists quantanamo_worker_select on public.pm_orders;
create policy quantanamo_worker_select on public.pm_orders
  for select to quantanamo_worker using (true);
drop policy if exists quantanamo_worker_select on public.pm_positions;
create policy quantanamo_worker_select on public.pm_positions
  for select to quantanamo_worker using (true);
drop policy if exists quantanamo_worker_select on public.pm_fills;
create policy quantanamo_worker_select on public.pm_fills
  for select to quantanamo_worker using (true);
drop policy if exists quantanamo_worker_select on public.pm_pnl;
create policy quantanamo_worker_select on public.pm_pnl
  for select to quantanamo_worker using (true);
drop policy if exists quantanamo_worker_select on public.pm_notes;
create policy quantanamo_worker_select on public.pm_notes
  for select to quantanamo_worker using (true);
