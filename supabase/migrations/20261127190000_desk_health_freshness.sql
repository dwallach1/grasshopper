-- /api/health was reading desk_public_bundle.generated_at as if it were the
-- ledger. That clock only moves when someone requests the bundle. This
-- function is the cheap clock: the newest account snapshot and the newest
-- equity mark. The edge function calls it as service_role. The public desk
-- role cannot.

create index if not exists idx_portfolio_exposure_observed_at
  on public.portfolio_exposure (observed_at desc);

comment on index public.idx_portfolio_exposure_observed_at is
  'Latest equity mark for desk_public_ledger_freshness. Not a price source.';

create or replace function public.desk_public_ledger_freshness()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'snapshot_at', (
      select snapshots.observed_at
      from public.account_snapshots as snapshots
      order by snapshots.observed_at desc
      limit 1
    ),
    'mark_at', (
      select marks.observed_at
      from public.portfolio_exposure as marks
      order by marks.observed_at desc
      limit 1
    )
  );
$$;

comment on function public.desk_public_ledger_freshness() is
  'Latest account snapshot and equity mark. service_role only. Does not read desk_public_bundle and does not rebuild a book.';

revoke all on function public.desk_public_ledger_freshness() from public;
revoke all on function public.desk_public_ledger_freshness() from anon, authenticated, desk_public_reader;
revoke all on function public.desk_public_ledger_freshness() from quantanamo_worker, oddsborne_worker, bandit_worker;
grant execute on function public.desk_public_ledger_freshness() to service_role;
