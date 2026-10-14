import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';

import { StewardScorecard } from '../app/terminal/steward-scorecard';
import {
  decisionGateKey,
  decisionOutcomePct,
  decisionPriceTerms,
  formatOutcomePct,
  gateBeliefDue,
  gateMoreNeeded,
  gateOutcomeVerdict,
  gateReportLine,
  oddsborneNoteBlockingGate,
  studentTCrit95,
  type GateReportRow,
} from './gate-report';
import type { StewardScorecardCard } from './steward-scorecard';

const root = join(import.meta.dir, '../../..');

describe('decision outcome percent', () => {
  test('long gains and short losses use the share price, not the dollar difference', () => {
    expect(decisionOutcomePct({
      venue: 'equity', side: 'long', bookPrice: 100, mark: 103.1, outcome: null, priceTerms: 'yes',
    })).toBeCloseTo(0.031, 10);
    expect(decisionOutcomePct({
      venue: 'equity', side: 'short', bookPrice: 100, mark: 103, outcome: null, priceTerms: 'yes',
    })).toBeCloseTo(-0.03, 10);
    expect(decisionOutcomePct({
      venue: 'equity', side: 'long', bookPrice: 100, mark: null, outcome: null, priceTerms: 'yes',
    })).toBeNull();
  });

  test('a per-token SOL move is a percent, so a tiny difference does not round to zero', () => {
    const book = 0.00001;
    const mark = 0.000012;
    expect(mark - book).toBeCloseTo(0.000002, 12);
    expect(decisionOutcomePct({
      venue: 'meme', side: 'long', bookPrice: book, mark, outcome: null, priceTerms: 'yes',
    })).toBeCloseTo(0.2, 10);
    expect(decisionOutcomePct({
      venue: 'meme', side: 'short', bookPrice: book, mark, outcome: null, priceTerms: 'yes',
    })).toBeCloseTo(-0.2, 10);
  });

  test('NO in side terms and NO logged as a YES price both use the side that was skipped', () => {
    expect(decisionOutcomePct({
      venue: 'prediction', side: 'no', bookPrice: 0.25, mark: null, outcome: 'no', priceTerms: 'side',
    })).toBeCloseTo(3, 10);
    expect(decisionOutcomePct({
      venue: 'prediction', side: 'no', bookPrice: 0.25, mark: null, outcome: 'yes', priceTerms: 'side',
    })).toBeCloseTo(-1, 10);
    // YES price 0.80 means the NO cost 0.20. A NO win is +400%, not +(0.80)/0.80.
    expect(decisionOutcomePct({
      venue: 'prediction', side: 'no', bookPrice: 0.8, mark: null, outcome: 'no', priceTerms: 'yes',
    })).toBeCloseTo(4, 10);
    expect(decisionOutcomePct({
      venue: 'prediction', side: 'no', bookPrice: 0.8, mark: null, outcome: 'yes', priceTerms: 'yes',
    })).toBeCloseTo(-1, 10);
    expect(decisionOutcomePct({
      venue: 'prediction', side: 'yes', bookPrice: 0.4, mark: null, outcome: null, priceTerms: 'side',
    })).toBeNull();
  });

  test("a logged decision with no price_terms is the side's own price", () => {
    expect(decisionPriceTerms({ origin: 'steward_log_decision' })).toBe('side');
    expect(decisionPriceTerms({ price_terms: 'yes' })).toBe('yes');
    expect(decisionPriceTerms(null)).toBe('yes');
  });
});

