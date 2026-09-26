import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { isUsRegularSession, NYSE_CALENDAR, usEquitySession } from './market-calendar';

describe('NYSE market calendar', () => {
  test('holidays, early closes, weekends and DST', () => {
    expect(isUsRegularSession(Date.parse('2026-09-23T13:30:00Z'))).toBe(true);
    expect(isUsRegularSession(Date.parse('2026-09-23T19:59:00Z'))).toBe(true);
    expect(isUsRegularSession(Date.parse('2026-09-23T20:00:00Z'))).toBe(false);
    expect(isUsRegularSession(Date.parse('2026-12-02T14:30:00Z'))).toBe(true);
    expect(usEquitySession(Date.parse('2026-12-25T15:00:00Z')).status).toBe('holiday');
    expect(usEquitySession(Date.parse('2026-12-24T17:59:00Z')).status).toBe('open');
    expect(usEquitySession(Date.parse('2026-12-24T18:00:00Z'))).toMatchObject({ status: 'closed', closeMinutes: 780 });
    expect(usEquitySession(Date.parse('2026-09-26T15:00:00Z')).status).toBe('weekend');
    expect(usEquitySession(Date.parse('2026-09-28T13:00:00Z')).status).toBe('pre_open');
    expect(isUsRegularSession(Number.NaN)).toBe(false);
  });

  test('every day matches the SQL calendar (supabase/schemas/29_us_market_calendar.sql)', () => {
    const sql = readFileSync(join(import.meta.dir, '../../../supabase/schemas/29_us_market_calendar.sql'), 'utf8');
    const rows = [...sql.matchAll(/\('(\d{4}-\d{2}-\d{2})', '(holiday|early_close)', (null|'13:00')/g)];
    expect(rows.length).toBe(Object.keys(NYSE_CALENDAR).length);
    for (const [, day, kind, close] of rows) {
      expect(NYSE_CALENDAR[day!]?.kind).toBe(kind as 'holiday' | 'early_close');
      expect(NYSE_CALENDAR[day!]?.closeEt ?? 'null').toBe(close === 'null' ? 'null' : '13:00');
    }
  });
});
