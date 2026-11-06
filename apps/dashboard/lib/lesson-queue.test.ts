import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { BeliefUpdateRow } from './beliefs';
import type { DeskPayload, LessonRow, ThesisRow } from './ledger-types';
import type { LessonWait } from './lesson-waits';

const NOW = '2026-11-04T18:00:00.000Z';
const THESIS = 'earnings_gap_structure';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Element: dom.Element,
  Node: dom.Node,
  DocumentFragment: dom.DocumentFragment,
  SVGElement: dom.SVGElement,
  navigator: dom.navigator,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  MutationObserver: dom.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LessonQueue } = await import('../app/terminal/lesson-queue');

function lesson(partial: Partial<LessonRow> & Pick<LessonRow, 'id' | 'summary' | 'created_at'>): LessonRow {
  return {
    cycle_id: 1,
    test_id: null,
    thesis_id: THESIS,
    lesson_type: 'missed_swing',
    market_regime: 'post_print_hold',
    incorporated: false,
    ...partial,
  };
}

function thesis(): ThesisRow {
  return {
    id: THESIS,
    name: 'Earnings gap structure',
    summary: 'Gap leftovers are not a chase.',
    status: 'hardening',
    confidence: 70,
    time_horizon: 'days_to_weeks',
    stance: 'bullish',
    variant_perception: null,
    falsifier: null,
    created_at: NOW,
    updated_at: NOW,
    symbols: [],
    lots: [],
  };
}

function belief(lessonId: number): BeliefUpdateRow {
  return {
    id: `b-${lessonId}`,
    thesis_id: THESIS,
    domain_id: null,
    agent_id: null,
    prior_confidence: 32,
    new_confidence: 30,
    rationale: 'The close taught the line was paid.',
    observed_at: NOW,
    kind: 'trade_close_lesson',
    rules: [],
    steward: 'quantanamo',
    research_lesson_id: String(lessonId),
    pnl_sign: -1,
  };
}

function desk(): DeskPayload {
  const lessons: LessonRow[] = [
    lesson({ id: 142, summary: 'An old structure note still needs a decision.', created_at: '2026-10-20T16:00:00.000Z' }),
    lesson({
      id: 203,
      summary: 'Waiting on a test that already finished.',
      created_at: '2026-11-04T00:29:52.000Z',
      test_id: 51,
    }),
    lesson({
      id: 134,
      summary: 'The follow-through is still queued.',
      created_at: '2026-11-03T16:00:00.000Z',
      test_id: 41,
    }),
    lesson({ id: 212, summary: 'The line was paid in full.', created_at: '2026-11-04T16:07:31.000Z' }),
    lesson({
      id: 220,
      summary: 'A rule already in the playbook.',
      created_at: '2026-09-01T16:00:00.000Z',
      incorporated: true,
    }),
    lesson({
      id: 196,
      summary: 'RDDT moved more than the options price.',
      created_at: '2026-11-05T21:00:00.000Z',
      lesson_type: 'earnings_print',
      market_regime: null,
    }),
  ];
  const waits: LessonWait[] = [
    { lesson_id: 203, thesis_id: THESIS, test_id: 51, test_status: 'killed', age_days: 1 },
    { lesson_id: 134, thesis_id: THESIS, test_id: 41, test_status: 'queued', age_days: 4 },
  ];
  // SAFETY: LessonQueue reads generated_at, lessons, beliefs, theses, and lesson_waits only.
  return {
    generated_at: NOW,
    lessons,
    beliefs: [belief(212), {
      id: 'b-rddt',
      thesis_id: THESIS,
      domain_id: null,
      agent_id: null,
      prior_confidence: null,
      new_confidence: null,
      rationale: 'RDDT moved more than the options price.',
      observed_at: NOW,
      kind: 'earnings_print',
      rules: [],
      steward: 'quantanamo',
      research_lesson_id: '196',
      lot_id: '6d2c1c0a-1111-4111-8111-111111111111',
    }],
    theses: [thesis()],
    lesson_waits: waits,
  } as DeskPayload;
}

