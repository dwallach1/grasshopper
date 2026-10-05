import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { PLAYBOOK_RULE_KIND, type BeliefUpdateRow } from './beliefs';
import { MARK_NOT_IN_LEDGER } from './book-performance';
import { deskFromWire } from './desk-client';
import { fallbackTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';
import { emptyLedgerWatchdog } from './ledger-watchdog';
import { emptyStewardScorecard } from './steward-scorecard';

const AT = '2026-09-16T20:00:00.000Z';
const EARNINGS = 'earnings_gap_structure';
const WEATHER = 'weather_same_day_high';
const EARNINGS_SUMMARY = 'Gap leftovers are not a chase.';
const WEATHER_SUMMARY = 'Same-day high is the contract.';
const EARNINGS_FALSIFIER = 'A printed gap that still pays.';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Element: dom.Element,
  Node: dom.Node,
  DocumentFragment: dom.DocumentFragment,
  SVGElement: dom.SVGElement,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  navigator: dom.navigator,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  MutationObserver: dom.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BookPanel } = await import('../app/terminal/book-panel');

function belief(extra: Partial<BeliefUpdateRow> = {}): BeliefUpdateRow {
  return {
    id: extra.id ?? 'b-gap',
    thesis_id: extra.thesis_id ?? EARNINGS,
    domain_id: extra.domain_id ?? 'fallback-equity',
    agent_id: extra.agent_id ?? null,
    prior_confidence: extra.prior_confidence ?? 82,
    new_confidence: extra.new_confidence ?? 84,
    rationale: extra.rationale ?? 'No chase leftovers.',
    observed_at: extra.observed_at ?? AT,
    kind: extra.kind ?? PLAYBOOK_RULE_KIND,
    rules: extra.rules ?? ['no_chase_already_printed_leftovers'],
    steward: extra.steward ?? 'quantanamo',
    research_lesson_id: extra.research_lesson_id ?? null,
  };
}

function nameRow(symbol: string) {
  return {
    symbol,
    quantity: 10,
    average_cost: 10,
    cost: 100,
    mark: 11,
    pnl: 10,
    note: '',
    venue: 'equity' as const,
  };
}

function position(id: string, symbol: string, thesisId: string) {
  return {
    id,
    account_key: 'agentic-7638',
    symbol,
    status: 'open',
    quantity: 10,
    average_cost: 10,
    opened_at: AT,
    closed_at: null,
    next_review_at: null,
    thesis_id: thesisId,
    invalidation_price: 10.35,
    invalidation_note: 'Under the post-print base.',
  };
}

function desk(
  extraNames: ReturnType<typeof nameRow>[] = [],
  extraPositions: ReturnType<typeof position>[] = [],
  lessons: unknown[] = [],
): DeskPayload {
  return {
    ...wireDesk(extraNames, extraPositions, lessons),
    scorecard: {
      ...emptyStewardScorecard(),
      theses: [{
        thesis_id: EARNINGS,
        name: 'Earnings gap structure',
        steward: 'quantanamo',
        stated_confidence: 70,
        results_confidence: 56,
        outcome_implied_confidence: null,
        confidence_gap: null,
        priced_trades: 6,
        wins: 2,
        miscalibrated: false,
        thin: true,
        backtest_tests: 2,
        backtest_trades: 400,
        backtest_weight: 2,
        backtest_mean_ret: 0.004,
        backtest_effect: 'for',
      }],
    },
    watchdog: {
      ...emptyLedgerWatchdog(),
      available: true,
      exposure: [
        { steward: 'quantanamo', unit: 'USD', open_risk: 351.4, risk_budget: 550.06, used_share: 0.064, headroom: 198.66, over: false, risk_basis: 'to_invalidation' },
        { steward: 'oddsborne', unit: 'USD', open_risk: 0, risk_budget: 27.69, used_share: 0, headroom: 27.69, over: false, risk_basis: 'full_notional' },
        { steward: 'bandit', unit: 'SOL', open_risk: 0.2, risk_budget: 0.18, used_share: 1.1, headroom: -0.02, over: true, risk_basis: 'full_notional' },
      ],
    },
  };
}

