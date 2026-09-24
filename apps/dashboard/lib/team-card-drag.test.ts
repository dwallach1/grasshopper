import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { assembleTeam } from './desk-team';
import type { DeskPayload } from './ledger-types';

const dom = new Window({ url: 'http://localhost/team' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Element: dom.Element,
  Node: dom.Node,
  DocumentFragment: dom.DocumentFragment,
  SVGElement: dom.SVGElement,
  Event: dom.Event,
  PointerEvent: dom.PointerEvent,
  Touch: dom.Touch,
  TouchEvent: dom.TouchEvent,
  navigator: dom.navigator,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  MutationObserver: dom.MutationObserver,
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DeskPager } = await import('../app/terminal/desk-pager');
const { TeamPanel } = await import('../app/terminal/team-panel');

function desk(): DeskPayload {
  return {
    generated_at: '2026-09-06T13:24:00.000Z',
    snapshots: [],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: '2026-09-06T13:10:00.000Z',
      last4: '7638',
      buying_power: null,
      starting_nav: 5000,
      current_nav: 6020,
      cash: null,
      deployed: null,
      vs_start: 1020,
      vs_start_note: '',
      day_pnl: null,
      day_pnl_note: '',
      vs_cost: null,
      vs_cost_note: '',
      names: [],
    },
    positions: [],
    exposures: [],
    fills: [],
    intents: [],
    team: assembleTeam({
      agents: [
        {
          id: 'agent-q',
          slug: 'quantanamo',
          display_name: 'QUANTANAMO',
          role_title: 'Equities trader',
          charter: 'Stocks.',
          accent: '#5b8def',
          avatar_key: 'quant',
          status: 'active',
          heartbeat_at: '2026-09-06T13:23:04.000Z',
          sort_order: 2,
          meta: {},
        },
        {
          id: 'agent-o',
          slug: 'oddsborne',
          display_name: 'ODDSBORNE',
          role_title: 'Prediction markets trader',
          charter: 'PM.',
          accent: '#c084fc',
          avatar_key: 'odds',
          status: 'active',
          heartbeat_at: null,
          sort_order: 3,
          meta: {},
        },
        {
          id: 'agent-b',
          slug: 'bandit',
          display_name: 'BANDIT',
          role_title: 'Meme-coin trader',
          charter: 'Coins.',
          accent: '#f59e0b',
          avatar_key: 'bandit',
          status: 'active',
          heartbeat_at: null,
          sort_order: 4,
          meta: {},
        },
      ],
      domains: [
        { id: 'dom-e', slug: 'equity', name: 'Stocks', kind: 'trading', description: '', accent: '#5b8def', status: 'active', sort_order: 10, meta: {} },
        { id: 'dom-p', slug: 'prediction', name: 'Predictions', kind: 'trading', description: '', accent: '#c084fc', status: 'active', sort_order: 20, meta: {} },
        { id: 'dom-m', slug: 'meme', name: 'Meme coins', kind: 'trading', description: '', accent: '#f59e0b', status: 'active', sort_order: 30, meta: {} },
      ],
      stewards: [
        { id: 's-e', domain_id: 'dom-e', agent_id: 'agent-q', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
        { id: 's-p', domain_id: 'dom-p', agent_id: 'agent-o', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
        { id: 's-m', domain_id: 'dom-m', agent_id: 'agent-b', is_primary: true, assigned_at: '2026-09-01T00:00:00.000Z', ended_at: null, note: null },
      ],
      accounts: [],
    }),
  } as unknown as DeskPayload;
}

function pointer(type: string, target: EventTarget, x: number, y: number) {
  const event = new dom.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
  });
  target.dispatchEvent(event);
}