describe('gate key', () => {
  test('a written blocked_by is kept, and a rollup label is not a gate', () => {
    expect(decisionGateKey('bandit', 'ignored', { blocked_by: '1h_cap_30' })).toBe('1h_cap_30');
    expect(decisionGateKey('quantanamo', 'gate score under 80', { blocked_by: 'quality_drawdown_fail' }))
      .toBe('quality_drawdown_fail');
    expect(decisionGateKey('oddsborne', 'Morning skips AM 2026-10-03', {})).toBe('unlabeled');
    expect(decisionGateKey('oddsborne', 'Morning skips AM 2026-10-03', { blocked_by: 'morning_rollup' }))
      .toBe('unlabeled');
    expect(decisionGateKey('oddsborne', 'Afternoon sports 2026-10-03', { blocked_by: 'afternoon_rollup' }))
      .toBe('unlabeled');
    expect(decisionGateKey('oddsborne', 'Morning skips AM 2026-10-03', { blocked_by: 'edge_below_gate' }))
      .toBe('edge_below_gate');
    expect(decisionGateKey('oddsborne', 'wx pass SFO 2026-10-14', { pattern: 'fav_vs_forecast' }))
      .toBe('weather_forecast_gate');
    expect(decisionGateKey('oddsborne', 'fair 0.6279 (Green Bay Packers/title) vs 0.6225; post-fee maker -0.01', {}))
      .toBe('edge_below_gate');
    expect(decisionGateKey('oddsborne', 'no two-way de-vig for the long side', {})).toBe('devig_gate');
    expect(decisionGateKey(
      'oddsborne',
      '20261013_am pass: fair 0.5 maker@0.52; post-fee maker 0.02; CLEARED gate but not entered: same_game',
      {},
    )).toBe('same_game');
    expect(decisionGateKey('oddsborne', 'note with no gate', {})).toBe('unlabeled');
    expect(decisionGateKey('quantanamo', 'no gate written', {})).toBe('unlabeled');
  });
});

describe('note re-derivation', () => {
  test('a negative post-fee edge, a timeout, and a phrase each name the real gate', () => {
    const gb = oddsborneNoteBlockingGate(
      'aec-nfl-gb-tb-2026-10-04 post-fee maker -0.027289',
      { comps_top: [{ market: 'aec-nfl-gb-tb-2026-10-04', post_fee_maker: -0.027289 }] },
      'aec-nfl-gb-tb-2026-10-04',
    );
    expect(gb.gate).toBe('edge_below_gate');
    expect(gb.edge).toBeCloseTo(-0.027289, 6);

    const timeout = oddsborneNoteBlockingGate(
      'aec-nfl-tb-dal-2026-10-05 SKIP forced (pm_enter DB timeout)',
      { candidates: [{ slug: 'aec-nfl-tb-dal-2026-10-05', maker: 0.011879 }] },
      'aec-nfl-tb-dal-2026-10-05',
    );
    expect(timeout.gate).toBe('not_placed');
    expect(timeout.edge).toBeCloseTo(0.011879, 6);

    const phrase = oddsborneNoteBlockingGate(
      'aec-nfl-hou-ten-2026-10-06 not a real positive edge',
      { comps_top: [{ market: 'aec-nfl-hou-ten-2026-10-06', post_fee_maker: 0.000612 }] },
      'aec-nfl-hou-ten-2026-10-06',
    );
    expect(phrase.gate).toBe('edge_below_gate');

    const bar = oddsborneNoteBlockingGate('LAA Edge under 8c bar', {}, 'aec-mlb-laa');
    expect(bar.gate).toBe('edge_below_gate');

    const weather = oddsborneNoteBlockingGate(
      'SFO aligned — no edge. TEASE then SKIP. mushy forecast.',
      {},
      'tc-temp-sfohigh-2026-09-14-gte74lt75f',
    );
    expect(weather.gate).toBe('unlabeled');

    const cpi = oddsborneNoteBlockingGate(
      'cpic-uscpi-august-yoy-2026-09-11-gt3pt4pct BBO 0.26/0.27 mid 0.265.\nCleveland Fed thin after-spread edge, skip.',
      {},
      'cpic-uscpi-august-yoy-2026-09-11-gt3pt4pct',
    );
    expect(cpi.gate).toBe('edge_below_gate');

    const fromNumber = oddsborneNoteBlockingGate(
      'NYC aligned — no edge',
      { comps_top: [{ market: 'aec-nfl-gb-tb-2026-10-04', post_fee_maker: -0.027289 }] },
      'aec-nfl-gb-tb-2026-10-04',
    );
    expect(fromNumber.gate).toBe('edge_below_gate');
    expect(fromNumber.why).toContain('under the minimum');
  });

  test('a multi-market note does not lend another market its sentence', () => {
    const stolen = oddsborneNoteBlockingGate(
      'other-market thin edge\naec-nfl-tb-dal-2026-10-05 SKIP forced (pm_enter DB timeout)',
      { candidates: [{ slug: 'aec-nfl-tb-dal-2026-10-05', maker: 0.011879 }] },
      'aec-nfl-tb-dal-2026-10-05',
    );
    expect(stolen.gate).toBe('not_placed');
  });
});

