-- Cloud-control tables were created with service_role-only grants. The local
-- desk (and any job using QUANTANAMO_DATABASE_URL) connects as quantanamo_worker.
-- This matches the existing worker policy pattern; it does not open anon/authenticated.

do $$
declare
  target_table text;
  sequence_name text;
begin
  foreach target_table in array array[
    'cloud_runs',
    'cloud_tasks',
    'position_episodes',
    'position_monitor_events',
    'trade_intents',
    'broker_execution_attempts',
    'broker_fills'
  ]
  loop
    execute format(
      'grant select, insert, update on table public.%I to quantanamo_worker',
      target_table
    );

    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = target_table
        and policyname = 'quantanamo_worker_select'
    ) then
      execute format(
        'create policy quantanamo_worker_select on public.%I for select to quantanamo_worker using (true)',
        target_table
      );
    end if;

    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = target_table
        and policyname = 'quantanamo_worker_insert'
    ) then
      execute format(
        'create policy quantanamo_worker_insert on public.%I for insert to quantanamo_worker with check (true)',
        target_table
      );
    end if;

    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = target_table
        and policyname = 'quantanamo_worker_update'
    ) then
      execute format(
        'create policy quantanamo_worker_update on public.%I for update to quantanamo_worker using (true) with check (true)',
        target_table
      );
    end if;

    sequence_name := pg_get_serial_sequence(format('public.%I', target_table), 'id');
    if sequence_name is not null then
      execute format(
        'grant usage, select, update on sequence %s to quantanamo_worker',
        sequence_name
      );
    end if;
  end loop;
end $$;
