'use client';

import {
  PUBLIC_DESK_REFRESH_FAILED,
  PUBLIC_DESK_UNAVAILABLE,
  PUBLIC_LIVE_INTERVAL_MS,
} from '@quantanamo/contracts/desk-snapshot';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import { cachedDesk, fetchDeskPayload, rememberDesk } from '../../lib/desk-client';
import {
  canonicalDeskPath,
  DESK_TABS,
  PUBLIC_DESK_TABS,
  hrefForSurface,
  surfaceFromGoLetter,
  surfaceFromPath,
  type DeskSurface,
  type DeskSwipeSurface,
} from '../../lib/desk-nav';
import { isSwipeSurface } from '../../lib/desk-swipe';
import { assembleDeskBookRollup } from '../../lib/desk-book-rollup';
import { assembleDeskFreshness, freshnessTone } from '../../lib/desk-freshness';
import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { DeskPayload } from '../../lib/ledger-types';
import type { VenueFilter } from '../../lib/desk-venue';
import { ledgerAmount } from '../../lib/money-units';
import {
  deskEvents,
  filterEvents,
} from '../../lib/prediction-book';
import { BacktestsPanel } from './backtests-panel';
import { BookPanel } from './book-panel';
import { DeskPager } from './desk-pager';
import { LeaderboardPanel } from './leaderboard-panel';
import { TeamPanel } from './team-panel';
import { ThesesWorld } from './theses-world';
import { VenueFilterBar, VenueMark } from './venue-filter';
import {
  age,
  nyStamp,
  toneForStatus,
} from './format';

const POLL_MS = PUBLIC_LIVE_INTERVAL_MS;