describe('noise bar and belief idempotency', () => {
  test('a wide binary payoff and a tight share move do not share an 8-sample rule', () => {
    expect(studentTCrit95(9)).toBeCloseTo(2.2622, 4);
    expect(studentTCrit95(6)).toBeCloseTo(2.4469, 4);
    expect(studentTCrit95(30)).toBeCloseTo(2.0423, 4);
    expect(studentTCrit95(120)).toBeCloseTo(1.9799, 4);
    // Ten coin-flip-sized outcomes, mean +75%, spread wider than the mean.
    expect(gateOutcomeVerdict(10, 0.7536, 1.7277)).toBe('too few to tell');
    // Eight identical small gains: the interval excludes a scratch.
    expect(gateOutcomeVerdict(8, 0.02, 0.002)).toBe('costing growth');
    // The old 8-sample rule would have called this costing growth.
    expect(gateOutcomeVerdict(8, 0.031, 0.2)).toBe('too few to tell');
    expect(gateOutcomeVerdict(8, 0.005, 0.04)).toBe('too few to tell');
    // Every contract lost. A share's small mean with a tight spread also clears.
    expect(gateOutcomeVerdict(12, -1, 0)).toBe('protecting');
    expect(gateOutcomeVerdict(30, -0.02, 0.01)).toBe('protecting');
    expect(gateOutcomeVerdict(1, 0.5, null)).toBe('too few to tell');
    expect(gateOutcomeVerdict(247, -0.0127, 1.0881)).toBe('too few to tell');
    expect(gateOutcomeVerdict(5, 0.0006, 0.0576)).toBe('too few to tell');
  });

  test('says how many more scored trades would settle it, and stays quiet near a scratch', () => {
    const more = gateMoreNeeded(10, 0.7536, 1.7277);
    expect(more).not.toBeNull();
    expect(more!).toBeGreaterThanOrEqual(10);
    expect(more!).toBeLessThanOrEqual(40);
    expect(gateMoreNeeded(247, -0.0127, 1.0881)).toBeNull();
    expect(gateMoreNeeded(12, -1, 0)).toBe(0);
    expect(gateMoreNeeded(1, 0.5, null)).toBeNull();
  });

  test('a belief is due once, again on a flip, and once to take a lesson back', () => {
    expect(gateBeliefDue(null, 8, 'protecting')).toBe(true);
    expect(gateBeliefDue('protecting', 20, 'protecting')).toBe(false);
    expect(gateBeliefDue('protecting', 20, 'costing growth')).toBe(true);
    expect(gateBeliefDue(null, 8, 'too few to tell')).toBe(false);
    expect(gateBeliefDue('too few to tell', 30, 'too few to tell')).toBe(false);
    expect(gateBeliefDue('protecting', 30, 'too few to tell')).toBe(true);
    expect(gateBeliefDue('superseded', 10, 'too few to tell')).toBe(false);
    expect(gateBeliefDue('superseded', 10, 'protecting')).toBe(false);
  });
});

