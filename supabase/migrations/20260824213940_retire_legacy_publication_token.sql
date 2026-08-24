-- Retire the legacy per-Worker publication token after all callers have moved
-- to the centralized Cloudflare Secrets Store binding.
do $$
declare
  definition text;
  transition_condition text := $condition$encode(extensions.digest(supplied_token, 'sha256'), 'hex') not in ('ad743c9c4b7eb01fb40d8d0d4510ef8e0915f620e080a9fdbba116e2a9a06ac2', '22464bba6b2c336e9650e5d172c62c3904aff03e18d9d025890e905592b7868c')$condition$;
  current_condition text := $condition$encode(extensions.digest(supplied_token, 'sha256'), 'hex') <> '22464bba6b2c336e9650e5d172c62c3904aff03e18d9d025890e905592b7868c'$condition$;
begin
  select pg_get_functiondef('public.publish_dashboard_snapshot(jsonb,boolean)'::regprocedure)
    into definition;
  if position(transition_condition in definition) = 0 then
    raise exception 'Unexpected publication function transition state';
  end if;
  execute replace(definition, transition_condition, current_condition);
end $$;
