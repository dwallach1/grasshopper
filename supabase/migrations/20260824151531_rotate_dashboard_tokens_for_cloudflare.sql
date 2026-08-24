create or replace function public.is_thesisforge_dashboard_reader()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      coalesce(
        current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-dashboard-token',
        ''
      ),
      'sha256'
    ),
    'hex'
  ) in (
    '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a',
    'f92815d42576ec7de57769076d2c547f8ee4811db0cba6fc1e8a94cfe212eef9'
  );
$$;

create or replace function public.is_thesisforge_site_manager()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    encode(
      extensions.digest(
        coalesce(
          (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-dashboard-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) in (
      '28390b6c34a3ce62cadb7b5423d2602398eb4d23cf0c7edeeef876474c08a35a',
      'f92815d42576ec7de57769076d2c547f8ee4811db0cba6fc1e8a94cfe212eef9'
    )
    and encode(
      extensions.digest(
        coalesce(
          (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-token'),
          ''
        ),
        'sha256'
      ),
      'hex'
    ) in (
      '644fbeec6d5153114d1d24d36d95dbefbbb08c9a37d7386c7664def738078696',
      '9022c6a63dd1d8d166337c64103cfb27ec879a7e390d4241ca1df3bc5908f92b'
    )
    and (
      coalesce(
        (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-user-id'),
        ''
      ) = 'dc4218ec-f17c-4159-9d61-5ed54354ac50'
      or encode(
        extensions.digest(
          lower(
            coalesce(
              (select current_setting('request.headers', true)::jsonb ->> 'x-thesisforge-manager-user-id'),
              ''
            )
          ),
          'sha256'
        ),
        'hex'
      ) = '68c1ad308ad4b806b9c0d4b2652c4899f2e44523fa5f6fb5d094559f59950e26'
    );
$$;

revoke all on function public.is_thesisforge_dashboard_reader() from public, authenticated, service_role;
grant execute on function public.is_thesisforge_dashboard_reader() to anon;
revoke all on function public.is_thesisforge_site_manager() from public, authenticated, service_role;
grant execute on function public.is_thesisforge_site_manager() to anon;
