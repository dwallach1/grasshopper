-- NYSE market holidays and early closes (2026-2028) for every session-hours check.
-- Source: https://www.nyse.com/markets/hours-calendars ("Holidays & Trading Hours"),
-- read 2026-09-26. Core session 09:30-16:00 ET; early closes end the core session at 13:00 ET.
-- private.is_us_regular_session now returns false on a holiday and after 13:00 ET on an
-- early-close day, so an equity invalidation print then is review_at_open, not exit_full_lot.
-- Keep in sync with packages/contracts/src/market-calendar.ts (NYSE_CALENDAR).

create table if not exists public.us_equity_market_calendar (
  day date primary key,
  kind text not null check (kind in ('holiday', 'early_close')),
  close_et time check ((kind = 'early_close') = (close_et is not null)),
  name text not null,
  source text not null default 'https://www.nyse.com/markets/hours-calendars',
  created_at timestamptz not null default now()
);

comment on table public.us_equity_market_calendar is
  'NYSE full-day holidays and early closes (core session ends at close_et, ET). Source: nyse.com/markets/hours-calendars. Weekends are implicit. Mirrors NYSE_CALENDAR in packages/contracts/src/market-calendar.ts.';

alter table public.us_equity_market_calendar enable row level security;
grant select on public.us_equity_market_calendar
  to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role;
drop policy if exists calendar_read on public.us_equity_market_calendar;
create policy calendar_read on public.us_equity_market_calendar
  for select to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker
  using (true);

insert into public.us_equity_market_calendar (day, kind, close_et, name) values
  ('2026-01-01', 'holiday', null, 'New Year''s Day'),
  ('2026-01-19', 'holiday', null, 'Martin Luther King, Jr. Day'),
  ('2026-02-16', 'holiday', null, 'Washington''s Birthday'),
  ('2026-04-03', 'holiday', null, 'Good Friday'),
  ('2026-05-25', 'holiday', null, 'Memorial Day'),
  ('2026-06-19', 'holiday', null, 'Juneteenth National Independence Day'),
  ('2026-07-03', 'holiday', null, 'Independence Day (observed)'),
  ('2026-09-07', 'holiday', null, 'Labor Day'),
  ('2026-11-26', 'holiday', null, 'Thanksgiving Day'),
  ('2026-11-27', 'early_close', '13:00', 'Day after Thanksgiving'),
  ('2026-12-24', 'early_close', '13:00', 'Christmas Eve'),
  ('2026-12-25', 'holiday', null, 'Christmas Day'),
  ('2027-01-01', 'holiday', null, 'New Year''s Day'),
  ('2027-01-18', 'holiday', null, 'Martin Luther King, Jr. Day'),
  ('2027-02-15', 'holiday', null, 'Washington''s Birthday'),
  ('2027-03-26', 'holiday', null, 'Good Friday'),
  ('2027-05-31', 'holiday', null, 'Memorial Day'),
  ('2027-06-18', 'holiday', null, 'Juneteenth National Independence Day (observed)'),
  ('2027-07-05', 'holiday', null, 'Independence Day (observed)'),
  ('2027-09-06', 'holiday', null, 'Labor Day'),
  ('2027-11-25', 'holiday', null, 'Thanksgiving Day'),
  ('2027-11-26', 'early_close', '13:00', 'Day after Thanksgiving'),
  ('2027-12-24', 'holiday', null, 'Christmas Day (observed)'),
  ('2028-01-17', 'holiday', null, 'Martin Luther King, Jr. Day'),
  ('2028-02-21', 'holiday', null, 'Washington''s Birthday'),
  ('2028-04-14', 'holiday', null, 'Good Friday'),
  ('2028-05-29', 'holiday', null, 'Memorial Day'),
  ('2028-06-19', 'holiday', null, 'Juneteenth National Independence Day'),
  ('2028-07-03', 'early_close', '13:00', 'Day before Independence Day'),
  ('2028-07-04', 'holiday', null, 'Independence Day'),
  ('2028-09-04', 'holiday', null, 'Labor Day'),
  ('2028-11-23', 'holiday', null, 'Thanksgiving Day'),
  ('2028-11-24', 'early_close', '13:00', 'Day after Thanksgiving'),
  ('2028-12-25', 'holiday', null, 'Christmas Day')
on conflict (day) do update set kind = excluded.kind, close_et = excluded.close_et, name = excluded.name;

create or replace function private.is_us_regular_session(p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_at is not null
    and extract(isodow from (p_at at time zone 'America/New_York')) between 1 and 5
    and (p_at at time zone 'America/New_York')::time >= time '09:30'
    and (p_at at time zone 'America/New_York')::time < coalesce(
      (select case when c.kind = 'holiday' then time '00:00' else c.close_et end
         from public.us_equity_market_calendar c
        where c.day = (p_at at time zone 'America/New_York')::date),
      time '16:00');
$$;

comment on function private.is_us_regular_session(timestamptz) is
  'True inside the NYSE core session: Mon-Fri 09:30 ET to 16:00 ET (13:00 on early-close days), never on a holiday (public.us_equity_market_calendar).';

grant execute on function private.is_us_regular_session(timestamptz)
  to authenticated, quantanamo_worker, desk_public_reader, service_role;

-- Stewards can ask the same question.
create or replace function public.us_regular_session_open(p_at timestamptz default now())
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_at is not null
    and extract(isodow from (p_at at time zone 'America/New_York')) between 1 and 5
    and (p_at at time zone 'America/New_York')::time >= time '09:30'
    and (p_at at time zone 'America/New_York')::time < coalesce(
      (select case when c.kind = 'holiday' then time '00:00' else c.close_et end
         from public.us_equity_market_calendar c
        where c.day = (p_at at time zone 'America/New_York')::date),
      time '16:00');
$$;

comment on function public.us_regular_session_open(timestamptz) is
  'NYSE core session open at p_at (holidays and 13:00 ET early closes included). Same rule as the invalidation watchdog and position-decision.';

revoke all on function public.us_regular_session_open(timestamptz) from public, anon;
grant execute on function public.us_regular_session_open(timestamptz)
  to authenticated, quantanamo_worker, oddsborne_worker, bandit_worker, desk_public_reader, service_role;
