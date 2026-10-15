import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { assembleTeam } from './desk-team';
import { blurFocusLeavingSurface, blurFocusWithin } from './desk-focus';
import type { DeskPayload } from './ledger-types';
import { scrollTeamStageToSteward, scrollTopForSection } from './desk-team-scroll';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLAnchorElement: dom.HTMLAnchorElement,
  Element: dom.Element,
  Node: dom.Node,
  DocumentFragment: dom.DocumentFragment,
  SVGElement: dom.SVGElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  navigator: dom.navigator,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  MutationObserver: dom.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TeamPanel } = await import('../app/terminal/team-panel');

function rect(top: number, height: number): DOMRect {
  const box = {
    x: 0,
    y: top,
    left: 0,
    right: 390,
    top,
    bottom: top + height,
    width: 390,
    height,
    toJSON() {
      return {};
    },
  };
  // SAFETY: only top and height are read; the stand-in is not a live DOMRect.
  return box as DOMRect;
}

function place(node: HTMLElement, top: number, height: number) {
  node.getBoundingClientRect = () => rect(top, height);
}

function size(node: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => clientHeight });
}

function block(slug: string, scorecard = true): HTMLElement {
  const item = document.createElement('li');
  item.className = 'team-li';
  const card = document.createElement('article');
  card.className = 'team-card';
  card.setAttribute('data-steward', slug);
  const face = document.createElement('span');
  face.setAttribute('data-steward', slug);
  card.append(face);
  item.append(card);
  if (scorecard) {
    const score = document.createElement('section');
    score.className = 'score-card';
    score.setAttribute('data-steward', slug);
    item.append(score);
  }
  return item;
}

describe('team steward scroll', () => {
  test('pins the roster row to the scroller top from any previous scroll', () => {
    const stage = document.createElement('div');
    stage.className = 'steward-stage';
    const quantanamo = block('quantanamo');
    const oddsborne = block('oddsborne');
    const bandit = block('bandit');
    stage.append(quantanamo, oddsborne, bandit);
    document.body.append(stage);

    // Viewport sits under the header. Content offsets assume scrollTop 900:
    // visual top = 80 + (contentOffset - 900).
    const scrollTop = 900;
    const viewportTop = 80;
    stage.scrollTop = scrollTop;
    size(stage, 1800, 500);
    place(stage, viewportTop, 500);
    place(quantanamo, viewportTop + (220 - scrollTop), 360);
    const score = quantanamo.querySelector('.score-card');
    if (!(score instanceof HTMLElement)) throw new Error('missing scorecard');
    place(score, viewportTop + (420 - scrollTop), 160);
    place(oddsborne, viewportTop + (800 - scrollTop), 360);
    place(bandit, viewportTop + (1500 - scrollTop), 280);

    expect(scrollTopForSection(stage, quantanamo)).toBe(220);
    expect(scrollTeamStageToSteward(stage, 'quantanamo')).toBe(true);
    expect(stage.scrollTop).toBe(220);

    stage.scrollTop = scrollTop;
    expect(scrollTeamStageToSteward(stage, 'oddsborne')).toBe(true);
    expect(stage.scrollTop).toBe(800);

    stage.scrollTop = scrollTop;
    expect(scrollTeamStageToSteward(stage, 'bandit')).toBe(true);
    expect(stage.scrollTop).toBe(1300);
    expect(scrollTeamStageToSteward(stage, 'missing')).toBe(false);
    expect(stage.scrollTop).toBe(1300);
    stage.remove();
  });

  test('grows the roster so the last steward can sit at the top', () => {
    const stage = document.createElement('div');
    stage.className = 'steward-stage';
    const roster = document.createElement('ul');
    roster.className = 'team-roster';
    const bandit = block('bandit', false);
    roster.append(bandit);
    stage.append(roster);
    document.body.append(stage);

    const scrollTop = 900;
    const viewportTop = 80;
    stage.scrollTop = scrollTop;
    Object.defineProperty(stage, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(stage, 'scrollHeight', {
      configurable: true,
      get: () => {
        const tail = stage.querySelector('[data-team-scroll-tail]');
        const extra = tail instanceof HTMLElement ? Number.parseFloat(tail.style.height) || 0 : 0;
        return 1800 + extra;
      },
    });
    place(stage, viewportTop, 500);
    place(bandit, viewportTop + (1500 - scrollTop), 280);

    expect(scrollTeamStageToSteward(stage, 'bandit')).toBe(true);
    const tail = stage.querySelector('[data-team-scroll-tail]');
    expect(tail instanceof HTMLElement ? tail.style.height : '').toBe('200px');
    expect(stage.scrollTop).toBe(1500);
    stage.remove();
  });
});

function desk(): DeskPayload {
  const fixture = {
    generated_at: '2026-09-06T13:24:00.000Z',
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: null,
      last4: '7638',
      buying_power: null,
      starting_nav: null,
      current_nav: null,
      cash: null,
      deployed: null,
      vs_start: null,
      vs_start_note: '',
      day_pnl: null,
      day_pnl_note: '',
      vs_cost: null,
      vs_cost_note: '',
      names: [],
    },
    positions: [],
    intents: [],
    fills: [],
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
  };
  // SAFETY: TeamPanel only reads team, book.names, and the empty position lists.
  return fixture as DeskPayload;
}

