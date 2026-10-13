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
  GATE_MIN_SCORED,
  gateBeliefDue,
  gateOutcomeVerdict,
  gateReportLine,
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
  test('a written blocked_by is kept, and ODDSBORNE reasons become stable keys', () => {
    expect(decisionGateKey('bandit', 'ignored', { blocked_by: '1h_cap_30' })).toBe('1h_cap_30');
    expect(decisionGateKey('quantanamo', 'gate score under 80', { blocked_by: 'quality_drawdown_fail' }))
      .toBe('quality_drawdown_fail');
    expect(decisionGateKey('oddsborne', 'Morning skips AM 2026-10-03', {})).toBe('morning_rollup');
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

describe('sample bar and belief idempotency', () => {
  test('under 8 scored, or a zero mean, never produces a verdict', () => {
    expect(GATE_MIN_SCORED).toBe(8);
    expect(gateOutcomeVerdict(7, 0.4)).toBe('too few to tell');
    expect(gateOutcomeVerdict(8, 0)).toBe('too few to tell');
    expect(gateOutcomeVerdict(8, null)).toBe('too few to tell');
    expect(gateOutcomeVerdict(8, 0.031)).toBe('costing growth');
    expect(gateOutcomeVerdict(8, -0.01)).toBe('protecting');
  });

  test('a belief is due once, and again only when the verdict flips', () => {
    expect(gateBeliefDue(null, 8, 'protecting')).toBe(true);
    expect(gateBeliefDue('protecting', 20, 'protecting')).toBe(false);
    expect(gateBeliefDue('protecting', 20, 'costing growth')).toBe(true);
    expect(gateBeliefDue(null, 8, 'too few to tell')).toBe(false);
    expect(gateBeliefDue(null, 7, 'protecting')).toBe(false);
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
    ...partial,
  });

  test('matches the parchment sentence, and adds a size only when one was logged', () => {
    expect(gateReportLine(row({}))).toBe(
      'Kept us out of 5 trades on quality_drawdown_fail: 4 would have won, avg +3.1%. Too few to tell yet.',
    );
    expect(gateReportLine(row({
      scored: 9, would_have_won: 2, mean_outcome_pct: -0.04, verdict: 'protecting',
    }))).toBe('Kept us out of 9 trades on quality_drawdown_fail: 2 would have won, avg -4.0%. Protecting the book.');
    expect(gateReportLine(row({
      gate: '1h_cap_30', scored: 8, would_have_won: 5, mean_outcome_pct: 0.124,
      verdict: 'costing growth', at_stake_pnl: 0.012, unit: 'SOL',
    }))).toContain('Costing growth.');
    expect(gateReportLine(row({
      gate: '1h_cap_30', scored: 8, would_have_won: 5, mean_outcome_pct: 0.124,
      verdict: 'costing growth', at_stake_pnl: 0.012, unit: 'SOL',
    }))).toContain('At the logged size, +0.0120 SOL.');
    expect(gateReportLine(row({ scored: 0, skips: 4, mean_outcome_pct: null }))).toBe(
      'Kept us out of 4 trades on quality_drawdown_fail. None scored yet.',
    );
    expect(formatOutcomePct(1.5)).toBe('+150%');
  });
});

describe('gate report SQL', () => {
  test('schema and migration match, and the card does not change a rule', async () => {
    const schema = await readFile(join(root, 'supabase/schemas/70_gate_report.sql'), 'utf8');
    const migration = await readFile(join(root, 'supabase/migrations/20261013190000_gate_report.sql'), 'utf8');
    const check = await readFile(join(root, 'supabase/tests/70_gate_report.sql'), 'utf8');
    expect(migration).toBe(schema);
    expect(schema).toContain('when lower(coalesce(p_side, \'\')) = \'short\' then (p_book_price - p_mark) / p_book_price');
    expect(schema).toContain('when lower(coalesce(p_side, \'\')) = \'long\' then (p_mark - p_book_price) / p_book_price');
    expect(schema).toContain('((lower(p_outcome) = lower(p_side))::integer)::numeric - s.px) / s.px');
    expect(schema).toContain('p_scored < 8');
    expect(schema).toContain('p_latest is distinct from p_verdict');
    expect(schema).toContain("meta->>'kind' = 'gate_outcome'");
    expect(schema).toContain('with (security_invoker = true)');
    expect(schema).toContain('revoke all on public.v_gate_report from public, anon');
    expect(schema).toContain('security invoker');
    expect(schema).not.toMatch(/update public\.theses|update public\.desk_rules|insert into public\.desk_rules/i);
    expect(check).toContain('assert not public.gate_belief_due');
    const live = await readFile(join(root, 'apps/dashboard/lib/ledger-live.ts'), 'utf8');
    const ledger = await readFile(join(root, 'apps/dashboard/lib/ledger.ts'), 'utf8');
    const bundle = await readFile(join(root, 'supabase/functions/desk-public-rest/index.ts'), 'utf8');
    const select = 'steward,gate,skips,scored,would_have_won,would_have_won_rate,mean_outcome_pct,verdict,thesis_id,at_stake_pnl,unit';
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
      },
      {
        steward: 'quantanamo', gate: 'screen_fail', skips: 4, scored: 0,
        would_have_won: 0, would_have_won_rate: null, mean_outcome_pct: null,
        verdict: 'too few to tell', thesis_id: null, at_stake_pnl: null, unit: 'USD',
      },
      {
        steward: 'quantanamo', gate: 'timing', skips: 4, scored: 0,
        would_have_won: 0, would_have_won_rate: null, mean_outcome_pct: null,
        verdict: 'too few to tell', thesis_id: null, at_stake_pnl: null, unit: 'USD',
      },
      {
        steward: 'quantanamo', gate: 'no_edge', skips: 2, scored: 0,
        would_have_won: 0, would_have_won_rate: null, mean_outcome_pct: null,
        verdict: 'too few to tell', thesis_id: null, at_stake_pnl: null, unit: 'USD',
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
      'Kept us out of 5 trades on quality_drawdown_fail: 4 would have won, avg +3.1%. Too few to tell yet.',
    );
    expect(gates?.querySelector('b')?.className).toBe('up');
    expect(gates?.textContent).not.toContain('no_edge');
    const more = host.querySelector('details.score-gates-more');
    expect(more?.querySelector('summary')?.textContent).toBe('1 more');
    expect(more?.textContent).toContain('no_edge');
    await act(async () => {
      rootEl.unmount();
    });
    host.remove();
  });
});
