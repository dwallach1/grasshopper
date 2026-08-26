const NY_TZ = 'America/New_York';
const WEEKDAY_SHORT = new Map([
  ['Sun', 0],
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
]);

export type WorkerSlot = {
  id: string;
  name: string;
  weekdayOnly: boolean;
  hour: number;
  minute: number;
  sundayOnly?: boolean;
};

/** Production Cron, expressed in America/New_York after the DST dual-UTC gate. */
export const WORKER_SLOTS: WorkerSlot[] = [
  { id: 'knowledge-am', name: 'Knowledge ingest', weekdayOnly: true, hour: 9, minute: 35 },
  { id: 'research-am', name: 'Research workflow', weekdayOnly: true, hour: 10, minute: 5 },
  { id: 'knowledge-pm', name: 'Knowledge ingest', weekdayOnly: true, hour: 14, minute: 35 },
  { id: 'research-pm', name: 'Research workflow', weekdayOnly: true, hour: 15, minute: 5 },
];

export type ScheduledFire = {
  id: string;
  name: string;
  at: string;
  source: 'cron' | 'cloud_run' | 'automation';
};

type NyParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

function nyPartsFromTimestamp(timestamp: number): NyParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || '';
  const weekdayName = get('weekday');
  const weekday = WEEKDAY_SHORT.get(weekdayName);
  if (weekday === undefined) {
    throw new Error(`Unknown weekday token ${weekdayName}`);
  }
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function nyLocalToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  let low = Date.UTC(year, month - 1, day - 1, 0, 0);
  let high = Date.UTC(year, month - 1, day + 1, 23, 59);
  const target = year * 1e8 + month * 1e6 + day * 1e4 + hour * 100 + minute;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const parts = nyPartsFromTimestamp(mid);
    const key = parts.year * 1e8 + parts.month * 1e6 + parts.day * 1e4 + parts.hour * 100 + parts.minute;
    if (key === target) return mid;
    if (key < target) low = mid + 60_000;
    else high = mid - 60_000;
  }
  return Date.UTC(year, month - 1, day, hour, minute);
}

function iterNyDays(fromMs: number, count: number): NyParts[] {
  const days: NyParts[] = [];
  const seen = new Set<string>();
  const start = nyPartsFromTimestamp(fromMs);
  let cursor = nyLocalToUtc(start.year, start.month, start.day, 0, 0);
  while (days.length < count) {
    const parts = nyPartsFromTimestamp(cursor);
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    if (!seen.has(key)) {
      seen.add(key);
      days.push(parts);
    }
    cursor += 86_400_000;
  }
  return days;
}

export function nextSlotFire(slot: WorkerSlot, fromMs: number): number | null {
  for (const day of iterNyDays(fromMs, 16)) {
    const isWeekday = day.weekday >= 1 && day.weekday <= 5;
    const isSunday = day.weekday === 0;
    if (slot.sundayOnly && !isSunday) continue;
    if (slot.weekdayOnly && !isWeekday) continue;
    const at = nyLocalToUtc(day.year, day.month, day.day, slot.hour, slot.minute);
    if (at > fromMs) return at;
  }
  return null;
}

export function upcomingWorkerFires(fromMs: number, limit: number): ScheduledFire[] {
  const fires: ScheduledFire[] = [];
  for (const slot of WORKER_SLOTS) {
    const at = nextSlotFire(slot, fromMs);
    if (at === null) continue;
    fires.push({
      id: slot.id,
      name: slot.name,
      at: new Date(at).toISOString(),
      source: 'cron',
    });
  }
  fires.sort((a, b) => a.at.localeCompare(b.at));
  return fires.slice(0, limit);
}
