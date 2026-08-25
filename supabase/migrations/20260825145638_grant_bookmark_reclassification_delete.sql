-- The knowledge Worker replaces derived rows when a bookmark is reclassified.
-- Grant DELETE only on the six tables used by that bounded transaction.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'bookmark_symbols','claims','ontology_evidence','ontology_observations',
    'ontology_candidate_evidence','thesis_evidence'
  ]
  loop
    execute format(
      'grant delete on table public.%I to thesisforge_worker',
      target_table
    );
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = target_table
        and policyname = 'thesisforge_worker_delete'
    ) then
      execute format(
        'create policy thesisforge_worker_delete on public.%I for delete to thesisforge_worker using (true)',
        target_table
      );
    end if;
  end loop;
end $$;

-- Keep the dashboard's automation projection aligned with the two useful
-- weekday knowledge and portfolio windows.
do $$
declare
  definition text;
  updated_definition text;
begin
  definition := pg_get_functiondef('private.attach_worker_observability()'::regprocedure);
  updated_definition := replace(
    definition,
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=10,13,15;BYMINUTE=05',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=10,15;BYMINUTE=05'
  );
  updated_definition := replace(
    updated_definition,
    'RRULE:FREQ=MINUTELY;INTERVAL=30',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,14;BYMINUTE=35'
  );
  if updated_definition = definition then
    raise exception 'Worker observability schedule markers were not found';
  end if;
  execute updated_definition;
end $$;