export function TerminalApp({
  initial,
  publicView = false,
  chrome = null,
  subscribeRefresh,
}: {
  initial: DeskPayload;
  publicView?: boolean;
  chrome?: ReactNode;
  subscribeRefresh?: (onChange: () => void) => () => void;
}) {
  const pathname = usePathname();
  const [desk, setDesk] = useState(initial);
  const [now, setNow] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedThesisId, setSelectedThesisId] = useState(initial.theses?.[0]?.id ?? '');
  const [selectedTestId, setSelectedTestId] = useState(initial.tests?.[0]?.id ?? null);
  const [goArmed, setGoArmed] = useState(false);
  const [surface, setSurface] = useState<DeskSurface>(() => surfaceFromPath(pathname));
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    rememberDesk(initial);
  }, [initial]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshDesk(setDesk, setNotice);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!subscribeRefresh) return undefined;
    return subscribeRefresh(() => {
      void refreshDesk(setDesk, setNotice);
    });
  }, [subscribeRefresh]);

  useEffect(() => {
    function onVis() {
      if (document.visibilityState === 'visible') {
        void refreshDesk(setDesk, setNotice);
      }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    function syncPath(path: string) {
      const canonical = canonicalDeskPath(path);
      setSurface(surfaceFromPath(canonical));
      if (canonical !== path && window.location.pathname !== canonical) {
        window.history.replaceState({ desk: surfaceFromPath(canonical) }, '', canonical);
      }
    }
    syncPath(window.location.pathname);
    function onPop() {
      syncPath(window.location.pathname);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [pathname]);

  const go = useCallback((href: string) => {
    const canonical = canonicalDeskPath(href);
    const next = surfaceFromPath(canonical);
    setSurface(next);
    if (window.location.pathname !== canonical) {
      window.history.pushState({ desk: next }, '', canonical);
    }
  }, []);

  const onPagerSnap = useCallback((next: DeskSwipeSurface) => {
    go(hrefForSurface(next));
  }, [go]);

  const reloadLedger = useCallback(() => refreshDesk(setDesk, setNotice), []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (event.key === 'Escape') {
          target.blur();
          setHelp(false);
        }
        return;
      }
      if (goArmed) {
        setGoArmed(false);
        const next = surfaceFromGoLetter(event.key);
        if (next) go(hrefForSurface(next));
        return;
      }
      if (event.key === 'g') {
        setGoArmed(true);
        return;
      }
      const nav = DESK_TABS.find((item) => item.key === event.key);
      if (nav) {
        event.preventDefault();
        go(nav.href);
        return;
      }
      if (event.key === 'r') {
        event.preventDefault();
        void refreshDesk(setDesk, setNotice);
        return;
      }
      if (event.key === '?') {
        setHelp((value) => !value);
        return;
      }
      if (event.key === 'Escape') setHelp(false);
      if (event.key === 'j' || event.key === 'k') {
        if (surface === 'backtests') {
          const ids = (desk.tests ?? []).map((row) => row.id);
          const index = ids.indexOf(selectedTestId ?? -1);
          const next = event.key === 'j' ? Math.min(ids.length - 1, Math.max(0, index) + 1) : Math.max(0, index - 1);
          if (ids[next] !== undefined) setSelectedTestId(ids[next]);
          return;
        }
        const ids = desk.theses.map((row) => row.id);
        const index = ids.indexOf(selectedThesisId);
        const next = event.key === 'j' ? Math.min(ids.length - 1, index + 1) : Math.max(0, index - 1);
        if (ids[next]) setSelectedThesisId(ids[next]);
      }
      if (event.key === 'Enter' && surface !== 'theses') go('/theses');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desk.tests, desk.theses, goArmed, selectedTestId, selectedThesisId, surface]);

  const freshness = assembleDeskFreshness(desk);
  const nowIso = now === null ? desk.generated_at : new Date(now).toISOString();
  const rollup = assembleDeskBookRollup(desk);
  const tabs = publicView ? PUBLIC_DESK_TABS : DESK_TABS;
  const swipe = isSwipeSurface(surface);

  return (
    <div className={`${publicView ? 'term term-public' : 'term'}${surface === 'leaderboard' || surface === 'book' ? ' is-line' : ''}${swipe ? ' is-swipe' : ''}${surface === 'theses' ? ' is-theses' : ''}`}>
      <header className="term-top">
        <a
          className="term-brand"
          href="/"
          onClick={(event) => onDeskClick(event, () => go('/'))}
        >
          GRASSHOPPER
        </a>
        <nav className="term-nav" aria-label="Terminal">
          {tabs.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={surface === item.id ? 'on' : ''}
              onClick={(event) => onDeskClick(event, () => go(item.href))}
            >
              <kbd>{item.key}</kbd>
              {item.label}
            </a>
          ))}
        </nav>
        <FreshnessChips freshness={freshness} now={now} />
        {chrome}
      </header>
      {notice && <div className="term-banner" role="status">{notice}</div>}
      <main className="term-main">
        {swipe && (
          <DeskPager
            surface={surface}
            reduceMotion={reduceMotion}
            onSnap={onPagerSnap}
            onRefresh={reloadLedger}
          >
            {{
              leaderboard: <LeaderboardPanel desk={desk} now={now} onOpenTeam={() => go('/team')} />,
              book: <BookPanel desk={desk} nowIso={nowIso} />,
              theses: (
                <ThesesWorld
                  desk={desk}
                  reduceMotion={reduceMotion}
                  selectedId={selectedThesisId}
                  onSelect={setSelectedThesisId}
                  canReview={!publicView}
                  canIncorporate={!publicView}
                  onReviewed={publicView ? undefined : () => {
                    void refreshDesk(setDesk, setNotice);
                  }}
                />
              ),
              team: <TeamPanel desk={desk} reduceMotion={reduceMotion} now={now} />,
            }}
          </DeskPager>
        )}
        {surface === 'backtests' && (
          <BacktestsPanel
            desk={desk}
            selectedId={selectedTestId}
            onSelect={setSelectedTestId}
          />
        )}
        {surface === 'events' && <EventsPanel desk={desk} />}
      </main>
      <footer className="term-status">
        <span>USD NAV {ledgerAmount(rollup.usd_nav, 'USD')}</span>
        <span>USD CASH {ledgerAmount(rollup.usd_cash, 'USD')}</span>
        <span>SOL {ledgerAmount(rollup.sol_equity, 'SOL')}</span>
        <span>POS {rollup.open_lots}</span>
        <span>ASOF {desk.book.observed_at ? nyStamp(desk.book.observed_at) : NOT_IN_LEDGER}</span>
        <span>Q {desk.counts.open_research}</span>
        <span className="term-kbd">1-6 panels · g then letter · j/k thesis · r refresh · ? help</span>
      </footer>
      <nav className={`term-dock${publicView ? ' is-indicator' : ''}`} aria-label="Desk tabs">
        {tabs.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={surface === item.id ? 'on' : ''}
            onClick={(event) => onDeskClick(event, () => go(item.href))}
          >
            {item.label}
          </a>
        ))}
      </nav>
      {help && (
        <aside className="term-help">
          <b>Keyboard</b>
          <p>1 Board · 2 Book · 3 Theses · 4 Events · 5 Tests · 6 Team</p>
          <p>g p board · g b book · g t theses · g c events · g e tests · g m team</p>
          <p>j/k move thesis or test · Enter open theses · r reload ledger · Esc close</p>
        </aside>
      )}
    </div>
  );
}