type Mounted = { host: HTMLElement; unmount: () => void };

async function mount(canIncorporate: boolean): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(LessonQueue, { desk: desk(), canIncorporate }));
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

describe('Lessons parchment', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('a killed test is ready to write, and a queued test stays waiting, with the line on the card', async () => {
    const view = await mount(false);
    expect(view.host.querySelector('.thesis-lede')?.textContent).toContain('Lessons ready to write into the playbook come first');
    expect(view.host.querySelector('.thesis-lede')?.textContent).toContain('Public phone is read-only.');
    expect(view.host.textContent).toContain('Ready to write into the playbook · 2');
    expect(view.host.textContent).toContain('Still waiting on a test · 1');
    expect(view.host.textContent).toContain('Already moved confidence · 1');
    expect(view.host.textContent).toContain('In the playbook · 2');
    const readyIds = [...view.host.querySelectorAll('ul[data-lesson-lane="ready"] [data-lesson]')]
      .map((node) => node.getAttribute('data-lesson'));
    expect(readyIds).toEqual(['142', '203']);
    const ready203 = view.host.querySelector('[data-lesson="203"]');
    expect(ready203?.textContent).toContain('Open 1 day');
    expect(ready203?.querySelector('.books-lesson-wait')?.textContent).toBe('Test finished, ready to decide');
    expect(ready203?.textContent).toContain('Earnings gap structure');
    const ready142 = view.host.querySelector('[data-lesson="142"]');
    expect(ready142?.textContent).toContain('Open 15 days');
    expect(ready142?.getAttribute('data-stale')).toBe('1');
    expect(ready142?.querySelector('.books-lesson-wait')).toBeNull();
    const waiting = view.host.querySelector('ul[data-lesson-lane="waiting"] [data-lesson="134"]');
    expect(waiting?.textContent).toContain('Open 1 day');
    expect(waiting?.querySelector('.books-lesson-wait')?.textContent).toBe('Waiting on test 41, queued 4 days');
    expect(view.host.querySelector('ul[data-lesson-lane="ready"]')?.textContent).not.toContain('The follow-through is still queued');
    expect(view.host.querySelector('[data-lesson="212"]')?.textContent).toContain('moved confidence');
    expect(view.host.querySelector('[data-lesson="220"]')?.textContent).toContain('in playbook');
    const print = view.host.querySelector('[data-lesson="196"]');
    expect(print?.getAttribute('data-earnings-bound')).toBe('1');
    expect(print?.textContent).toContain('belief written');
    expect(print?.textContent).toContain('Belief already written. Confidence stays.');
    expect(view.host.querySelector('ul[data-lesson-lane="ready"]')?.textContent).not.toContain('RDDT moved');
    expect(view.host.querySelector('ul[data-lesson-lane="waiting"]')?.textContent).not.toContain('RDDT moved');
    expect(view.host.querySelector('button')).toBeNull();
    view.unmount();
  });

  test('the public phone does not offer Incorporate, and the operator desk does on open lessons only', async () => {
    const locked = await mount(false);
    expect(locked.host.querySelector('button')).toBeNull();
    locked.unmount();
    const open = await mount(true);
    const buttons = [...open.host.querySelectorAll('button')].map((node) => node.textContent);
    expect(buttons).toEqual(['Incorporate', 'Incorporate', 'Incorporate']);
    expect(open.host.querySelector('[data-lesson="212"] button')).toBeNull();
    expect(open.host.querySelector('[data-lesson="220"] button')).toBeNull();
    expect(open.host.querySelector('[data-lesson="196"] button')).toBeNull();
    expect(open.host.querySelector('.thesis-lede')?.textContent).toContain('Incorporate writes a playbook rule.');
    expect(open.host.querySelector('.thesis-lede')?.textContent).not.toContain('Public phone is read-only.');
    open.unmount();
  });
});
