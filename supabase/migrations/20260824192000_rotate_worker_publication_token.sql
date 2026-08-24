do $$
declare
  definition text;
begin
  select pg_get_functiondef('public.publish_dashboard_snapshot(jsonb,boolean)'::regprocedure)
  into definition;
  if position('a1d1ec8f0148d08edd7373dc60b1f2c13e7e86558751e4007fbae7ebd39b2daa' in definition) = 0 then
    raise exception 'Unexpected publication function authorization state';
  end if;
  execute replace(
    definition,
    'a1d1ec8f0148d08edd7373dc60b1f2c13e7e86558751e4007fbae7ebd39b2daa',
    'd9e31e75da3f70d0480b5881bf88ee3446de10f6d57b9bcc69fcee709a8b0133'
  );
end $$;
