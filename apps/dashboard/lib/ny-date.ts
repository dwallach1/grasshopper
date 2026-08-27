const NY_TZ = 'America/New_York';

const nyDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const nyStampFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const nyClockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

function nyPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

/** Calendar day in America/New_York (`YYYY-MM-DD`). */
export function nyDateKey(iso: string): string {
  return nyDay.format(new Date(iso));
}

/** True when two ledger timestamps are the same instant after ISO coercion. */
export function sameInstant(left: string, right: string): boolean {
  return new Date(left).getTime() === new Date(right).getTime();
}

/**
 * Hydration-stable NY stamp. ICU `format()` emits `at` on Bun/Node and a comma
 * in Chromium; assemble from parts so SSR and hydrate match.
 */
export function nyStamp(timestamp: string | null | undefined): string {
  if (!timestamp) return '—';
  const parts = nyStampFmt.formatToParts(new Date(timestamp));
  const month = nyPart(parts, 'month');
  const day = nyPart(parts, 'day');
  const hour = nyPart(parts, 'hour');
  const minute = nyPart(parts, 'minute');
  const period = nyPart(parts, 'dayPeriod');
  return `${month} ${day}, ${hour}:${minute} ${period} ET`;
}

export function nyClock(timestamp: string | null | undefined): string {
  if (!timestamp) return '—';
  const parts = nyClockFmt.formatToParts(new Date(timestamp));
  const hour = nyPart(parts, 'hour');
  const minute = nyPart(parts, 'minute');
  const second = nyPart(parts, 'second');
  const period = nyPart(parts, 'dayPeriod');
  return `${hour}:${minute}:${second} ${period}`;
}