describe('Team card handle vs circular pager', () => {
  let root: { unmount: () => void } | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';
  });

  test('handle reorder stays on Team; card body does not page; mast swipe still wraps', async () => {
    const snaps: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(DeskPager, {
        surface: 'team',
        reduceMotion: true,
        onSnap: (next: string) => {
          snaps.push(next);
        },
        onRefresh: async () => {},
        children: {
          leaderboard: createElement('div', null, 'Board'),
          book: createElement('div', null, 'Book'),
          theses: createElement('div', null, 'Theses'),
          team: createElement(TeamPanel, { desk: desk(), reduceMotion: true, now: Date.parse('2026-09-06T13:24:00.000Z') }),
        },
      }));
    });

    const handle = document.querySelector('.team-card-handle');
    const card = document.querySelector('.team-card');
    const mast = document.querySelector('.team-mast');
    const pager = document.querySelector('.desk-pager');
    const track = document.querySelector('.steward-deck-track');
    expect(handle).toBeTruthy();
    expect(handle?.getAttribute('data-card-dragger')).toBe('1');
    expect(handle?.getAttribute('aria-label')).toBe('Reorder QUANTANAMO');
    expect(card?.getAttribute('data-team-card')).toBe('1');
    expect(card?.getAttribute('data-card-dragger')).toBeNull();
    expect(track?.getAttribute('style')).toContain('translateX(0%)');

    await act(async () => {
      pointer('pointerdown', handle as Element, 200, 180);
      pointer('pointermove', window, 140, 184);
    });
    expect(track?.getAttribute('style')).toContain('translateX(-100%)');
    expect(snaps).toEqual([]);
    expect(pager?.getAttribute('data-swipe') ?? '').not.toContain('move:');
    await act(async () => {
      pointer('pointerup', window, 140, 184);
    });

    const grip = handle?.querySelector('i');
    if (!(grip instanceof Element)) throw new Error('missing reorder grip');
    await act(async () => {
      const startTouch = new Touch({ identifier: 7, target: grip, clientX: 70, clientY: 240 });
      grip.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [startTouch],
        changedTouches: [startTouch],
      }));
      const moved = new Touch({ identifier: 7, target: grip, clientX: 10, clientY: 244 });
      const move = new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [moved],
        changedTouches: [moved],
      });
      grip.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
      pointer('pointerdown', grip, 70, 240);
      pointer('pointermove', window, 70, 180);
      pointer('pointerup', window, 70, 180);
    });
    expect(track?.getAttribute('style')).toContain('translateX(-200%)');
    expect(snaps).toEqual([]);
    expect(pager?.getAttribute('data-swipe') ?? '').not.toContain('move:');

    const body = card?.querySelector('.team-card-copy');
    if (!(body instanceof Element)) throw new Error('missing card body');
    await act(async () => {
      const startTouch = new Touch({ identifier: 8, target: body, clientX: 220, clientY: 200 });
      body.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [startTouch],
        changedTouches: [startTouch],
      }));
      const moved = new Touch({ identifier: 8, target: body, clientX: 40, clientY: 206 });
      const move = new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [moved],
        changedTouches: [moved],
      });
      body.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
      const endTouch = new Touch({ identifier: 8, target: body, clientX: 40, clientY: 206 });
      body.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
        changedTouches: [endTouch],
      }));
    });
    expect(snaps).toEqual([]);
    expect(pager?.getAttribute('data-swipe')).toBe('card:team');
    await act(async () => {
      pointer('pointerdown', body, 220, 200);
      pointer('pointermove', window, 80, 204);
      pointer('pointerup', window, 80, 204);
    });
    expect(snaps).toEqual([]);
    expect(pager?.getAttribute('data-swipe')).toBe('card:team');
    expect(track?.getAttribute('style')).toContain('translateX(-200%)');

    await act(async () => {
      pointer('pointerdown', body, 200, 120);
      pointer('pointermove', window, 204, 220);
      pointer('pointerup', window, 204, 220);
    });
    expect(snaps).toEqual([]);
    expect(pager?.getAttribute('data-swipe') ?? '').toContain('pull:team');

    await act(async () => {
      pointer('pointerdown', mast as Element, 180, 40);
      pointer('pointermove', window, 40, 44);
      pointer('pointerup', window, 40, 44);
    });
    expect(snaps).toEqual(['leaderboard']);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
