import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assembleDeskBookHealth, deskHealthSummary } from './desk-book-health';
import {
  addFlagsLineVsCost,
  breachDecidesAtOpen,
  emptyLedgerWatchdog,
  escalatedBreachSentence,
  exposureLine,
  learningGapHoldingId,
  mapLedgerWatchdog,
  ontologyFreshnessLine,
  replayActionableBreachChecks,
  watchdogHealthSummary,
} from './ledger-watchdog';
import type { DeskPayload } from './ledger-types';
import { assembleStewardBooks, checkText } from './steward-books';

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
    expect(watchdog.learning_gaps).toEqual({ quantanamo: 0, oddsborne: 0, bandit: 0 });
    expect(watchdog.unscoreable_decisions).toEqual({ quantanamo: 0, oddsborne: 0, bandit: 0 });
    expect(watchdog.learning_gap_lots).toEqual([]);
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

  test('learning gaps are a per-steward count, not a trading alert', () => {
    const watchdog = mapLedgerWatchdog({
      summary: [{
        checked_at: '2026-10-05T17:00:00Z',
        invalidation_breaches: 0,
        integrity_issues: 0,
        learning_gaps: {
          quantanamo: 1,
          oddsborne: 2,
          bandit: 0,
          lots: [
            { steward: 'oddsborne', lot_table: 'pm_positions', lot_id: 'pm-1' },
            { steward: 'quantanamo', lot_table: 'position_episodes', lot_id: 'eq-1' },
            { steward: 'nope', lot_table: 'pm_positions', lot_id: 'skip' },
          ],
        },
      }],
    });
    expect(watchdog.learning_gaps).toEqual({ quantanamo: 1, oddsborne: 2, bandit: 0 });
    expect(watchdog.learning_gap_lots.map((row) => learningGapHoldingId(row.lot_table, row.lot_id)))
      .toEqual(['pm:pm-1', 'eq-closed:eq-1']);
    expect(watchdog.integrity_issues).toBe(0);
    expect(watchdogHealthSummary(watchdog).learning_gaps).toEqual(watchdog.learning_gaps);
    expect(watchdogHealthSummary(watchdog).unscoreable_decisions).toEqual(watchdog.unscoreable_decisions);
    expect(watchdog.stale_queued_tests).toBeNull();
    expect(watchdog.unlinked_named_lessons).toBeNull();
    const gaps = mapLedgerWatchdog({ summary: [{ equity_implied_move_gaps: 2, open_lots: 3 }] });
    expect(gaps.equity_implied_move_gaps).toBe(2);
    expect(watchdogHealthSummary(gaps).equity_implied_move_gaps).toBe(2);
    expect(mapLedgerWatchdog({ summary: [{ open_lots: 1 }] }).equity_implied_move_gaps).toBe(0);
    const health = assembleDeskBookHealth({ watchdog } as unknown as DeskPayload, Date.parse('2026-10-05T17:00:00Z'));
    expect(health.alerts).toEqual([]);
    expect(health.integrity_issues).toBe(0);
  });

  test('the learning-loop view is a grace window, not an integrity breach', () => {
    const sql = readFileSync(join(import.meta.dir, '../../../supabase/schemas/49_learning_loop_gaps.sql'), 'utf8');
    expect(readFileSync(join(import.meta.dir, '../../../supabase/migrations/20261005173759_learning_loop_gaps.sql'), 'utf8')).toBe(sql);
    expect(sql).toContain('create or replace view public.v_learning_loop_gaps\nwith (security_invoker = true)');
    expect(sql).toContain("interval '18 hours'");
    expect(sql).toContain("interval '7 days'");
    expect(sql).toContain("coalesce(b.meta->>'kind', '') <> 'outcome_rescore'");
    expect(sql).toContain('l.created_at > c.closed_at');
    expect(sql).toContain('nullif(btrim(pe.thesis_id), \'\') is not null');
    expect(sql).toContain('as learning_gaps');
    const gaps = readFileSync(join(import.meta.dir, '../../../supabase/schemas/81_equity_implied_move_gaps.sql'), 'utf8');
    expect(readFileSync(join(import.meta.dir, '../../../supabase/migrations/20261019193000_equity_implied_move_gaps.sql'), 'utf8')).toBe(gaps);
    expect(gaps).toContain('as equity_implied_move_gaps');
    expect(gaps).toContain('public.equity_implied_move_is_gap');
    expect(gaps).toContain("time '09:30'");
    expect(gaps).toContain("time '20:00'");
    expect(gaps).toContain("pe.status = 'open'");
    expect(gaps).toContain('security invoker');
    const skips = readFileSync(join(import.meta.dir, '../../../supabase/schemas/56_decision_skip_scoring.sql'), 'utf8');
    expect(readFileSync(join(import.meta.dir, '../../../supabase/migrations/20261006173751_decision_skip_scoring.sql'), 'utf8')).toBe(skips);
    expect(skips).toContain('as unscoreable_decisions');
    expect(skips).toContain('public.decision_is_scoreable');
    expect(skips).toContain('to authenticated, desk_public_reader, quantanamo_worker, oddsborne_worker, bandit_worker, service_role');
    expect(skips).toContain("nth_equity_session_close(c.decided_at, 5)");
    expect(skips).toContain("interval '4 hours'");
    expect(skips).toContain('refusal:unscoreable:');
    expect(skips).toContain('security invoker');
    expect(skips).toContain("meta->>'superseded'");
    expect(skips).not.toMatch(/delete from public\.decision_candidates/);
    expect(sql).toContain('from public.v_ledger_integrity');
    expect(sql).not.toContain("'learning_loop_gap'");
    expect(sql.match(/position_episodes|pm_positions|meme_positions/g)?.length).toBeGreaterThanOrEqual(6);
  });

  test('a missing stall column stays unknown, and a present count is not a trading alert', () => {
    const absent = mapLedgerWatchdog({ summary: [{ open_lots: 1 }] });
    expect(absent.stale_queued_tests).toBeNull();
    expect(absent.unlinked_named_lessons).toBeNull();
    expect(watchdogHealthSummary(absent)).toMatchObject({
      stale_queued_tests: null,
      unlinked_named_lessons: null,
    });

    const blank = mapLedgerWatchdog({
      summary: [{ open_lots: 1, stale_queued_tests: null, unlinked_named_lessons: '' }],
    });
    expect(blank.stale_queued_tests).toBeNull();
    expect(blank.unlinked_named_lessons).toBeNull();

    const incomplete = mapLedgerWatchdog({
      summary: [{ stale_queued_tests: { n: 1, quantanamo: 1, oddsborne: 0, bandit: 0 } }],
    });
    expect(incomplete.stale_queued_tests).toBeNull();

    const watchdog = mapLedgerWatchdog({
      summary: [{
        open_lots: 1,
        integrity_issues: 0,
        stale_queued_tests: {
          n: '18',
          quantanamo: 18,
          oddsborne: 0,
          bandit: 0,
          unknown: 0,
          theses: [
            { thesis_id: 'earnings_gap_structure', steward: 'quantanamo', n: 17 },
            { thesis_id: 'semis_photonics', n: '1' },
            { thesis_id: '', steward: 'quantanamo', n: 1 },
            { n: 3 },
          ],
        },
        unlinked_named_lessons: '2',
      }],
    });
    expect(watchdog.stale_queued_tests).toEqual({
      n: 18,
      quantanamo: 18,
      oddsborne: 0,
      bandit: 0,
      unknown: 0,
      theses: [
        { thesis_id: 'earnings_gap_structure', steward: 'quantanamo', n: 17 },
        { thesis_id: 'semis_photonics', steward: 'unknown', n: 1 },
      ],
    });
    expect(watchdog.unlinked_named_lessons).toBe(2);
    const health = watchdogHealthSummary(watchdog);
    expect(health.stale_queued_tests).toEqual(watchdog.stale_queued_tests);
    expect(health.stale_queued_tests).not.toBe(watchdog.stale_queued_tests);
    expect(health.unlinked_named_lessons).toBe(2);
    const book = assembleDeskBookHealth({ watchdog } as unknown as DeskPayload, Date.parse('2026-10-20T17:00:00Z'));
    expect(book.alerts).toEqual([]);
    expect(book.integrity_issues).toBe(0);
  });

  test('schema 83 matches its migration and names the stall without scoring tests', () => {
    const sql = readFileSync(join(import.meta.dir, '../../../supabase/schemas/83_stale_queued_lesson_tests.sql'), 'utf8');
    expect(readFileSync(join(import.meta.dir, '../../../supabase/migrations/20261020180000_stale_queued_lesson_tests.sql'), 'utf8')).toBe(sql);
    expect(sql).toContain('as stale_queued_tests');
    expect(sql).toContain('as unlinked_named_lessons');
    expect(sql).toContain("interval '7 days'");
    expect(sql).toContain('America/New_York');
    expect(sql).toContain('create or replace view public.v_open_lesson_tests\nwith (security_invoker = true)');
    expect(sql).toContain('create or replace view public.v_stale_queued_tests\nwith (security_invoker = true)');
    expect(sql).toContain('and l.test_id is null');
    expect(sql).not.toMatch(/update\s+public\.strategy_tests/i);
  });

  test('ontology freshness is a learning-loop count, not a breach', () => {
    const absent = mapLedgerWatchdog({ summary: [{ open_lots: 1 }] });
    expect(absent.ontology_freshness).toBeNull();
    expect(ontologyFreshnessLine(absent.ontology_freshness)).toBeNull();
    expect(watchdogHealthSummary(absent).ontology_freshness).toBeNull();

    const starved = mapLedgerWatchdog({
      summary: [{
        open_lots: 1,
        ontology_freshness: {
          last_first_seen_at: '2026-09-13 18:11:08.615362+00',
          created_7d: 0,
          pending: 0,
          starved: true,
        },
      }],
    });
    expect(starved.ontology_freshness).toEqual({
      last_first_seen_at: '2026-09-13 18:11:08.615362+00',
      last_seen_at: null,
      newest_evidence_at: null,
      lag_hours: null,
      lagging: false,
      created_7d: 0,
      pending: 0,
      starved: true,
    });
    expect(ontologyFreshnessLine(starved.ontology_freshness)).toBe(
      'Ontology last recorded a candidate on 13 Sep 2026.',
    );
    expect(watchdogHealthSummary(starved).ontology_freshness).toEqual(starved.ontology_freshness);
    expect(watchdogHealthSummary(starved).ontology_freshness).not.toBe(starved.ontology_freshness);

    const fresh = mapLedgerWatchdog({
      summary: [{
        ontology_freshness: {
          last_first_seen_at: '2026-10-27T15:05:13.888Z',
          created_7d: '1',
          pending: 4,
          starved: false,
        },
      }],
    });
    expect(ontologyFreshnessLine(fresh.ontology_freshness)).toBe(
      'Ontology recorded 1 candidate in the last 7 days.',
    );
    expect(assembleDeskBookHealth({ watchdog: fresh } as unknown as DeskPayload, Date.parse('2026-10-27T17:25:00Z')).alerts).toEqual([]);

    const lagging = mapLedgerWatchdog({
      summary: [{
        ontology_freshness: {
          last_first_seen_at: '2026-10-27 15:05:13+00',
          last_seen_at: '2026-10-27 15:05:13+00',
          newest_evidence_at: '2026-10-30 15:48:59+00',
          lag_hours: '72.7',
          lagging: true,
          created_7d: 1,
          pending: 0,
          starved: false,
        },
      }],
    });
    expect(lagging.ontology_freshness).toMatchObject({
      last_seen_at: '2026-10-27 15:05:13+00',
      newest_evidence_at: '2026-10-30 15:48:59+00',
      lag_hours: 72.7,
      lagging: true,
      pending: 0,
    });
    expect(ontologyFreshnessLine(lagging.ontology_freshness)).toBe(
      'Ontology candidates are 73 hours behind the newest bookmark or lesson.',
    );
    expect(watchdogHealthSummary(lagging).ontology_freshness?.lagging).toBe(true);

    const caughtUp = mapLedgerWatchdog({
      summary: [{
        ontology_freshness: {
          last_first_seen_at: '2026-10-30 13:39:04+00',
          last_seen_at: '2026-10-30 13:39:04+00',
          newest_evidence_at: '2026-10-30 15:48:59+00',
          lag_hours: 2.2,
          lagging: false,
          created_7d: 12,
          pending: 12,
          starved: false,
        },
      }],
    });
    expect(ontologyFreshnessLine(caughtUp.ontology_freshness)).toBe(
      'Ontology recorded 12 candidates in the last 7 days.',
    );

    const sql = readFileSync(join(import.meta.dir, '../../../supabase/schemas/88_ontology_candidate_freshness.sql'), 'utf8');
    expect(readFileSync(join(import.meta.dir, '../../../supabase/migrations/20261027180000_ontology_candidate_freshness.sql'), 'utf8')).toBe(sql);
    expect(sql).toContain('as ontology_freshness');
    expect(sql).toContain('private.propose_ontology_candidates');
    expect(sql).toContain('private.reject_junk_ontology_candidates');
    expect(sql).toContain("timestamptz '2026-09-13 00:00:00+00'");
    expect(sql).toContain('security invoker');
    expect(sql).toContain('security definer');
    expect(sql).not.toMatch(/grant execute on function public\.propose_ontology_candidates[\s\S]*to anon/);

    const refresh = readFileSync(join(import.meta.dir, '../../../supabase/schemas/89_ontology_candidate_refresh.sql'), 'utf8');
    expect(readFileSync(join(import.meta.dir, '../../../supabase/migrations/20261030180000_ontology_candidate_refresh.sql'), 'utf8')).toBe(refresh);
    expect(refresh).toContain("interval '36 hours'");
    expect(refresh).toContain("interval '14 days'");
    expect(refresh).toContain('s.n_src >= 2');
    expect(refresh).toContain("'unscoped:' || bookmark_themed.symbol");
    expect(refresh).toContain('lesson_prose');
    expect(refresh).toContain("('TP')");
    expect(refresh).toContain("cron.schedule(");
    expect(refresh).toContain("'propose_ontology_candidates'");
    expect(refresh).toContain("'15 */6 * * *'");
    expect(refresh).not.toMatch(/where c\.id = any\(v_ids\)\s+and c\.status = 'pending'/);
    expect(refresh).not.toMatch(/grant execute on function public\.propose_ontology_candidates[\s\S]*to anon/);
  });
});

