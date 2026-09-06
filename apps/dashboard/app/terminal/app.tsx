'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import { fetchDeskPayload, rememberDesk } from '../../lib/desk-client';
import {
  canonicalDeskPath,
  DESK_TABS,
  hrefForSurface,
  surfaceFromGoLetter,
  surfaceFromPath,
  type DeskSurface,
} from '../../lib/desk-nav';
import { heldAndCandidateSymbols } from '../../lib/held-catalyst';
import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { DeskPayload, DeskRoutine, ThesisRow } from '../../lib/ledger-types';
import type { VenueFilter } from '../../lib/desk-venue';
import { rowVenue } from '../../lib/desk-venue';
import {
  deskEvents,
  deskLessons,
  filterEvents,
  filterLessons,
  filterTheses,
  latestPredictionPnl,
  predictionDesk,
  venueChipLabel,
} from '../../lib/prediction-book';
import { BacktestsPanel } from './backtests-panel';
import { BookPanel } from './book-panel';
import { TeamPanel } from './team-panel';
import { VenueFilterBar, VenueMark } from './venue-filter';
import {
  age,
  ledgerFigure,
  money,
  moneyPrecise,
  nyStamp,
  pnlClass,
  qty,
  toneForStatus,
} from './format';

const POLL_MS = 15_000;

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
  const [selectedThesisId, setSelectedThesisId] = useState(initial.theses[0]?.id ?? '');
  const [selectedTestId, setSelectedTestId] = useState(initial.tests[0]?.id ?? null);
  const [goArmed, setGoArmed] = useState(false);
  const [surface, setSurface] = useState<DeskSurface>(() => surfaceFromPath(pathname));

  useEffect(() => {
    rememberDesk(initial);
  }, [initial]);

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

  function go(href: string) {
    const next = surfaceFromPath(href);
    setSurface(next);
    if (window.location.pathname !== href) {
      window.history.pushState({ desk: next }, '', href);
    }
  }

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
          const ids = desk.tests.map((row) => row.id);
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

  const selectedThesis = desk.theses.find((row) => row.id === selectedThesisId) ?? desk.theses[0];
  const lastLive = desk.routines.find((row) => row.status === 'live' && row.last_run_at);
  const nowIso = now === null ? desk.generated_at : new Date(now).toISOString();
  const pmPnl = latestPredictionPnl(predictionDesk(desk));

  return (
    <div className={publicView ? 'term term-public' : 'term'}>
      <header className="term-top">
        <a
          className="term-brand"
          href="/"
          onClick={(event) => onDeskClick(event, () => go('/'))}
        >
          GRASSHOPPER
        </a>
        <nav className="term-nav" aria-label="Terminal">
          {DESK_TABS.map((item) => (
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
        <LastRunChip routine={lastLive} now={now} />
        <div className="term-live">
          <i className={age(desk.generated_at, now) === 'n/a' ? 'stale' : 'live'} />
          {desk.source} · {age(desk.generated_at, now)}
        </div>
        {chrome}
      </header>
      {notice && <div className="term-banner" role="status">{notice}</div>}
      <main className="term-main">
        {surface === 'book' && <BookPanel desk={desk} nowIso={nowIso} />}
        {surface === 'theses' && (
          <ThesesPanel
            desk={desk}
            selected={selectedThesis}
            onSelect={setSelectedThesisId}
          />
        )}
        {surface === 'backtests' && (
          <BacktestsPanel
            desk={desk}
            selectedId={selectedTestId}
            onSelect={setSelectedTestId}
          />
        )}
        {surface === 'events' && <EventsPanel desk={desk} />}
        {surface === 'team' && <TeamPanel desk={desk} now={now} />}
      </main>
      <footer className="term-status">
        <span>NAV {ledgerFigure(desk.book.current_nav, moneyPrecise)}</span>
        <span>CASH {ledgerFigure(desk.book.cash, money)}</span>
        <span>BP {ledgerFigure(desk.book.buying_power, money)}</span>
        <span>DEPLOYED {ledgerFigure(desk.book.deployed, money)}</span>
        <span>POS {desk.counts.open_positions}</span>
        {pmPnl && (
          <span>PREDICTIONS {ledgerFigure(pmPnl.equity, moneyPrecise)}</span>
        )}
        <span>ASOF {desk.book.observed_at ? nyStamp(desk.book.observed_at) : NOT_IN_LEDGER}</span>
        <span>Q {desk.counts.open_research}</span>
        <span className="term-kbd">1-5 panels · g then letter · j/k thesis · r refresh · ? help</span>
      </footer>
      <nav className="term-dock" aria-label="Desk tabs">
        {DESK_TABS.map((item) => (
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
          <p>1 Book · 2 Theses · 3 Events · 4 Tests · 5 Team</p>
          <p>g b book · g t theses · g c events · g e tests · g m team</p>
          <p>j/k move thesis or test · Enter open theses · r reload ledger · Esc close</p>
        </aside>
      )}
    </div>
  );
}

function LastRunChip({ routine, now }: { routine?: DeskRoutine; now: number | null }) {
  if (!routine) {
    return (
      <div className="term-chip" title="No live QUANTANAMO run in public.runs">
        <i className="stale" />
        no QUANTANAMO run
      </div>
    );
  }
  const outcome = routine.last_outcome ?? '';
  return (
    <div
      className="term-chip"
      title={routine.last_summary || `${routine.name} · ${routine.cadence}`}
    >
      <i className={outcome ? toneForStatus(outcome) : 'live'} />
      {shortRoutine(routine.name)} {age(routine.last_run_at ?? undefined, now)}
    </div>
  );
}

function shortRoutine(name: string): string {
  if (/market scan/i.test(name)) return 'scan';
  if (/autopsy/i.test(name)) return 'autopsy';
  return name.replace(/^QUANTANAMO\s+/i, '');
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
    setNotice(error instanceof Error ? error.message : 'Ledger refresh failed');
  }
}

function ThesesPanel({
  desk,
  selected,
  onSelect,
}: {
  desk: DeskPayload;
  selected?: ThesisRow;
  onSelect: (id: string) => void;
}) {
  const [venue, setVenue] = useState<VenueFilter>('all');
  const theses = filterTheses(desk.theses, venue);
  const evidence = desk.evidence.filter((row) => row.thesis_id === selected?.id).slice(0, 12);
  const scores = desk.scores.filter((row) => row.thesis_id === selected?.id).slice(0, 24).reverse();
  const asOf = desk.book.observed_at ? nyStamp(desk.book.observed_at) : NOT_IN_LEDGER;
  const roles = selected
    ? heldAndCandidateSymbols(selected.symbols, selected.lots.map((lot) => lot.symbol))
    : { held: [], candidates: [] };
  const lots = selected
    ? selected.lots.filter((lot) => venue === 'all' || rowVenue(lot) === venue)
    : [];
  const themes = selected
    ? desk.ontology_themes.filter((row) => row.thesis_id === selected.id)
    : [];
  const themeIds = new Set(themes.map((row) => row.id));
  const candidates = selected
    ? desk.ontology_candidates.filter((row) =>
      (row.proposed_theme_id !== null && themeIds.has(row.proposed_theme_id))
      || selected.symbols.includes(row.proposed_label)
      || selected.symbols.includes(row.candidate_key),
    ).slice(0, 16)
    : [];
  const lessons = filterLessons(deskLessons(desk, selected?.id), venue);
  const postmortems = selected
    ? desk.postmortems.filter((row) => row.thesis_id === selected.id)
    : desk.postmortems;

  return (
    <div className="term-grid term-grid-theses">
      <section className="term-panel">
        <header><b>THESES</b><span>j/k · enter · snapshot {asOf}</span></header>
        <VenueFilterBar value={venue} onChange={setVenue} />
        <div className="term-scroll">
        <table>
          <thead><tr><th>Id</th><th>Src</th><th>Status</th><th>C</th><th>Stance</th><th>Held</th><th>Candidates</th></tr></thead>
          <tbody>
            {theses.map((row) => {
              const split = heldAndCandidateSymbols(row.symbols, row.lots.map((lot) => lot.symbol));
              return (
                <tr key={row.id} className={row.id === selected?.id ? 'sel' : ''} onClick={() => onSelect(row.id)}>
                  <td className="sym">{row.id}</td>
                  <td>{venueChipLabel(row.venues)}</td>
                  <td className={toneForStatus(row.status)}>{row.status}</td>
                  <td>{row.confidence}</td>
                  <td>{row.stance}</td>
                  <td>{split.held.slice(0, 4).join(' ') || '—'}</td>
                  <td>{split.candidates.slice(0, 4).join(' ') || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </section>
      <section className="term-panel">
        {selected ? (
          <>
            <header>
              <b>{selected.name}</b>
              <span className={toneForStatus(selected.status)}>{selected.status} · {selected.stance} · {selected.confidence}</span>
            </header>
            <p className="term-prose">{selected.summary}</p>
            {selected.falsifier && <p className="term-prose dim">Falsifier: {selected.falsifier}</p>}
            <Sparkline scores={scores.map((row) => row.confidence)} />
            <header><b>HELD / CANDIDATES</b><span>thesis_symbols · lots from 7638 snapshot</span></header>
            <p className="term-prose">
              Held {roles.held.join(' ') || '—'} · candidates {roles.candidates.join(' ') || '—'}
            </p>
            {lots.map((lot) => (
              <div key={`${selected.id}-${rowVenue(lot)}-${lot.symbol}`} className="term-skin">
                <div>
                  <i>Position</i>
                  <b>{lot.symbol} <VenueMark venue={rowVenue(lot)} /> · {lot.side.toUpperCase()} · {qty(lot.quantity)}</b>
                </div>
                <div>
                  <i>Invested</i>
                  <b>{ledgerFigure(lot.invested, moneyPrecise)}</b>
                </div>
                <div>
                  <i>Current</i>
                  <b className={pnlClass(lot.pnl)}>
                    {lot.mark === null ? (lot.note || 'mark not in ledger') : moneyPrecise(lot.mark)}
                  </b>
                </div>
              </div>
            ))}
            {!lots.length && <p className="empty">no position</p>}
            <header><b>THEMES</b><span>folded from ontology</span></header>
            {themes.map((row) => (
              <div key={row.id} className="term-line">
                <b>{row.name}</b>
                <span>{row.kind} · {row.id}</span>
                <i className={toneForStatus(row.status)}>{row.status}</i>
                <p>{row.description}</p>
              </div>
            ))}
            {!themes.length && <p className="empty">{NOT_IN_LEDGER}</p>}
            <header><b>CANDIDATES</b><span>linked to this thesis</span></header>
            {candidates.map((row) => (
              <div key={row.id} className="term-line">
                <b>{row.proposed_label}</b>
                <span>{row.candidate_type} · {row.source_count} src</span>
                <i>{row.score}</i>
              </div>
            ))}
            {!candidates.length && <p className="empty">{NOT_IN_LEDGER}</p>}
            <header><b>EVIDENCE</b><span>{evidence.length}</span></header>
            {evidence.map((row) => (
              <div key={row.id} className="term-line">
                <b className={toneForStatus(row.direction)}>{row.direction}</b>
                <span>{row.evidence_type} · {row.confidence}</span>
                <i>{nyStamp(row.created_at)}</i>
                <p>{row.summary}</p>
              </div>
            ))}
          </>
        ) : <p className="empty">No thesis selected</p>}
      </section>
      <section className="term-panel">
        <header>
          <b>LESSONS</b>
          <span>{desk.lessons.filter((row) => !row.incorporated).length} open loops</span>
        </header>
        {lessons.map((row) => (
          <div key={row.key} className="term-line">
            <b>{row.kind} <VenueMark venue={row.venue} /></b>
            <span>{row.thesis_id || 'unlinked'} · {row.regime || '—'}</span>
            <i className={row.pending ? 'warn' : 'up'}>{row.pending ? 'pending' : 'in model'}</i>
            <p>{row.summary}</p>
          </div>
        ))}
        {!lessons.length && <p className="empty">{NOT_IN_LEDGER}</p>}
        <header><b>POSTMORTEMS</b></header>
        {postmortems.map((row) => (
          <div key={row.id} className="term-line">
            <b>{row.outcome}</b>
            <span>{row.thesis_id || 'unlinked'}</span>
            <p>{row.lesson}</p>
          </div>
        ))}
        {selected && desk.insights.slice(0, 6).map((row) => (
          <div key={row.id} className="term-line">
            <b>{row.title}</b>
            <span>{row.insight_type} · conf {row.confidence}</span>
            <p>{row.summary}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

function Sparkline({ scores }: { scores: number[] }) {
  if (scores.length < 2) return null;
  const max = Math.max(...scores, 1);
  const min = Math.min(...scores, 0);
  const span = Math.max(1, max - min);
  const d = scores
    .map((value, index) => {
      const x = (index / (scores.length - 1)) * 120;
      const y = 28 - ((value - min) / span) * 24;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="term-spark" viewBox="0 0 120 32" aria-label="Confidence over time">
      <path d={d} />
    </svg>
  );
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
