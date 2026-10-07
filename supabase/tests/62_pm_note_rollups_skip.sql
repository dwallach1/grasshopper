-- Read-only checks for migration 62. Raises on the first failure; writes nothing.
do $$
declare v_n integer;
begin
  assert pg_get_functiondef('private.decision_candidate_from_pm_note'::regproc) like '%62: a rollup note naming no market%',
    'trigger function missing the 62 rollup skip';
  select count(*) into v_n from public.decision_candidates
  where steward = 'oddsborne' and meta->>'unscoreable' = 'true' and coalesce(meta->>'superseded', '') <> 'true';
  assert v_n = 1, format('expected 1 live unscoreable oddsborne row, found %s', v_n);
  assert exists (select 1 from public.decision_candidates where id::text like '9371dc04-%'
                   and coalesce(meta->>'superseded', '') <> 'true'), '9371dc04 must stay unscoreable';
end;
$$;