describe('desk line', () => {
  const row = (partial: Partial<GateReportRow>): GateReportRow => ({
    steward: 'quantanamo',
    gate: 'quality_drawdown_fail',
    skips: 5,
    scored: 5,
    would_have_won: 4,
    would_have_won_rate: 0.8,
    mean_outcome_pct: 0.031,
    verdict: 'too few to tell',
    thesis_id: null,
    at_stake_pnl: null,
    unit: 'USD',
    sd_outcome_pct: 0.2,
    more_needed: null,
    ...partial,
  });

  test('matches the parchment sentence, and adds a size only when one was logged', () => {
    expect(gateReportLine(row({}))).toBe(
      'Quality and drawdown kept us out of 5 trades: 4 would have won, avg +3.1%. Too few to tell yet. The average is close to a scratch, so more of the same would not settle it soon.',
    );
    expect(gateReportLine(row({
      scored: 9, would_have_won: 2, mean_outcome_pct: -0.04, verdict: 'protecting', more_needed: 0,
    }))).toBe('Quality and drawdown kept us out of 9 trades: 2 would have won, avg -4.0%. Protecting the book.');
    expect(gateReportLine(row({
      gate: '1h_cap_30', scored: 8, would_have_won: 5, mean_outcome_pct: 0.124,
      verdict: 'costing growth', at_stake_pnl: 0.012, unit: 'SOL', more_needed: 0,
    }))).toContain('Costing growth.');
    expect(gateReportLine(row({
      gate: '1h_cap_30', scored: 5, skips: 6, would_have_won: 3, mean_outcome_pct: 0.1378,
      verdict: 'too few to tell', more_needed: 13,
    }))).toBe(
      'The one-hour rise cap kept us out of 5 trades: 3 would have won, avg +13.8%. Too few to tell yet. About 13 more scored trades would settle this if the average holds.',
    );
    expect(gateReportLine(row({
      gate: '1h_cap_30', scored: 8, would_have_won: 5, mean_outcome_pct: 0.124,
      verdict: 'costing growth', at_stake_pnl: 0.012, unit: 'SOL',
    }))).toContain('At the logged size, +0.0120 SOL.');
    expect(gateReportLine(row({ scored: 0, skips: 4, mean_outcome_pct: null }))).toBe(
      'Quality and drawdown kept us out of 4 trades. None scored yet.',
    );
    expect(formatOutcomePct(1.5)).toBe('+150%');
  });
});

describe('gate report SQL', () => {
  test('schema and migration match, and the card does not change a rule', async () => {
    const schema = await readFile(join(root, 'supabase/schemas/70_gate_report.sql'), 'utf8');
    const migration = await readFile(join(root, 'supabase/migrations/20261014180000_gate_report_noise_bar.sql'), 'utf8');
    const check = await readFile(join(root, 'supabase/tests/70_gate_report.sql'), 'utf8');
    expect(migration.startsWith(schema.trimEnd())).toBe(true);
    expect(migration).toContain('blocked_by_was');
    expect(migration).toContain('1db9c2bc-0e61-4ee4-addd-d9771b5c8391');
    expect(migration).toContain("'supersedes'");
    expect(schema).not.toContain('counterfactual_pnl = counterfactual_pnl');
    expect(schema).not.toContain("then 'morning_rollup'");
    expect(schema).toContain('student_t_crit_95');
    expect(schema).toContain('account_snapshot_gate_belief');
    expect(schema).toContain('when lower(coalesce(p_side, \'\')) = \'short\' then (p_book_price - p_mark) / p_book_price');
    expect(schema).toContain('when lower(coalesce(p_side, \'\')) = \'long\' then (p_mark - p_book_price) / p_book_price');
    expect(schema).toContain('((lower(p_outcome) = lower(p_side))::integer)::numeric - s.px) / s.px');
    expect(schema).not.toContain('p_scored < 8');
    expect(schema).toContain('p_latest is distinct from p_verdict');
    expect(schema).toContain("meta->>'kind' = 'gate_outcome'");
    expect(schema).toContain('with (security_invoker = true)');
    expect(schema).toContain('revoke all on public.v_gate_report from public, anon');
    expect(schema).toContain('security invoker');
    expect(schema).not.toMatch(/update public\.theses|update public\.desk_rules|insert into public\.desk_rules/i);
    expect(migration).not.toMatch(/update public\.theses|update public\.desk_rules|insert into public\.desk_rules/i);
    expect(check).toContain('assert not public.gate_belief_due');
    const live = await readFile(join(root, 'apps/dashboard/lib/ledger-live.ts'), 'utf8');
    const ledger = await readFile(join(root, 'apps/dashboard/lib/ledger.ts'), 'utf8');
    const bundle = await readFile(join(root, 'supabase/functions/desk-public-rest/index.ts'), 'utf8');
    const select = 'steward,gate,skips,scored,would_have_won,would_have_won_rate,mean_outcome_pct,verdict,thesis_id,at_stake_pnl,unit,sd_outcome_pct,more_needed';
    expect(live).toContain(select);
    expect(ledger).toContain(select);
    expect(bundle).toContain(select);
    expect(bundle).toContain("'v_gate_report'");
  });
});

