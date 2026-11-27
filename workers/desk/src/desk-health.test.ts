import { describe, expect, test } from 'bun:test';

import { bundleHealthFields, marketSessionHealth, shouldWarmDeskBundle } from './desk-health';

describe('desk health freshness', () => {
  test('Thanksgiving noon is a holiday, and the Friday half session closes at 13:00 ET', () => {
    const thanksgiving = marketSessionHealth(Date.parse('2026-11-26T17:00:00.000Z'));
    expect(thanksgiving).toMatchObject({
      open: false,
      status: 'holiday',
      date: '2026-11-26',
      early_close: false,
      close_et: null,
      name: 'Thanksgiving Day',
    });
    expect(shouldWarmDeskBundle(Date.parse('2026-11-26T17:00:00.000Z'))).toBe(false);

    const halfDay = marketSessionHealth(Date.parse('2026-11-27T16:00:00.000Z'));
    expect(halfDay).toMatchObject({
      open: true,
      status: 'open',
      date: '2026-11-27',
      early_close: true,
      close_et: '13:00',
      name: 'Day after Thanksgiving',
    });
    expect(shouldWarmDeskBundle(Date.parse('2026-11-27T16:00:00.000Z'))).toBe(true);

    const afterClose = marketSessionHealth(Date.parse('2026-11-27T18:00:00.000Z'));
    expect(afterClose).toMatchObject({
      open: false,
      status: 'closed',
      date: '2026-11-27',
      early_close: true,
      close_et: '13:00',
      name: 'Day after Thanksgiving',
    });
    expect(shouldWarmDeskBundle(Date.parse('2026-11-27T18:00:00.000Z'))).toBe(false);

    const weekend = marketSessionHealth(Date.parse('2026-11-28T16:00:00.000Z'));
    expect(weekend.status).toBe('weekend');
    expect(weekend.open).toBe(false);
    expect(shouldWarmDeskBundle(Date.parse('2026-11-28T16:00:00.000Z'))).toBe(false);
  });

  test('the Friday noon bundle age is the cache, not the mark', () => {
    const now = Date.parse('2026-11-27T17:27:00.000Z');
    const fields = bundleHealthFields({
      generated_at: '2026-11-27T13:52:00.000Z',
      bundle_refreshing: true,
      ledger_snapshot_at: '2026-11-27T17:26:00.000Z',
      ledger_mark_at: '2026-11-27T17:26:30.000Z',
    }, now);
    expect(fields.bundle_generated_at).toBe('2026-11-27T13:52:00.000Z');
    expect(fields.bundle_age_s).toBe(3 * 60 * 60 + 35 * 60);
    expect(fields.bundle_stale).toBe(true);
    expect(fields.bundle_refreshing).toBe(true);
    expect(fields.ledger_snapshot_age_s).toBe(60);
    expect(fields.ledger_mark_age_s).toBe(30);
    expect(fields.market_session.open).toBe(true);
    expect(fields.market_session.early_close).toBe(true);

    const fresh = bundleHealthFields({
      generated_at: '2026-11-27T17:26:40.000Z',
      ledger_snapshot_at: '2026-11-27T17:26:00.000Z',
      ledger_mark_at: '2026-11-27T17:26:30.000Z',
    }, now);
    expect(fresh.bundle_stale).toBe(false);
    expect(fresh.bundle_age_s).toBe(20);
    expect(fresh.bundle_refreshing).toBe(false);
  });

  test('the warmer cron covers the ET session in both EST and EDT', async () => {
    const wrangler = await Bun.file(new URL('../wrangler.jsonc', import.meta.url)).text();
    expect(wrangler).toContain('"crons": ["* 13-21 * * MON-FRI"]');
  });
});
