import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { isUsRegularSession, NYSE_CALENDAR, usEquityMarkSession, usEquitySession } from './market-calendar';

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

  test('mark session: pre / rth / post / closed, same boundaries as private.us_equity_session', () => {
    const at = (iso: string) => usEquityMarkSession(Date.parse(iso));
    // 2026-10-06 CODA: the 06:05 PT premarket print and the 06:46 PT regular-session mark.
    expect(at('2026-10-06T13:05:32Z')).toBe('pre');
    expect(at('2026-10-06T13:46:45Z')).toBe('rth');
    expect(at('2026-10-06T13:29:59Z')).toBe('pre');
    expect(at('2026-10-06T13:30:00Z')).toBe('rth');
    expect(at('2026-10-06T19:59:59Z')).toBe('rth');
    expect(at('2026-10-06T20:00:00Z')).toBe('post');
    expect(at('2026-10-05T23:21:33Z')).toBe('post');
    expect(at('2026-10-07T00:00:00Z')).toBe('closed');
    expect(at('2026-10-06T07:59:59Z')).toBe('closed');
    expect(at('2026-10-06T08:00:00Z')).toBe('pre');
    expect(at('2026-10-10T15:00:00Z')).toBe('closed');
    expect(at('2026-09-07T15:00:00Z')).toBe('closed');
    expect(at('2026-11-27T17:59:00Z')).toBe('rth');
    expect(at('2026-11-27T18:00:00Z')).toBe('post');
    expect(at('2026-11-27T22:00:00Z')).toBe('closed');
    expect(usEquityMarkSession(Number.NaN)).toBeNull();
  });

  test('mark session rth is exactly the regular session, every 15 minutes over two weeks', () => {
    const windows = [['2026-10-02T00:00:00Z', '2026-10-09T00:00:00Z'], ['2026-11-24T00:00:00Z', '2026-12-01T00:00:00Z']];
    for (const [from, to] of windows) {
      for (let ms = Date.parse(from!); ms <= Date.parse(to!); ms += 15 * 60_000) {
        expect(usEquityMarkSession(ms) === 'rth').toBe(isUsRegularSession(ms));
      }
    }
  });

  test('the SQL session function and its test are the migration at the prod version', () => {
    const root = join(import.meta.dir, '../../..');
    const sql = readFileSync(join(root, 'supabase/schemas/54_equity_mark_session.sql'), 'utf8');
    expect(readFileSync(join(root, 'supabase/migrations/20261006140004_equity_mark_session.sql'), 'utf8')).toBe(sql);
    expect(sql).toContain("when cal.tod >= time '04:00' and cal.tod < time '09:30' then 'pre'");
    expect(sql).toContain("case when c.kind = 'early_close' then time '17:00' else time '20:00' end as post_end");
    expect(sql).toContain("when lot_table = 'position_episodes' and not coalesce(mark_in_regular_session, false) then 'review_at_open'");
    expect(sql).toContain('       end as action_hint,\n       mark_session\nfrom public.v_open_lot_marks');
    expect(sql).toContain('       null::text\nfrom public.pm_positions p');
    expect(sql).toContain('       null::text\nfrom public.meme_positions p');
    expect(sql).not.toMatch(/alter table public\.(portfolio_exposure|position_episodes)/);
    const check = readFileSync(join(root, 'supabase/tests/54_equity_mark_session.sql'), 'utf8');
    expect(check).toContain("private.us_equity_session('2026-10-06 13:05:32+00') = 'pre'");
  });
});