describe('scorecard gate lines', () => {
  const dom = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    Node: dom.Node,
    navigator: dom.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const card: StewardScorecardCard = {
    steward: 'quantanamo',
    unit: 'USD',
    weeks: [],
    trades: 7,
    priced: 7,
    expectancy: 1,
    thin: true,
    realized: 12,
    unrealized: null,
    open_positions: 0,
    fees: null,
    theses: [],
    skips: null,
    not_from_fills: 0,
    trend: null,
    gates: [
      {
        steward: 'quantanamo', gate: 'quality_drawdown_fail', skips: 5, scored: 5,
        would_have_won: 4, would_have_won_rate: 0.8, mean_outcome_pct: 0.031,
        verdict: 'too few to tell', thesis_id: null, at_stake_pnl: null, unit: 'USD',
        sd_outcome_pct: 0.2, more_needed: null,
      },
      {
        steward: 'quantanamo', gate: 'screen_fail', skips: 4, scored: 0,
        would_have_won: 0, would_have_won_rate: null, mean_outcome_pct: null,
        verdict: 'too few to tell', thesis_id: null, at_stake_pnl: null, unit: 'USD',
        sd_outcome_pct: null, more_needed: null,
      },
      {
        steward: 'quantanamo', gate: 'timing', skips: 4, scored: 0,
        would_have_won: 0, would_have_won_rate: null, mean_outcome_pct: null,
        verdict: 'too few to tell', thesis_id: null, at_stake_pnl: null, unit: 'USD',
        sd_outcome_pct: null, more_needed: null,
      },
      {
        steward: 'quantanamo', gate: 'no_edge', skips: 2, scored: 0,
        would_have_won: 0, would_have_won_rate: null, mean_outcome_pct: null,
        verdict: 'too few to tell', thesis_id: null, at_stake_pnl: null, unit: 'USD',
        sd_outcome_pct: null, more_needed: null,
      },
    ],
  };

  test('shows the first lines and hides the rest behind a tap', async () => {
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rootEl = createRoot(host);
    await act(async () => {
      rootEl.render(createElement(StewardScorecard, { card, name: 'QUANTANAMO' }));
    });
    const gates = host.querySelector('[data-gates]');
    expect(gates?.textContent).toContain(
      'Quality and drawdown kept us out of 5 trades: 4 would have won, avg +3.1%. Too few to tell yet. The average is close to a scratch, so more of the same would not settle it soon.',
    );
    expect(gates?.querySelector('b')?.className).toBe('up');
    expect(gates?.textContent).not.toContain('no_edge');
    expect(gates?.textContent).not.toContain('No edge');
    const more = host.querySelector('details.score-gates-more');
    expect(more?.querySelector('summary')?.textContent).toBe('1 more');
    expect(more?.textContent).toContain('No edge');
    await act(async () => {
      rootEl.unmount();
    });
    host.remove();
  });
});
