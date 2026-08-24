create or replace function private.normalize_dashboard_jsonb(p_value jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'object' then (
      select coalesce(
        jsonb_object_agg(e.key, private.normalize_dashboard_jsonb(e.value)),
        '{}'::jsonb
      )
      from jsonb_each(p_value) e
    )
    when 'array' then (
      select coalesce(
        jsonb_agg(
          private.normalize_dashboard_jsonb(e.value)
          order by e.ordinality
        ),
        '[]'::jsonb
      )
      from jsonb_array_elements(p_value) with ordinality e(value, ordinality)
    )
    when 'string' then to_jsonb(
      regexp_replace(
        regexp_replace(
          replace(p_value #>> '{}', '+00:00', 'Z'),
          E'\\.([0-9]*[1-9])0+Z$',
          E'.\\1Z',
          'g'
        ),
        E'\\.0+Z$',
        'Z',
        'g'
      )
    )
    when 'number' then to_jsonb(trim_scale((p_value #>> '{}')::numeric))
    else p_value
  end;
$$;
revoke all on function private.normalize_dashboard_jsonb(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.normalize_dashboard_jsonb(jsonb) to service_role;
