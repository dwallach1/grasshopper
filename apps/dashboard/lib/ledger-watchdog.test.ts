import { describe, expect, test } from 'bun:test';

import { assembleDeskBookHealth, deskHealthSummary } from './desk-book-health';
import { emptyLedgerWatchdog, exposureLine, mapLedgerWatchdog, watchdogHealthSummary } from './ledger-watchdog';
import type { DeskPayload } from './ledger-types';

describe('ledger watchdog', () => {
  test('missing views serve an unavailable, zeroed payload', () => {
    expect(mapLedgerWatchdog(undefined)).toEqual(emptyLedgerWatchdog());
    expect(mapLedgerWatchdog({ summary: [] }).available).toBe(false);
  });

  test('maps counts and lists; breaches and missing lots become health alerts', () => {
    const watchdog = mapLedgerWatchdog({
      summary: [{
        checked_at: '2026-09-26T18:00:00Z', invalidation_breaches: '1', breaches_actionable: 1,
        breaches_review_at_open: 0, lots_missing_invalidation: 1, integrity_issues: 2, integrity_errors: 0,
        integrity: { open_lot_without_thesis: 2 }, open_lots: 4,
      }],
      breaches: [{
        steward: 'bandit', lot_table: 'meme_positions', lot_id: 'x', instrument: 'YAP', unit: 'SOL',
        invalidation_price: '0.00002', mark: 0.000019, mark_at: '2026-09-26T17:59:00Z', action_hint: 'exit_full_lot',
      }],
      missing: [{ steward: 'oddsborne', lot_table: 'pm_positions', lot_id: 'y', instrument: 'nfl yes', unit: 'USD' }],
    });
    expect(watchdog.available).toBe(true);
    expect(watchdog.invalidation_breaches).toBe(1);
    expect(watchdog.breaches[0]).toMatchObject({ unit: 'SOL', invalidation_price: 0.00002, mark: 0.000019 });
    expect(watchdogHealthSummary(watchdog)).toMatchObject({
      watchdog_available: true, invalidation_breaches: 1, lots_missing_invalidation: 1, integrity_issues: 2,
    });
    const health = assembleDeskBookHealth({ watchdog } as unknown as DeskPayload, Date.parse('2026-09-26T18:00:00Z'));
    expect(health.alerts.map((alert) => alert.kind)).toEqual(['invalidation_breach', 'missing_invalidation']);
    expect(health.alerts[0]?.detail).toContain('0.00001900 SOL');
    expect(deskHealthSummary(health)).toMatchObject({ invalidation_breaches: 1, lots_missing_invalidation: 1 });
  });

  test('exposure: per-steward open risk vs the 10% budget from the watchdog summary, in order', () => {
    const watchdog = mapLedgerWatchdog({
      summary: [{
        checked_at: '2026-09-26T22:00:00Z', open_lots: 3, exposure_over_budget: 1,
        exposure: {
          bandit: { unit: 'SOL', open_risk: 0, risk_budget: 0.180319, used_share: 0, headroom: 0.180319 },
          quantanamo: { unit: 'USD', open_risk: '654.354', risk_budget: '550.065', used_share: '0.119', headroom: '-104.289' },
          oddsborne: { unit: 'USD', open_risk: 0, risk_budget: 27.687, used_share: 0, headroom: 27.687 },
        },
      }],
    });
    expect(watchdog.exposure.map((row) => row.steward)).toEqual(['quantanamo', 'oddsborne', 'bandit']);
    expect(watchdog.exposure[0]).toMatchObject({ over: true, open_risk: 654.354, risk_budget: 550.065 });
    expect(exposureLine(watchdog.exposure[0]!)).toBe('risk $654 / $550 budget');
    expect(exposureLine(watchdog.exposure[2]!)).toBe('risk 0.000 SOL / 0.180 SOL budget');
    expect(watchdog.exposure[1]?.over).toBe(false);
    expect(watchdogHealthSummary(watchdog).exposure_over_budget).toBe(1);
    expect(mapLedgerWatchdog({ summary: [{ open_lots: 0 }] }).exposure).toEqual([]);
  });
});