describe('Team panel scroll request', () => {
  let root: { render: (node: ReturnType<typeof createElement>) => void; unmount: () => void } | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';
  });

  test('a new scroll request pins that steward even when Team was already scrolled', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const payload = desk();
    await act(async () => {
      root?.render(createElement(TeamPanel, { desk: payload, now: Date.parse('2026-09-06T13:24:00.000Z') }));
    });
    const stage = host.querySelector('.steward-stage');
    if (!(stage instanceof dom.HTMLElement)) throw new Error('missing team stage');
    const row = (slug: string) => {
      const card = stage.querySelector(`.team-card[data-steward="${slug}"]`);
      const item = card?.closest('li');
      if (!(item instanceof dom.HTMLElement)) throw new Error(`missing ${slug}`);
      return item;
    };
    const quantanamo = row('quantanamo');
    const oddsborne = row('oddsborne');
    const bandit = row('bandit');
    size(stage, 1800, 500);
    place(stage, 80, 500);
    place(quantanamo, 80 + (220 - 900), 360);
    place(oddsborne, 80 + (800 - 900), 360);
    place(bandit, 80 + (1500 - 900), 280);
    stage.scrollTop = 900;

    await act(async () => {
      root?.render(createElement(TeamPanel, {
        desk: payload,
        now: Date.parse('2026-09-06T13:24:00.000Z'),
        scrollTo: { slug: 'quantanamo', seq: 1 },
      }));
    });
    expect(stage.scrollTop).toBe(220);

    stage.scrollTop = 900;
    await act(async () => {
      root?.render(createElement(TeamPanel, {
        desk: payload,
        now: Date.parse('2026-09-06T13:24:00.000Z'),
        scrollTo: { slug: 'bandit', seq: 2 },
      }));
    });
    expect(stage.scrollTop).toBe(1300);
  });
});

describe('aria-hidden focus release', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('blurs a control inside the page being left and leaves the destination alone', () => {
    document.body.innerHTML = `
      <section data-desk-page="leaderboard"><a id="team-link" href="/team">team</a></section>
      <section data-desk-page="book"><button id="idea" class="books-idea" type="button">idea</button></section>
      <section data-desk-page="team"></section>
    `;
    const link = document.getElementById('team-link');
    const idea = document.getElementById('idea');
    if (!(link instanceof dom.HTMLElement) || !(idea instanceof dom.HTMLElement)) {
      throw new Error('missing controls');
    }
    link.focus();
    expect(document.activeElement).toBe(link);
    blurFocusLeavingSurface('team');
    expect(document.activeElement).not.toBe(link);
    expect(document.body.contains(document.activeElement)).toBe(true);

    idea.focus();
    blurFocusLeavingSurface('book');
    expect(document.activeElement).toBe(idea);
    blurFocusLeavingSurface('leaderboard');
    expect(document.activeElement).not.toBe(idea);

    const list = document.createElement('div');
    list.className = 'books';
    list.append(idea);
    idea.focus();
    blurFocusWithin(list);
    expect(list.contains(document.activeElement)).toBe(false);
  });
});