function wireDesk(
  extraNames: ReturnType<typeof nameRow>[],
  extraPositions: ReturnType<typeof position>[],
  lessons: unknown[],
): DeskPayload {
  return deskFromWire({
    generated_at: AT,
    source: 'snapshot',
    snapshots: [],
    routines: [],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: AT,
      last4: '7638',
      buying_power: null,
      starting_nav: 5000,
      current_nav: 5157,
      cash: null,
      deployed: null,
      vs_start: 157,
      vs_start_note: MARK_NOT_IN_LEDGER,
      day_pnl: null,
      day_pnl_note: MARK_NOT_IN_LEDGER,
      vs_cost: null,
      vs_cost_note: MARK_NOT_IN_LEDGER,
      names: [nameRow('CODA'), ...extraNames],
    },
    positions: [position('ep-coda', 'CODA', EARNINGS), ...extraPositions],
    theses: [{
      id: EARNINGS,
      name: 'Earnings gap structure',
      summary: EARNINGS_SUMMARY,
      status: 'hardening',
      confidence: 70,
      time_horizon: 'days_to_weeks',
      stance: 'bullish',
      variant_perception: null,
      falsifier: EARNINGS_FALSIFIER,
      created_at: AT,
      updated_at: AT,
      symbols: ['CODA'],
      lots: [],
    }, {
      id: WEATHER,
      name: 'Same-day city-high weather',
      summary: WEATHER_SUMMARY,
      status: 'hardening',
      confidence: 70,
      time_horizon: 'hours',
      stance: 'bullish',
      variant_perception: null,
      falsifier: 'The city high misses the strike.',
      created_at: AT,
      updated_at: AT,
      symbols: [],
      lots: [],
    }],
    exposures: [],
    fills: [],
    intents: [],
    beliefs: [
      belief(),
      belief({
        id: 'b-weather',
        thesis_id: WEATHER,
        domain_id: 'fallback-prediction',
        observed_at: '2026-09-15T20:00:00.000Z',
        rationale: 'Kill into a no-bid close.',
        rules: ['no_bid_close'],
      }),
    ],
    lessons,
    team: fallbackTeam(),
    prediction_markets: {
      desk: 'ODDSBORNE',
      venue: 'prediction',
      markets: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [],
      notes: [],
    },
    meme_coins: {
      desk: 'BANDIT',
      venue: 'meme',
      tokens: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [],
      notes: [],
    },
  });
}

type Mounted = {
  host: HTMLElement;
  unmount: () => void;
};

