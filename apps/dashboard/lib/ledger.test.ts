import { describe, expect, test } from 'bun:test';

import { parseDeskAuthMethods } from './auth-methods';
import { isPublishableKey } from './auth-public';
import { deskAuthErrorMessage, firstSearchParam, isLoopbackIpHost } from './auth-search';
import { mapAccounts, mapExposures } from './ledger-map';
import { asFiniteNumber, asOptionalNumber, asSmallint } from './numbers';
import { isPostgresPermissionDenied, isPostgresUndefinedRelation } from './postgres';
import { encodeRunNotes, parseRunNotes } from './run-notes';
import { nextSlotFire, upcomingWorkerFires, WORKER_SLOTS } from './schedule';
import { isThesisStatus, parseThesisStatus } from './thesis-status';

describe('asSmallint', () => {
  test('accepts numeric strings from Postgres', () => {
    expect(asSmallint('72', 'confidence')).toBe(72);
    expect(asSmallint(0, 'confidence')).toBe(0);
    expect(asSmallint(100, 'confidence')).toBe(100);
  });

  test('rejects fractions and out of range', () => {
    expect(() => asSmallint('12.5', 'confidence')).toThrow(/smallint/);
    expect(() => asSmallint(101, 'confidence')).toThrow(/smallint/);
    expect(() => asSmallint('nope', 'confidence')).toThrow(/number/);
  });
});

describe('asFiniteNumber', () => {
  test('coerces numeric text used for quantities', () => {
    expect(asFiniteNumber('25.2088550000', 'qty')).toBeCloseTo(25.208855);
    expect(asOptionalNumber(null, 'qty')).toBeNull();
    expect(asOptionalNumber('', 'qty')).toBeNull();
  });
});

