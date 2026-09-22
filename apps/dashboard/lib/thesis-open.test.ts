import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { PLAYBOOK_RULE_KIND, type BeliefUpdateRow } from './beliefs';
import { MARK_NOT_IN_LEDGER } from './book-performance';
import { deskFromWire } from './desk-client';
import { fallbackTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';

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
const { BeliefQueue, TaggedLotQueue } = await import('../app/terminal/belief-queue');
const { ThesesWorld } = await import('../app/terminal/theses-world');

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
  };
}

function desk(
  extraNames: ReturnType<typeof nameRow>[] = [],
  extraPositions: ReturnType<typeof position>[] = [],
  lessons: unknown[] = [],
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

function twoThesesDesk(): DeskPayload {
  return desk([nameRow('APP')], [position('ep-app', 'APP', WEATHER)]);
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

/** Browser rule: Enter activates a button unless keydown was cancelled. */
async function pressEnter(node: HTMLButtonElement) {
  node.focus();
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  if (!event.defaultPrevented) node.click();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('belief and tagged-lot cards open a thesis', () => {
  test('belief card invokes open with that thesis id', async () => {
    const opened: string[] = [];
    const view = await mount(createElement(BeliefQueue, {
      desk: desk(),
      onOpenThesis: (id: string) => opened.push(id),
    }));
    await act(async () => {
      button(view.host, 'button[data-belief="b-weather"]').click();
    });
    expect(opened).toEqual([WEATHER]);
    view.unmount();
  });

  test('tagged lot card invokes open with that thesis id', async () => {
    const opened: string[] = [];
    const view = await mount(createElement(TaggedLotQueue, {
      desk: desk(),
      onOpenThesis: (id: string) => opened.push(id),
    }));
    await act(async () => {
      button(view.host, 'button[data-tagged-lot="eq:CODA"]').click();
    });
    expect(opened).toEqual([EARNINGS]);
    view.unmount();
  });
});

describe('Theses learning surfaces open the live thesis page', () => {
  test('belief Enter, tagged lot, and the single-thesis pulse chip open that summary', async () => {
    const view = await mount(createElement(ThesesWorld, { desk: desk() }));
    const pulse = view.host.querySelector('.learning-pulse');
    expect(pulse?.tagName).toBe('DIV');
    expect(pulse?.querySelector('.visually-hidden')?.textContent).toContain('1 tagged lot');
    expect(pulse?.querySelector('.visually-hidden')?.textContent).toContain('beliefs in force');
    expect(button(view.host, '[data-pulse-thesis]').dataset.pulseThesis).toBe(EARNINGS);
    expect(button(view.host, '[data-pulse-thesis]').classList.contains('learning-pulse-chip')).toBe(true);
    expect(view.host.querySelector('[data-pulse-lots]')).toBeNull();
    expect(pulse?.textContent).toContain('1 tagged lot');

    await act(async () => {
      await pressEnter(button(view.host, 'button[data-belief="b-weather"]'));
    });
    expect(view.host.querySelector('.thesis-page h2')?.textContent).toBe('Same-day city-high weather');
    expect(view.host.querySelector('.thesis-page')?.textContent).toContain(WEATHER_SUMMARY);
    expect(view.host.querySelector('.thesis-page')?.textContent).not.toContain(EARNINGS_SUMMARY);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(view.host.querySelector('.thesis-page')).toBeNull();

    const world = view.host.querySelector('.thesis-world');
    if (!(world instanceof HTMLElement)) throw new Error('missing thesis world');
    world.scrollTop = 480;
    await act(async () => {
      button(view.host, 'button[data-tagged-lot="eq:CODA"]').click();
    });
    expect(world.scrollTop).toBe(0);
    expect(view.host.querySelector('.thesis-page h2')?.textContent).toBe('Earnings gap structure');
    expect(view.host.querySelector('.thesis-page')?.textContent).toContain(EARNINGS_SUMMARY);
    expect(view.host.querySelector('.thesis-page-falsifier')?.textContent).toBe(EARNINGS_FALSIFIER);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await act(async () => {
      button(view.host, '[data-pulse-thesis]').click();
    });
    expect(view.host.querySelector('.thesis-page')?.textContent).toContain(EARNINGS_SUMMARY);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await act(async () => {
      button(view.host, 'button.thesis-card[data-thesis="earnings_gap_structure"]').click();
    });
    expect(view.host.querySelector('.thesis-page h2')?.textContent).toBe('Earnings gap structure');
    view.unmount();
  });

  test('several tagged theses focus the lot cards instead of a combined thesis', async () => {
    const view = await mount(createElement(ThesesWorld, { desk: twoThesesDesk() }));
    const pulse = view.host.querySelector('.learning-pulse');
    expect(view.host.querySelector('[data-pulse-thesis]')).toBeNull();
    expect(pulse?.querySelector('.visually-hidden')?.textContent).toContain('2 tagged lots');
    const lots = view.host.querySelector('#tagged-lots');
    if (!(lots instanceof HTMLElement)) throw new Error('missing tagged lots');
    let scrolled = false;
    lots.scrollIntoView = () => {
      scrolled = true;
    };
    await act(async () => {
      button(view.host, '[data-pulse-lots]').click();
    });
    expect(scrolled).toBe(true);
    expect(lots.classList.contains('is-pulse-target')).toBe(true);
    expect(document.activeElement).toBe(lots);
    expect(view.host.querySelector('.thesis-page')).toBeNull();
    await act(async () => {
      button(view.host, 'button[data-belief="b-gap"]').click();
    });
    expect(view.host.querySelector('.thesis-page')?.textContent).toContain(EARNINGS_SUMMARY);
    view.unmount();
  });

  test('beliefs control reveals live rule text, then opens that thesis', async () => {
    const view = await mount(createElement(ThesesWorld, { desk: desk() }));
    const beliefs = button(view.host, '[data-pulse-beliefs]');
    expect(beliefs.getAttribute('aria-expanded')).toBe('false');
    expect(view.host.querySelector('#learning-pulse-beliefs')).toBeNull();
    await act(async () => {
      beliefs.click();
    });
    expect(beliefs.getAttribute('aria-expanded')).toBe('true');
    const panel = view.host.querySelector('#learning-pulse-beliefs');
    expect(panel?.textContent).toContain('Earnings gap structure');
    expect(panel?.textContent).toContain('no chase already printed leftovers');
    expect(panel?.textContent).toContain('No chase leftovers.');
    expect(panel?.textContent).toContain('Same-day city-high weather');
    expect(panel?.textContent).toContain('Kill into a no-bid close.');
    expect(panel?.textContent).toContain('no bid close');
    await act(async () => {
      button(view.host, '[data-pulse-belief="b-weather"]').click();
    });
    expect(view.host.querySelector('.thesis-page h2')?.textContent).toBe('Same-day city-high weather');
    expect(view.host.querySelector('.thesis-page')?.textContent).toContain(WEATHER_SUMMARY);
    view.unmount();
  });

  test('lessons control focuses the lessons parchment and does not invent a body', async () => {
    const view = await mount(createElement(ThesesWorld, {
      desk: desk([], [], [{
        id: 37,
        cycle_id: 1,
        test_id: null,
        thesis_id: EARNINGS,
        lesson_type: 'structure',
        summary: 'Do not chase a printed gap.',
        market_regime: null,
        incorporated: false,
        created_at: AT,
      }]),
    }));
    expect(view.host.querySelector('.learning-pulse .visually-hidden')?.textContent).toContain('1 open / 0 in playbook');
    const lessons = view.host.querySelector('#lessons-parchment');
    if (!(lessons instanceof HTMLElement)) throw new Error('missing lessons parchment');
    await act(async () => {
      button(view.host, '[data-pulse-lessons]').click();
    });
    expect(document.activeElement).toBe(lessons);
    expect(lessons.classList.contains('is-pulse-target')).toBe(true);
    expect(lessons.textContent).toContain('Do not chase a printed gap.');
    expect(view.host.querySelector('.learning-pulse')?.textContent).not.toContain('Do not chase a printed gap.');
    expect(view.host.querySelector('.thesis-page')).toBeNull();
    view.unmount();
  });
});