describe('session-aware equity breaches (CODA, 2026-10-06)', () => {
  const coda = {
    steward: 'quantanamo', lot_table: 'position_episodes', lot_id: '63afd48b', instrument: 'CODA', unit: 'USD',
    invalidation_price: '10.35', mark: '10.31',
  };
  // 06:05 PT = 09:05 ET: QUANTANAMO's mark on CODA's thin premarket print.
  const premarket = { ...coda, mark_at: '2026-10-06T13:05:32.751992Z', action_hint: 'review_at_open', mark_session: 'pre' };
  const summary = {
    checked_at: '2026-10-06T13:06:00Z', invalidation_breaches: 1, breaches_actionable: 0, breaches_review_at_open: 1,
  };
  const nowMs = Date.parse('2026-10-06T13:06:00Z');
  const bookDesk = (watchdog: ReturnType<typeof mapLedgerWatchdog>): DeskPayload => {
    const partial = { watchdog, book: { names: [], observed_at: null }, positions: [], exposures: [], fills: [], intents: [] };
    // SAFETY: the Book and health assemblers read only these keys when every other book is empty.
    return partial as unknown as DeskPayload;
  };
  const healthOf = (watchdog: ReturnType<typeof mapLedgerWatchdog>) => assembleDeskBookHealth(bookDesk(watchdog), nowMs);

  test('a premarket print through the line decides at the open: never an actionable breach', () => {
    const watchdog = mapLedgerWatchdog({ summary: [summary], breaches: [premarket] });
    expect(watchdog.breaches[0]).toMatchObject({ mark_session: 'pre', action_hint: 'review_at_open', mark: 10.31 });
    expect(breachDecidesAtOpen(watchdog.breaches[0]!)).toBe(true);
    const health = healthOf(watchdog);
    expect(health.alerts.map((alert) => alert.kind)).toEqual(['invalidation_review_at_open']);
    expect(health.alerts[0]?.detail).toBe('premarket print $10.31 under exit $10.35 · decides at open');
    expect(checkText(health.alerts[0]!)).toBe('CODA: premarket print under its exit, decides at open');
    // Counts are the view's, unchanged: one breach, zero actionable, one review at open.
    expect(watchdogHealthSummary(watchdog)).toMatchObject({
      invalidation_breaches: 1, breaches_actionable: 0, breaches_review_at_open: 1,
    });
  });

  test('the Book line for it is quiet copy, not a red breach', () => {
    const watchdog = mapLedgerWatchdog({ summary: [summary], breaches: [premarket] });
    const books = assembleStewardBooks(bookDesk(watchdog), nowMs);
    const quantanamo = books.sections.find((section) => section.slug === 'quantanamo');
    expect(quantanamo?.checks).toEqual([{
      id: 'breach-position_episodes-63afd48b',
      text: 'CODA: premarket print under its exit, decides at open',
      tone: 'open',
    }]);
  });

  test('without mark_session (older view) the session is derived from mark_at in New York time', () => {
    const older = { ...coda, mark_at: premarket.mark_at, action_hint: premarket.action_hint };
    const watchdog = mapLedgerWatchdog({ summary: [summary], breaches: [older] });
    expect(watchdog.breaches[0]?.mark_session).toBe('pre');
    // Even if a stale view called it actionable, a premarket equity print still decides at the open.
    const mislabeled = mapLedgerWatchdog({ summary: [summary], breaches: [{ ...older, action_hint: 'exit_full_lot' }] });
    expect(breachDecidesAtOpen(mislabeled.breaches[0]!)).toBe(true);
    expect(healthOf(mislabeled).alerts[0]?.kind)
      .toBe('invalidation_review_at_open');
  });

  test('after-hours and closed prints get their own words', () => {
    const post = mapLedgerWatchdog({ summary: [summary], breaches: [{ ...coda, mark_at: '2026-10-05T23:21:33Z', action_hint: 'review_at_open' }] });
    expect(post.breaches[0]?.mark_session).toBe('post');
    expect(healthOf(post).alerts[0]?.detail)
      .toBe('after-hours print $10.31 under exit $10.35 · decides at open');
    const weekend = mapLedgerWatchdog({ summary: [summary], breaches: [{ ...coda, mark_at: '2026-10-10T15:00:00Z', action_hint: 'review_at_open' }] });
    expect(checkText(healthOf(weekend).alerts[0]!))
      .toBe('CODA: market-closed print under its exit, decides at open');
  });

  test('a regular-session print through the line stays an actionable, red breach', () => {
    const rth = { ...coda, mark: '10.30', mark_at: '2026-10-06T14:15:00Z', action_hint: 'exit_full_lot', mark_session: 'rth' };
    const watchdog = mapLedgerWatchdog({ summary: [{ ...summary, breaches_actionable: 1, breaches_review_at_open: 0 }], breaches: [rth] });
    expect(breachDecidesAtOpen(watchdog.breaches[0]!)).toBe(false);
    const health = healthOf(watchdog);
    expect(health.alerts[0]).toMatchObject({ kind: 'invalidation_breach', detail: 'mark $10.30 at/below inval $10.35' });
    const books = assembleStewardBooks(bookDesk(watchdog), nowMs);
    expect(books.sections.find((section) => section.slug === 'quantanamo')?.checks[0]).toMatchObject({
      text: 'CODA: price is at or below its exit', tone: 'breach',
    });
  });

  test('prediction markets and memes trade 24/7: any hour through the line is a breach, no session', () => {
    const watchdog = mapLedgerWatchdog({
      summary: [summary],
      breaches: [
        { steward: 'oddsborne', lot_table: 'pm_positions', lot_id: 'p', instrument: 'fed yes', unit: 'USD',
          invalidation_price: 0.4, mark: 0.38, mark_at: '2026-10-06T08:00:00Z', action_hint: 'exit_full_lot' },
        { steward: 'bandit', lot_table: 'meme_positions', lot_id: 'm', instrument: 'YAP', unit: 'SOL',
          invalidation_price: 0.00002, mark: 0.000019, mark_at: '2026-10-10T15:00:00Z', action_hint: 'exit_full_lot',
          mark_session: 'closed' },
      ],
    });
    expect(watchdog.breaches.map((row) => row.mark_session)).toEqual([null, null]);
    expect(watchdog.breaches.map(breachDecidesAtOpen)).toEqual([false, false]);
    expect(healthOf(watchdog).alerts.map((alert) => alert.kind))
      .toEqual(['invalidation_breach', 'invalidation_breach']);
  });

  test('every breach reader asks for mark_session', () => {
    const root = join(import.meta.dir, '../../..');
    const fn = readFileSync(join(root, 'supabase/functions/desk-public-rest/index.ts'), 'utf8');
    expect(fn).toContain('mark_age_minutes,action_hint,mark_session,first_seen_at,breach_age_minutes,check_count,escalated,escalation,sentence&order=mark_at.desc');
    expect(readFileSync(join(import.meta.dir, 'ledger.ts'), 'utf8')).toContain('mark_age_minutes, action_hint, mark_session');
  });
});