describe('mapAccounts', () => {
  test('coerces PostgREST numeric strings on Agentic snapshots', () => {
    const rows = mapAccounts([
      {
        observed_at: '2026-08-27T16:22:10.669472+00:00',
        account_label: 'Agentic',
        total_value: '5056.2710',
        equity_value: '4907.7710',
        cash: '148.50',
        buying_power: '148.50',
        source: 'robinhood_mcp',
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.total_value).toBeCloseTo(5056.271);
    expect(rows[0]?.equity_value).toBeCloseTo(4907.771);
    expect(rows[0]?.cash).toBeCloseTo(148.5);
    expect(rows[0]?.buying_power).toBeCloseTo(148.5);
  });
});

describe('mapExposures', () => {
  test('coerces last_price numeric strings and keeps missing marks null', () => {
    const rows = mapExposures([
      {
        symbol: 'CIFR',
        quantity: '63.2115240000',
        average_buy_price: '15.820000',
        last_price: '16.615',
        observed_at: '2026-08-27T16:37:52.267794+00:00',
        account_last4: '7638',
      },
      {
        symbol: 'DG',
        quantity: '14',
        average_buy_price: '132.250000',
        observed_at: '2026-08-27T16:37:52.267794+00:00',
        account_last4: '7638',
      },
    ]);
    expect(rows[0]?.last_price).toBeCloseTo(16.615);
    expect(rows[0]?.average_buy_price).toBeCloseTo(15.82);
    expect(rows[1]?.last_price).toBeNull();
  });
});

describe('parseRunNotes', () => {
  test('reads outcome from JSON notes', () => {
    const parsed = parseRunNotes(
      JSON.stringify({ outcome: 'failed', error: 'X token refresh failed with status 400' }),
      'bookmark_ingest',
      true,
    );
    expect(parsed.outcome).toBe('failed');
    expect(parsed.error).toContain('X token refresh');
  });

  test('plain-text grokbot notes stay passed when complete', () => {
    const parsed = parseRunNotes(
      'Live Agentic fills IREN/NBIS/CIFR. Independent gate: NVDA Q2 FY27 AMC 2026-08-26.',
      'grokbot_live',
      true,
    );
    expect(parsed.outcome).toBe('passed');
    expect(parsed.summary).toContain('IREN/NBIS/CIFR');
    expect(parsed.headline).toBe('Grokbot Live');
  });

  test('incomplete runs are running', () => {
    const parsed = parseRunNotes(null, 'cloud_research', false);
    expect(parsed.outcome).toBe('running');
  });

  test('encodeRoundTrip includes required outcome', () => {
    const encoded = encodeRunNotes({
      outcome: 'passed',
      headline: 'Operator note',
      summary: 'Logged from the local desk',
    });
    const parsed = parseRunNotes(encoded, 'operator_note', true);
    expect(parsed.outcome).toBe('passed');
    expect(parsed.headline).toBe('Operator note');
  });
});

describe('thesis status', () => {
  test('accepts the live lifecycle', () => {
    expect(parseThesisStatus('forming')).toBe('forming');
    expect(parseThesisStatus('hardening')).toBe('hardening');
    expect(isThesisStatus('rejected')).toBe(true);
    expect(isThesisStatus('killed')).toBe(true);
    expect(isThesisStatus('active')).toBe(false);
  });
});

describe('worker schedule', () => {
  test('next weekday research slot is after the from-time', () => {
    // Wednesday 2026-08-26 19:12 UTC is 15:12 ET — after the 15:05 research slot.
    const from = Date.parse('2026-08-26T19:12:00.000Z');
    const fires = upcomingWorkerFires(from, 4);
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((fire) => Date.parse(fire.at) > from)).toBe(true);
    const research = WORKER_SLOTS.find((slot) => slot.id === 'research-am');
    expect(research).toBeDefined();
    const nextMorning = nextSlotFire(research!, from);
    expect(nextMorning).not.toBeNull();
    expect(new Date(nextMorning!).toISOString()).toContain('2026-08-27');
  });
});

describe('postgres permission errors', () => {
  test('matches table and relation denials', () => {
    expect(isPostgresPermissionDenied('permission denied for table cloud_runs')).toBe(true);
    expect(isPostgresPermissionDenied('permission denied for relation trade_intents')).toBe(true);
    expect(isPostgresPermissionDenied('duplicate key value violates unique constraint')).toBe(false);
    expect(isPostgresUndefinedRelation('relation "pm_markets" does not exist')).toBe(true);
    expect(isPostgresUndefinedRelation('permission denied for table pm_markets')).toBe(false);
  });
});

describe('publishable keys', () => {
  test('accepts modern publishable and anon JWT, rejects secrets', () => {
    expect(isPublishableKey('sb_publishable_test_key')).toBe(true);
    expect(isPublishableKey('sb_secret_do_not_use')).toBe(false);
    expect(isPublishableKey('eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYW5vbiJ9.x')).toBe(true);
    expect(isPublishableKey('eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x')).toBe(false);
  });
});

describe('auth method flags', () => {
  test('hides social oauth when GoTrue has them off', () => {
    const methods = parseDeskAuthMethods(
      {
        external: { email: true, github: false, google: false },
        passkeys_enabled: true,
      },
      ['github', 'google'],
    );
    expect(methods.email).toBe(true);
    expect(methods.passkeys).toBe(true);
    expect(methods.oauth).toEqual([]);
  });

  test('keeps preferred oauth order among enabled providers', () => {
    const methods = parseDeskAuthMethods(
      {
        external: { email: true, github: true, google: true, azure: true },
        passkeys_enabled: true,
      },
      ['google', 'github'],
    );
    expect(methods.oauth).toEqual(['google', 'github', 'azure']);
  });
});

describe('auth gate search params', () => {
  test('reads auth_error from string or repeated query values', () => {
    expect(firstSearchParam(undefined)).toBeNull();
    expect(firstSearchParam('')).toBeNull();
    expect(firstSearchParam('  ')).toBeNull();
    expect(firstSearchParam('provider is not enabled')).toBe('provider is not enabled');
    expect(firstSearchParam(['missing_auth_code', 'other'])).toBe('missing_auth_code');
  });

  test('forbidden operator message wins over callback error', () => {
    expect(deskAuthErrorMessage(true, 'missing_auth_code')).toBe(
      'This account is not on the operator allowlist.',
    );
    expect(deskAuthErrorMessage(false, 'Unsupported provider: provider is not enabled')).toBe(
      'Unsupported provider: provider is not enabled',
    );
    expect(deskAuthErrorMessage(false, null)).toBeNull();
  });

  test('passkey hint only on 127.0.0.1, not localhost', () => {
    expect(isLoopbackIpHost('127.0.0.1')).toBe(true);
    expect(isLoopbackIpHost('127.0.0.1:5173')).toBe(true);
    expect(isLoopbackIpHost('localhost:5173')).toBe(false);
    expect(isLoopbackIpHost('localhost')).toBe(false);
  });
});
