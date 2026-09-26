import { usEquitySession } from '@quantanamo/contracts/market-calendar';

export type MarketGate = {
  date: string;
  time: string;
  weekday: string;
  slot: string | null;
  actionable: boolean;
  reason: string;
};

type NewYorkParts = Pick<MarketGate, 'date' | 'time' | 'weekday'>;

function nyParts(timestamp: number): NewYorkParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday: get('weekday'),
  };
}

export function marketGate(timestamp: number, forcedSlot?: string): MarketGate {
  const local = nyParts(timestamp);
  const slots = new Map([
    ['10:05', 'morning'],
    ['15:05', 'pre_close'],
  ]);
  const weekday = !['Sat', 'Sun'].includes(local.weekday);
  const slot = forcedSlot || slots.get(local.time) || null;
  // NYSE holidays and early closes: no research/trade window when the core session is shut.
  const session = usEquitySession(timestamp);
  const holiday = weekday && session.status === 'holiday';
  const pastEarlyClose = weekday && session.calendar?.kind === 'early_close' && session.status === 'closed';
  const actionable = weekday && !holiday && !pastEarlyClose && slot !== null;
  return {
    ...local,
    slot,
    actionable,
    reason: actionable
      ? 'scheduled_research_window'
      : !weekday ? 'weekend'
      : holiday ? 'market_holiday'
      : pastEarlyClose ? 'market_early_close'
      : 'dst_guard_or_unscheduled_time',
  };
}