describe('10/8 NBIS and CODA breach replay', () => {
  // portfolio_exposure on 2026-10-08, account 7638. 13:49 was still above both lines.
  const nbis = [
    { at: '2026-10-08T13:49:09.625052Z', price: 229.145 },
    { at: '2026-10-08T13:53:02.278126Z', price: 227.72 },
    { at: '2026-10-08T16:44:06.973851Z', price: 226.59 },
  ];
  const coda = [
    { at: '2026-10-08T13:49:09.625052Z', price: 10.52 },
    { at: '2026-10-08T13:53:02.278126Z', price: 10.32 },
    { at: '2026-10-08T16:44:06.973851Z', price: 10.29 },
  ];

  test('the first regular-session print under the line is not an escalation', () => {
    const nbisFirst = replayActionableBreachChecks({
      line: 227.90, marks: nbis.slice(0, 2), instrument: 'NBIS',
    });
    const codaFirst = replayActionableBreachChecks({
      line: 10.35, marks: coda.slice(0, 2), instrument: 'CODA',
    });
    expect(nbisFirst).toMatchObject({
      checks: 1, escalated: false, escalation: null,
      first_seen_at: '2026-10-08T13:53:02.278126Z', sentence: null,
    });
    expect(codaFirst).toMatchObject({
      checks: 1, escalated: false, first_seen_at: '2026-10-08T13:53:02.278126Z',
    });
  });

  test('the second print still under the line escalates, for both lots', () => {
    const nbisSecond = replayActionableBreachChecks({ line: 227.90, marks: nbis, instrument: 'NBIS' });
    const codaSecond = replayActionableBreachChecks({ line: 10.35, marks: coda, instrument: 'CODA' });
    expect(nbisSecond).toMatchObject({
      checks: 2,
      escalated: true,
      escalation: 'next_check',
      first_seen_at: '2026-10-08T13:53:02.278126Z',
      second_seen_at: '2026-10-08T16:44:06.973851Z',
      breach_age_minutes: 171,
      sentence: 'NBIS has been under its exit line for 2h 51m — sell now',
    });
    expect(codaSecond).toMatchObject({
      checks: 2,
      escalated: true,
      escalation: 'next_check',
      breach_age_minutes: 171,
      sentence: 'CODA has been under its exit line for 2h 51m — sell now',
    });
    expect(escalatedBreachSentence('NBIS', 120)).toBe('NBIS has been under its exit line for 2h — sell now');
  });

  test('one print escalates only once it is 15 minutes old, and a premarket print is not a check', () => {
    const inside = replayActionableBreachChecks({
      line: 227.90,
      marks: nbis.slice(0, 2),
      instrument: 'NBIS',
      asOf: '2026-10-08T14:08:01.000Z',
    });
    expect(inside.escalated).toBe(false);
    const window = replayActionableBreachChecks({
      line: 227.90,
      marks: nbis.slice(0, 2),
      instrument: 'NBIS',
      asOf: '2026-10-08T14:08:02.278126Z',
    });
    expect(window).toMatchObject({ checks: 1, escalated: true, escalation: 'window' });
    const premarket = replayActionableBreachChecks({
      line: 10.35,
      marks: [{ at: '2026-10-06T13:05:32.751992Z', price: 10.31 }],
      instrument: 'CODA',
    });
    expect(premarket).toMatchObject({ checks: 0, escalated: false, first_seen_at: null, sentence: null });
  });

  test('the 10/6 NBIS add stays quiet; a line at or under the new cost flags unless it is a scratch', () => {
    expect(addFlagsLineVsCost({
      line: 227.90, blended: 227.6137, isAdd: true, acceptedScratch: false,
    })).toBe(false);
    expect(addFlagsLineVsCost({
      line: 227.6137, blended: 227.6137, isAdd: true, acceptedScratch: false,
    })).toBe(true);
    expect(addFlagsLineVsCost({
      line: 220.80, blended: 227.6137, isAdd: true, acceptedScratch: false,
    })).toBe(true);
    expect(addFlagsLineVsCost({
      line: 220.80, blended: 227.6137, isAdd: true, acceptedScratch: true,
    })).toBe(false);
    expect(addFlagsLineVsCost({
      line: 220.80, blended: 227.6137, isAdd: false, acceptedScratch: false,
    })).toBe(false);
  });

  test('an escalated breach is a sell-now line on the book, and the old counts stay', () => {
    const watchdog = mapLedgerWatchdog({
      summary: [{
        checked_at: '2026-10-08T16:44:06.973851Z',
        invalidation_breaches: 2,
        breaches_actionable: 2,
        breaches_review_at_open: 0,
        breaches_escalated: 2,
        escalated: [
          {
            steward: 'quantanamo', lot_table: 'position_episodes', lot_id: 'nbis',
            instrument: 'NBIS', first_seen_at: '2026-10-08T13:53:02.278126Z',
            breach_age_minutes: 171, escalation: 'next_check',
            sentence: 'NBIS has been under its exit line for 2h 51m — sell now',
          },
        ],
      }],
      breaches: [{
        steward: 'quantanamo', lot_table: 'position_episodes', lot_id: 'nbis', instrument: 'NBIS',
        unit: 'USD', invalidation_price: 227.90, mark: 226.59,
        mark_at: '2026-10-08T16:44:06.973851Z', action_hint: 'exit_full_lot', mark_session: 'rth',
        first_seen_at: '2026-10-08T13:53:02.278126Z', breach_age_minutes: 171,
        check_count: 2, escalated: true, escalation: 'next_check',
        sentence: 'NBIS has been under its exit line for 2h 51m — sell now',
      }],
    });
    expect(watchdogHealthSummary(watchdog)).toMatchObject({
      invalidation_breaches: 2,
      breaches_actionable: 2,
      breaches_escalated: 2,
      escalated: ['NBIS has been under its exit line for 2h 51m — sell now'],
    });
    const nowMs = Date.parse('2026-10-08T16:44:06.973851Z');
    const desk = { watchdog, book: { names: [], observed_at: null }, positions: [], exposures: [], fills: [], intents: [] } as unknown as DeskPayload;
    const books = assembleStewardBooks(desk, nowMs);
    expect(books.sections.find((section) => section.slug === 'quantanamo')?.checks[0]).toEqual({
      id: 'breach-position_episodes-nbis',
      text: 'NBIS has been under its exit line for 2h 51m — sell now',
      tone: 'breach',
    });
    expect(assembleDeskBookHealth(desk, nowMs).alerts[0]?.kind).toBe('invalidation_breach');
  });

  test('the migration is the schema file and replays the 10/8 prints', () => {
    const root = join(import.meta.dir, '../../..');
    const sql = readFileSync(join(root, 'supabase/schemas/67_breach_escalation_line_after_add.sql'), 'utf8');
    expect(readFileSync(join(root, 'supabase/migrations/20261009174645_breach_escalation_line_after_add.sql'), 'utf8')).toBe(sql);
    expect(sql).toContain("interval '15 minutes'");
    expect(sql).toContain('2026-10-08 13:53:02.278126+00');
    expect(sql).toContain('227.72');
    expect(sql).toContain('10.32');
    expect(sql).toContain("has been under its exit line for ");
    expect(sql).toContain('line_at_or_below_cost');
    expect(sql).toContain('accepted_scratch');
    expect(sql).toContain('public.escalated_breaches');
    expect(sql).toContain('public.note_actionable_breaches');
    expect(sql).not.toContain('SECURITY DEFINER');
  });

  test('retired stewards drop out of actionable health counts and keep their keys', () => {
    const watchdog = mapLedgerWatchdog({
      summary: [{
        checked_at: '2026-10-28T17:00:00Z',
        invalidation_breaches: 2,
        breaches_actionable: 2,
        breaches_review_at_open: 0,
        lots_missing_invalidation: 1,
        integrity_issues: 2,
        integrity_errors: 0,
        integrity: { fill_without_position: 1, open_lot_without_thesis: 1 },
        open_lots: 4,
        exposure_over_budget: 1,
        exposure: {
          quantanamo: { unit: 'USD', open_risk: 10, risk_budget: 100, used_share: 0.01, headroom: 90 },
          oddsborne: { unit: 'USD', open_risk: 40, risk_budget: 20, used_share: 2, headroom: -20 },
          bandit: { unit: 'SOL', open_risk: 0, risk_budget: 1, used_share: 0, headroom: 1 },
        },
        learning_gaps: {
          quantanamo: 1,
          oddsborne: 2,
          bandit: 3,
          lots: [
            { steward: 'oddsborne', lot_table: 'pm_positions', lot_id: 'pm-1' },
            { steward: 'quantanamo', lot_table: 'position_episodes', lot_id: 'eq-1' },
          ],
        },
        unscoreable_decisions: { quantanamo: 0, oddsborne: 1, bandit: 4 },
        breaches_escalated: 1,
        escalated: [{
          steward: 'oddsborne', lot_table: 'pm_positions', lot_id: 'pm-9', instrument: 'NW',
          first_seen_at: '2026-10-28T12:00:00Z', breach_age_minutes: 40, escalation: 'window',
          sentence: 'NW has been under its exit line for 40m — sell now',
        }],
        stale_queued_tests: {
          n: 5,
          quantanamo: 2,
          oddsborne: 3,
          bandit: 0,
          unknown: 0,
          theses: [
            { thesis_id: 'earnings_gap_structure', steward: 'quantanamo', n: 2 },
            { thesis_id: 'sports_devig', steward: 'oddsborne', n: 3 },
          ],
        },
      }],
      breaches: [
        {
          steward: 'quantanamo', lot_table: 'position_episodes', lot_id: 'eq', instrument: 'CIFR',
          unit: 'USD', action_hint: 'exit_full_lot', invalidation_price: 1, mark: 1,
        },
        {
          steward: 'oddsborne', lot_table: 'pm_positions', lot_id: 'pm-9', instrument: 'NW',
          unit: 'USD', action_hint: 'exit_full_lot', invalidation_price: 0.4, mark: 0.2,
        },
      ],
      missing: [{ steward: 'bandit', lot_table: 'meme_positions', lot_id: 'm', instrument: 'YAP', unit: 'SOL' }],
      issues: [
        {
          check_name: 'fill_without_position', severity: 'warn', steward: 'oddsborne',
          ref_table: 'pm_fills', ref_id: 'f', instrument: 'x', detail: 'pm fill has no position_id',
        },
        {
          check_name: 'open_lot_without_thesis', severity: 'warn', steward: 'quantanamo',
          ref_table: 'position_episodes', ref_id: 'eq', instrument: 'CIFR', detail: 'open lot has no thesis_id',
        },
      ],
    });
    const retired = new Set(['oddsborne', 'bandit']);
    const health = watchdogHealthSummary(watchdog, retired);
    expect(health.learning_gaps).toEqual({ quantanamo: 1, oddsborne: 0, bandit: 0 });
    expect(health.unscoreable_decisions).toEqual({ quantanamo: 0, oddsborne: 0, bandit: 0 });
    expect(health.stale_queued_tests).toEqual({
      n: 2,
      quantanamo: 2,
      oddsborne: 0,
      bandit: 0,
      unknown: 0,
      theses: [{ thesis_id: 'earnings_gap_structure', steward: 'quantanamo', n: 2 }],
    });
    expect(health.escalated).toEqual([]);
    expect(health.breaches_escalated).toBe(0);
    expect(health.invalidation_breaches).toBe(1);
    expect(health.breaches_actionable).toBe(1);
    expect(health.lots_missing_invalidation).toBe(0);
    expect(health.integrity_issues).toBe(1);
    expect(health.integrity).toEqual({ open_lot_without_thesis: 1 });
    expect(health.exposure_over_budget).toBe(0);
    expect(watchdog.learning_gaps).toEqual({ quantanamo: 1, oddsborne: 2, bandit: 3 });
    expect(watchdog.unscoreable_decisions.oddsborne).toBe(1);
    expect(watchdog.learning_gap_lots).toHaveLength(2);
    expect(watchdogHealthSummary(watchdog).learning_gaps).toEqual(watchdog.learning_gaps);
  });
});
