-- The credential file is newline-terminated. Cloudflare secrets and HTTP headers
-- contain only the token itself, so authorize the hash of that canonical value.
do $$
declare
  function_definition text;
begin
  select pg_get_functiondef('public.publish_dashboard_snapshot(jsonb, boolean)'::regprocedure)
    into function_definition;
  function_definition := replace(
    function_definition,
    'd9e31e75da3f70d0480b5881bf88ee3446de10f6d57b9bcc69fcee709a8b0133',
    'ad743c9c4b7eb01fb40d8d0d4510ef8e0915f620e080a9fdbba116e2a9a06ac2'
  );
  execute function_definition;
end
$$;