async function mount(node: ReturnType<typeof createElement>): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return {
    host,
    unmount() {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function button(host: ParentNode, selector: string): HTMLButtonElement {
  const node = host.querySelector(selector);
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${selector}`);
  }
  return node;
}

afterEach(() => {
  document.body.replaceChildren();
});


function lesson(id: number, summary: string, created = AT) {
  return {
    id,
    cycle_id: 1,
    test_id: null,
    thesis_id: EARNINGS,
    lesson_type: 'missed_swing',
    summary,
    market_regime: 'post_print_hold',
    incorporated: false,
    created_at: created,
  };
}

describe('Books page: one section per steward', () => {
  test('header line, open row says why and the exit, no public review queue', async () => {
    const view = await mount(createElement(BookPanel, { desk: desk(), nowIso: AT }));
    const sections = [...view.host.querySelectorAll('.books-steward')].map((node) => node.getAttribute('data-steward'));
    expect(sections).toEqual(['quantanamo', 'oddsborne', 'bandit']);
    const q = view.host.querySelector('[data-steward="quantanamo"]');
    expect(q?.querySelector('.books-line')?.textContent).toBe('$5,157 · +3.1% since start · risk $351 of $550');
    expect(q?.querySelector('.books-over')).toBeNull();
    const bandit = view.host.querySelector('[data-steward="bandit"]');
    expect(bandit?.querySelector('.books-over')?.textContent).toBe(' · over budget');
    expect(bandit?.querySelector('.books-line')?.textContent).toContain('risk 0.20 of 0.18 SOL');
    const coda = button(view.host, 'button.books-lot[data-lot="eq:CODA"]');
    expect(coda.querySelector('b')?.textContent).toBe('CODA');
    expect(coda.querySelector('.books-lot-amt')?.textContent).toBe('$110.00');
    expect(coda.querySelector('.books-lot-pnl')?.textContent).toBe('+$10.00 (+10.0%)');
    expect(coda.querySelector('.books-lot-pnl')?.classList.contains('up')).toBe(true);
    expect(coda.querySelector('.books-lot-why')?.textContent)
      .toBe('Earnings gap structure. Exits below $10.35.');
    expect(coda.querySelector('.books-lot-rules')).toBeNull();
    expect(coda.textContent).not.toContain('score');
    expect(coda.textContent).not.toContain('backtest');
    expect(coda.textContent).not.toContain('Rules in force');
    expect(coda.textContent).not.toContain('no chase');
    expect(view.host.querySelector('[data-steward="oddsborne"] .books-none')?.textContent).toBe('Nothing open right now.');
    expect(view.host.textContent).not.toContain('Operator review');
    expect(view.host.textContent).not.toContain('To review');
    expect(view.host.querySelector('.thesis-page')).toBeNull();
    view.unmount();
  });

  test('visible surface has no ids, stated, or inval jargon', async () => {
    const view = await mount(createElement(BookPanel, { desk: desk(), nowIso: AT }));
    const text = view.host.textContent ?? '';
    expect(text).not.toContain(EARNINGS);
    expect(text).not.toContain(WEATHER);
    expect(text).not.toContain('stated');
    expect(text).not.toContain('inval');
    expect(text).not.toContain('hardening');
    await act(async () => {
      button(view.host, 'button.books-lot[data-lot="eq:CODA"]').click();
    });
    const detail = view.host.querySelector('.books-detail')?.textContent ?? '';
    expect(detail).not.toContain(EARNINGS);
    expect(detail).not.toContain('stated');
    expect(detail).not.toContain('inval');
    expect(detail).not.toContain('playbook_rule');
    view.unmount();
  });

  test('tapping a position opens its detail with the thesis, beliefs, and exit plan', async () => {
    const view = await mount(createElement(BookPanel, { desk: desk(), nowIso: AT }));
    await act(async () => {
      button(view.host, 'button.books-lot[data-lot="eq:CODA"]').click();
    });
    const detail = view.host.querySelector('.books-detail');
    expect(detail?.querySelector('h2')?.textContent).toBe('CODA');
    expect(detail?.getAttribute('data-desk-nested-scroll')).toBe('1');
    expect(view.host.querySelector('.books-stage')?.getAttribute('data-reading')).toBe('1');
    expect(detail?.textContent).toContain('QUANTANAMO · open position');
    expect(detail?.textContent).toContain('Under the post-print base.');
    expect(detail?.querySelector('h3')?.textContent).toBe('Earnings gap structure');
    expect(detail?.textContent).toContain(EARNINGS_SUMMARY);
    expect(detail?.querySelector('.thesis-page-falsifier')?.textContent).toBe(`Wrong if ${EARNINGS_FALSIFIER}`);
    expect(detail?.textContent).toContain('Track record: 6 trades + 2 backtests, score 56 · 2 wins');
    expect(detail?.textContent).toContain('Backtests: 2 logged (400 trades), +0.40% per trade after costs, counts for the score');
    expect(detail?.textContent).toContain('No chase leftovers.');
    expect(detail?.textContent).toContain('no chase already printed leftovers');
    expect(detail?.textContent).toContain('Rules in force');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(view.host.querySelector('.books-detail')).toBeNull();
    expect(view.host.querySelector('.books-stage')?.getAttribute('data-reading')).toBe('0');
    view.unmount();
  });

  test('earnings gap detail keeps process rules beside kill and negative_result', async () => {
    const payload = desk();
    payload.beliefs = [
      belief({
        id: 'b-80',
        observed_at: '2026-10-01T18:00:00.000Z',
        rationale: 'Walk-forward autopsy: kill.',
        rules: ['kill'],
      }),
      belief({
        id: 'b-79',
        observed_at: '2026-10-01T17:00:00.000Z',
        rationale: 'Walk-forward autopsy: negative result.',
        rules: ['negative_result'],
      }),
      belief({
        id: 'b-78',
        observed_at: '2026-10-01T16:00:00.000Z',
        rationale: 'Earlier negative result, same slug.',
        rules: ['negative_result'],
      }),
      belief({
        id: 'b-quality',
        observed_at: '2026-09-18T15:00:00.000Z',
        rationale: 'Drawdown into the print can still be the structure.',
        rules: ['quality_drawdown_into_print'],
      }),
      belief({
        id: 'b-recycle',
        observed_at: '2026-09-17T15:00:00.000Z',
        rules: ['recycle_over_exact_tp'],
      }),
      belief(),
    ];
    const view = await mount(createElement(BookPanel, { desk: payload, nowIso: AT }));
    await act(async () => {
      button(view.host, 'button.books-lot[data-lot="eq:CODA"]').click();
    });
    const notes = [...view.host.querySelectorAll('.books-detail .books-note')].map((node) => node.textContent ?? '');
    expect(notes.find((note) => note.startsWith('Rules in force'))).toBe(
      'Rules in force quality drawdown into print · recycle over exact tp · no chase already printed leftovers · kill · negative result',
    );
    const detail = view.host.querySelector('.books-detail')?.textContent ?? '';
    expect(detail).toContain('Walk-forward autopsy: kill.');
    expect(detail).toContain('Drawdown into the print can still be the structure.');
    view.unmount();
  });

  test('one watched idea is a short line; a tap opens that thesis', async () => {
    const view = await mount(createElement(BookPanel, { desk: desk(), nowIso: AT }));
    expect(view.host.querySelector('[data-steward="quantanamo"] .books-fold-toggle')).toBeNull();
    const idea = button(view.host, `button.books-idea[data-thesis="${WEATHER}"]`);
    expect(idea.getAttribute('data-watch')).toBe('1');
    expect(idea.textContent).toBe('Watching · Same-day city-high weather');
    expect(idea.textContent).not.toContain('score');
    expect(idea.textContent).not.toContain('not scored');
    await act(async () => {
      idea.click();
    });
    const detail = view.host.querySelector('.books-detail');
    expect(detail?.querySelector('h2')?.textContent).toBe('Same-day city-high weather');
    expect(detail?.textContent).toContain(WEATHER_SUMMARY);
    expect(detail?.textContent).toContain('Kill into a no-bid close.');
    expect(detail?.textContent).toContain('No positions on this idea yet.');
    await act(async () => {
      button(view.host, '.thesis-page-back').click();
    });
    expect(view.host.querySelector('.books-detail')).toBeNull();
    view.unmount();
  });

  test('several watched ideas stay behind one line until it opens', async () => {
    const payload = desk();
    payload.theses = [...payload.theses, {
      id: 'second_watch',
      name: 'Second watch idea',
      summary: 'Another idea with nothing open.',
      status: 'hardening',
      confidence: 60,
      time_horizon: 'days',
      stance: 'neutral',
      variant_perception: null,
      falsifier: null,
      created_at: AT,
      updated_at: AT,
      symbols: [],
      lots: [],
    }];
    const view = await mount(createElement(BookPanel, { desk: payload, nowIso: AT }));
    const toggle = button(view.host, '[data-steward="quantanamo"] .books-fold-toggle');
    expect(toggle.textContent).toContain('Watching · 2 ideas');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.host.querySelector('button.books-idea')).toBeNull();
    await act(async () => {
      toggle.click();
    });
    const idea = button(view.host, `button.books-idea[data-thesis="${WEATHER}"]`);
    expect(idea.getAttribute('data-watch')).toBeNull();
    expect(idea.textContent).toContain('Same-day city-high weather');
    await act(async () => {
      idea.click();
    });
    expect(view.host.querySelector('.books-detail h2')?.textContent).toBe('Same-day city-high weather');
    view.unmount();
  });

  test('outcomes list the thesis lessons, newest first, with show all past five', async () => {
    const lessons = Array.from({ length: 7 }, (_, index) => lesson(
      index + 1,
      `Lesson ${index + 1}`,
      `2026-09-1${index}T20:00:00.000Z`,
    ));
    const view = await mount(createElement(BookPanel, { desk: desk([], [], lessons), nowIso: AT }));
    await act(async () => {
      button(view.host, 'button.books-lot[data-lot="eq:CODA"]').click();
    });
    const shown = () => [...view.host.querySelectorAll('.books-lessons li p')].map((node) => node.textContent);
    expect(view.host.querySelector('.books-detail')?.textContent).toContain('Lessons · 7');
    expect(shown()).toEqual(['Lesson 7', 'Lesson 6', 'Lesson 5', 'Lesson 4', 'Lesson 3']);
    expect(view.host.querySelector('.books-lessons li span')?.textContent).toContain('missed swing · post print hold');
    await act(async () => {
      button(view.host, '.books-more').click();
    });
    expect(shown()).toHaveLength(7);
    view.unmount();
  });

  test('a closed prediction uses a short name; the question is in the detail', async () => {
    const base = desk();
    const withPm: DeskPayload = {
      ...base,
      prediction_markets: {
        ...base.prediction_markets,
        markets: [{
          id: 'm-fed',
          venue: 'prediction',
          slug: 'rdc-usfed-fomc-2026-09-16-hike25',
          question: 'Fed Decision in September — 25 bps Increase',
          status: 'resolved',
          close_time: null,
          last_yes: null,
          last_no: null,
          last_marked_at: null,
          thesis_id: null,
          rules_summary: null,
        }],
        positions: [{
          id: 'p-fed',
          market_id: 'm-fed',
          account_key: 'polymarket-us-primary',
          thesis_id: null,
          outcome: 'yes',
          status: 'closed',
          quantity: 42,
          average_cost: 0.46,
          mark: 1,
          mark_at: AT,
          thesis_text: null,
          untagged: 'historical',
        }],
      },
    };
    const view = await mount(createElement(BookPanel, { desk: withPm, nowIso: AT }));
    const toggle = button(view.host, '[data-steward="oddsborne"] .books-fold-toggle');
    expect(toggle.textContent).toContain('Closed · 1');
    await act(async () => {
      toggle.click();
    });
    const row = button(view.host, 'button.books-lot[data-lot="pm:p-fed"]');
    expect(row.querySelector('b')?.textContent).toBe('Fed, up 25 bps');
    expect(row.textContent).not.toContain('Fed Decision in September');
    expect(row.textContent).not.toContain('rdc-usfed');
    expect(row.querySelector('.books-lot-pnl')?.textContent).toBe('+$22.68 (+117.4%)');
    expect(row.querySelector('.books-lot-why')?.textContent).toBe('Opened before theses were tracked.');
    expect(row.querySelector('.books-lot-rules')).toBeNull();
    await act(async () => {
      row.click();
    });
    const detail = view.host.querySelector('.books-detail');
    expect(detail?.querySelector('h2')?.textContent).toBe('Fed, up 25 bps');
    expect(detail?.querySelector('.books-question')?.textContent).toBe('Fed Decision in September — 25 bps Increase');
    view.unmount();
  });

  test('one watched idea stays its own line when other ideas are not being watched', async () => {
    const payload = desk();
    payload.theses = [...payload.theses, {
      id: 'old_gap',
      name: 'Old gap idea',
      summary: 'Passed on after the print.',
      status: 'rejected',
      confidence: 20,
      time_horizon: 'days',
      stance: 'bullish',
      variant_perception: null,
      falsifier: null,
      created_at: AT,
      updated_at: AT,
      symbols: [],
      lots: [],
      venues: ['equity'],
    }];
    const view = await mount(createElement(BookPanel, { desk: payload, nowIso: AT }));
    const section = view.host.querySelector('[data-steward="quantanamo"]');
    const idea = button(view.host, `button.books-idea[data-thesis="${WEATHER}"]`);
    expect(idea.getAttribute('data-watch')).toBe('1');
    expect(idea.textContent).toBe('Watching · Same-day city-high weather');
    const toggle = button(view.host, '[data-steward="quantanamo"] .books-fold-toggle');
    expect(toggle.textContent).toContain('Not watching · 1 idea');
    expect(section?.textContent).not.toContain('set aside');
    expect(section?.textContent).not.toContain('score');
    await act(async () => {
      toggle.click();
    });
    await act(async () => {
      button(view.host, 'button.books-idea[data-thesis="old_gap"]').click();
    });
    expect(view.host.querySelector('.books-detail')?.textContent).toContain('set aside');
    view.unmount();
  });

  test('a football row names the side; the question stays in the detail', async () => {
    const base = desk();
    const sports = 'sports_devig_maker_edge';
    const dolphins = 'Who will win in the upcoming football event Miami Dolphins vs Minnesota Vikings scheduled for October 4, 2026 at 8:05 PM UTC?';
    const titans = 'Who will win in the upcoming football event Tennessee Titans vs Baltimore Ravens scheduled for October 4, 2026 at 5:00 PM UTC?';
    const withPm: DeskPayload = {
      ...base,
      theses: [...base.theses, {
        id: sports,
        name: 'Sports maker bids vs sportsbook no-vig fair',
        summary: 'Bid under the no-vig fair.',
        status: 'forming',
        confidence: 60,
        time_horizon: 'days',
        stance: 'neutral',
        variant_perception: null,
        falsifier: 'The bid is no longer cheap.',
        created_at: AT,
        updated_at: AT,
        symbols: [],
        lots: [],
        venues: ['prediction'],
      }],
      prediction_markets: {
        ...base.prediction_markets,
        markets: [{
          id: 'm-mia',
          venue: 'prediction',
          slug: 'aec-nfl-mia-min-2026-10-04',
          question: dolphins,
          status: 'open',
          close_time: null,
          last_yes: 0.1625,
          last_no: null,
          last_marked_at: AT,
          thesis_id: sports,
          rules_summary: null,
        }, {
          id: 'm-ten',
          venue: 'prediction',
          slug: 'aec-nfl-ten-bal-2026-10-04',
          question: titans,
          status: 'open',
          close_time: null,
          last_yes: 0.1475,
          last_no: null,
          last_marked_at: AT,
          thesis_id: sports,
          rules_summary: null,
        }],
        positions: [{
          id: 'p-mia',
          market_id: 'm-mia',
          account_key: 'polymarket-us-primary',
          thesis_id: sports,
          outcome: 'yes',
          status: 'open',
          quantity: 13,
          average_cost: 0.158,
          mark: 0.1625,
          mark_at: AT,
          thesis_text: null,
          untagged: null,
          invalidation_price: 0.1018,
          invalidation_note: null,
        }, {
          id: 'p-ten',
          market_id: 'm-ten',
          account_key: 'polymarket-us-primary',
          thesis_id: sports,
          outcome: 'yes',
          status: 'open',
          quantity: 14,
          average_cost: 0.146,
          mark: 0.1475,
          mark_at: AT,
          thesis_text: null,
          untagged: null,
          invalidation_price: 0.0858,
          invalidation_note: null,
        }],
      },
    };
    const view = await mount(createElement(BookPanel, { desk: withPm, nowIso: AT }));
    const mia = button(view.host, 'button.books-lot[data-lot="pm:p-mia"]');
    const ten = button(view.host, 'button.books-lot[data-lot="pm:p-ten"]');
    expect(mia.querySelector('b')?.textContent).toBe('Dolphins');
    expect(ten.querySelector('b')?.textContent).toBe('Titans');
    expect(mia.querySelector('.books-lot-why')?.textContent)
      .toBe('Sports maker bids vs sportsbook no-vig fair. Exits below $0.10.');
    expect(ten.querySelector('.books-lot-why')?.textContent)
      .toBe('Sports maker bids vs sportsbook no-vig fair. Exits below $0.09.');
    for (const row of [mia, ten]) {
      expect(row.textContent).not.toContain('Who will win');
      expect(row.textContent).not.toContain('score');
      expect(row.textContent).not.toContain('Rules in force');
      expect(row.textContent).not.toContain('not scored');
    }
    await act(async () => {
      mia.click();
    });
    const detail = view.host.querySelector('.books-detail');
    expect(detail?.querySelector('h2')?.textContent).toBe('Dolphins');
    expect(detail?.querySelector('.books-question')?.textContent).toBe(dolphins);
    view.unmount();
  });

  test('operator desk keeps the review fold; the public desk never renders it', async () => {
    const view = await mount(createElement(BookPanel, {
      desk: desk([], [], [lesson(1, 'Do not chase a printed gap.')]),
      nowIso: AT,
      canReview: true,
      canIncorporate: true,
    }));
    const toggles = [...view.host.querySelectorAll('.books-operator .books-fold-toggle')];
    expect(toggles).toHaveLength(1);
    await act(async () => {
      button(view.host, '.books-operator .books-fold-toggle').click();
    });
    expect(view.host.textContent).toContain('To review');
    expect(view.host.textContent).toContain('Incorporate');
    view.unmount();
  });
});
