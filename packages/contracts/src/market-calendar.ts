/**
 * NYSE market holidays and early closes, 2026-2028.
 * Source: https://www.nyse.com/markets/hours-calendars ("Holidays & Trading Hours"), read 2026-09-26.
 * Core session 09:30-16:00 America/New_York; an early close ends the core session at 13:00 ET.
 * Mirrors public.us_equity_market_calendar (supabase/schemas/29_us_market_calendar.sql). Extend
 * both together when NYSE publishes a new year.
 */
export type MarketCalendarDay = { kind: 'holiday' | 'early_close'; closeEt?: string; name: string };

export const NYSE_CALENDAR_SOURCE = 'https://www.nyse.com/markets/hours-calendars';

export const NYSE_CALENDAR: Readonly<Record<string, MarketCalendarDay>> = {
  '2026-01-01': { kind: 'holiday', name: "New Year's Day" },
  '2026-01-19': { kind: 'holiday', name: 'Martin Luther King, Jr. Day' },
  '2026-02-16': { kind: 'holiday', name: "Washington's Birthday" },
  '2026-04-03': { kind: 'holiday', name: 'Good Friday' },
  '2026-05-25': { kind: 'holiday', name: 'Memorial Day' },
  '2026-06-19': { kind: 'holiday', name: 'Juneteenth National Independence Day' },
  '2026-07-03': { kind: 'holiday', name: 'Independence Day (observed)' },
  '2026-09-07': { kind: 'holiday', name: 'Labor Day' },
  '2026-11-26': { kind: 'holiday', name: 'Thanksgiving Day' },
  '2026-11-27': { kind: 'early_close', closeEt: '13:00', name: 'Day after Thanksgiving' },
  '2026-12-24': { kind: 'early_close', closeEt: '13:00', name: 'Christmas Eve' },
  '2026-12-25': { kind: 'holiday', name: 'Christmas Day' },
  '2027-01-01': { kind: 'holiday', name: "New Year's Day" },
  '2027-01-18': { kind: 'holiday', name: 'Martin Luther King, Jr. Day' },
  '2027-02-15': { kind: 'holiday', name: "Washington's Birthday" },
  '2027-03-26': { kind: 'holiday', name: 'Good Friday' },
  '2027-05-31': { kind: 'holiday', name: 'Memorial Day' },
  '2027-06-18': { kind: 'holiday', name: 'Juneteenth National Independence Day (observed)' },
  '2027-07-05': { kind: 'holiday', name: 'Independence Day (observed)' },
  '2027-09-06': { kind: 'holiday', name: 'Labor Day' },
  '2027-11-25': { kind: 'holiday', name: 'Thanksgiving Day' },
  '2027-11-26': { kind: 'early_close', closeEt: '13:00', name: 'Day after Thanksgiving' },
  '2027-12-24': { kind: 'holiday', name: 'Christmas Day (observed)' },
  '2028-01-17': { kind: 'holiday', name: 'Martin Luther King, Jr. Day' },
  '2028-02-21': { kind: 'holiday', name: "Washington's Birthday" },
  '2028-04-14': { kind: 'holiday', name: 'Good Friday' },
  '2028-05-29': { kind: 'holiday', name: 'Memorial Day' },
  '2028-06-19': { kind: 'holiday', name: 'Juneteenth National Independence Day' },
  '2028-07-03': { kind: 'early_close', closeEt: '13:00', name: 'Day before Independence Day' },
  '2028-07-04': { kind: 'holiday', name: 'Independence Day' },
  '2028-09-04': { kind: 'holiday', name: 'Labor Day' },
  '2028-11-23': { kind: 'holiday', name: 'Thanksgiving Day' },
  '2028-11-24': { kind: 'early_close', closeEt: '13:00', name: 'Day after Thanksgiving' },
  '2028-12-25': { kind: 'holiday', name: 'Christmas Day' },
};

export type UsEquitySession = {
  /** America/New_York calendar day, YYYY-MM-DD. */
  date: string;
  /** Minutes after midnight ET. */
  minutes: number;
  weekday: string;
  status: 'weekend' | 'holiday' | 'pre_open' | 'open' | 'closed';
  /** Core-session close for the day in minutes after midnight ET (780 on an early close), null when closed all day. */
  closeMinutes: number | null;
  calendar: MarketCalendarDay | null;
};

const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;

function hhmmToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

/** Where `ms` falls in the NYSE core session (holidays and early closes included). */
export function usEquitySession(ms: number): UsEquitySession {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const weekday = get('weekday');
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  const calendar = NYSE_CALENDAR[date] ?? null;
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { date, minutes, weekday, status: 'weekend', closeMinutes: null, calendar };
  }
  if (calendar?.kind === 'holiday') {
    return { date, minutes, weekday, status: 'holiday', closeMinutes: null, calendar };
  }
  const closeMinutes = calendar?.kind === 'early_close' && calendar.closeEt
    ? hhmmToMinutes(calendar.closeEt)
    : CLOSE_MINUTES;
  const status = minutes < OPEN_MINUTES ? 'pre_open' : minutes < closeMinutes ? 'open' : 'closed';
  return { date, minutes, weekday, status, closeMinutes, calendar };
}

/** True inside the NYSE core session: Mon-Fri 09:30 ET to 16:00 ET (13:00 on early-close days), never on a holiday. */
export function isUsRegularSession(ms: number): boolean {
  if (!Number.isFinite(ms)) return false;
  return usEquitySession(ms).status === 'open';
}
