const NY_TZ = 'America/New_York';

const nyDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar day in America/New_York (`YYYY-MM-DD`). */
export function nyDateKey(iso: string): string {
  return nyDay.format(new Date(iso));
}