function FreshnessChips({
  freshness,
  now,
}: {
  freshness: ReturnType<typeof assembleDeskFreshness>;
  now: number | null;
}) {
  const clock = now === null ? null : new Date(now);
  return (
    <div className="term-fresh" aria-label="Desk freshness">
      {freshness.chips.map((chip) => (
        <div key={chip.id} className="term-chip" title={chip.title}>
          <i className={clock ? freshnessTone(chip.at, clock) : 'stale'} />
          {chip.label} · {age(chip.at ?? undefined, now)}
        </div>
      ))}
    </div>
  );
}

function onDeskClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  navigate();
}

async function refreshDesk(
  setDesk: (desk: DeskPayload) => void,
  setNotice: (value: string | null) => void,
): Promise<void> {
  try {
    setDesk(await fetchDeskPayload());
    setNotice(null);
  } catch (error) {
    const message = error instanceof Error ? error.message : PUBLIC_DESK_UNAVAILABLE;
    const shown = message.includes('Unexpected token') ? PUBLIC_DESK_UNAVAILABLE : message;
    setNotice(cachedDesk() ? PUBLIC_DESK_REFRESH_FAILED : shown);
  }
}

function EventsPanel({ desk }: { desk: DeskPayload }) {
  const [venue, setVenue] = useState<VenueFilter>('all');
  const events = filterEvents(deskEvents(desk), venue);
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>CATALYSTS</b><span>dated events · earnings and market close</span></header>
        <VenueFilterBar value={venue} onChange={setVenue} />
        {events.map((row) => (
          <div key={row.key} className="term-line">
            <b className="sym">{row.name} <VenueMark venue={row.venue} /></b>
            <span>{row.kind} · {row.when || 'undated'} · {row.thesis_id || 'unlinked'}</span>
            <i className={toneForStatus(row.status)}>{row.status}</i>
            <p>{row.summary}</p>
          </div>
        ))}
        {!events.length && <p className="empty">{NOT_IN_LEDGER}</p>}
      </section>
      <section className="term-panel">
        <header><b>RESEARCH QUEUE</b><span>{desk.counts.open_research} open</span></header>
        {desk.queue.map((row) => (
          <div key={row.id} className="term-line">
            <b>{row.priority}</b>
            <span>{row.topic}</span>
            <i>{row.status}</i>
            <p>{row.reason}</p>
          </div>
        ))}
        {!desk.queue.length && <p className="empty">{NOT_IN_LEDGER}</p>}
      </section>
    </div>
  );
}
