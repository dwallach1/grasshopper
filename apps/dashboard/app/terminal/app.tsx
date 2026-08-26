'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type MouseEvent } from 'react';
import { z } from 'zod';

import { fetchDeskPayload, rememberDesk } from '../../lib/desk-client';
import {
  DESK_TABS,
  hrefForSurface,
  surfaceFromGoLetter,
  surfaceFromPath,
  type DeskSurface,
} from '../../lib/desk-nav';
import type { BookPerformance, DeskPayload, DeskRoutine, ThesisRow } from '../../lib/ledger-types';
import { THESIS_STATUSES } from '../../lib/thesis-status';
import { SessionControls } from './session-controls';
import {
  age,
  ledgerFigure,
  money,
  moneyPrecise,
  nyStamp,
  pct,
  qty,
  signedMoney,
  titleCase,
  toneForStatus,
} from './format';

const POLL_MS = 15_000;

const DirectionSchema = z.enum(['supporting', 'challenging', 'neutral']);

export function TerminalApp({ initial, operatorEmail }: { initial: DeskPayload; operatorEmail: string }) {
  const pathname = usePathname();
  const [desk, setDesk] = useState(initial);
  const [now, setNow] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedThesisId, setSelectedThesisId] = useState(initial.theses[0]?.id ?? '');
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
    function onPop() {
      setSurface(surfaceFromPath(window.location.pathname));
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
        const ids = desk.theses.map((row) => row.id);
        const index = ids.indexOf(selectedThesisId);
        const next = event.key === 'j' ? Math.min(ids.length - 1, index + 1) : Math.max(0, index - 1);
        if (ids[next]) setSelectedThesisId(ids[next]);
      }
      if (event.key === 'Enter' && surface !== 'theses') go('/theses');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desk.theses, goArmed, selectedThesisId, surface]);

  const selectedThesis = desk.theses.find((row) => row.id === selectedThesisId) ?? desk.theses[0];
  const lastLive = desk.routines.find((row) => row.status === 'live' && row.last_run_at);

  return (
    <div className="term">
      <header className="term-top">
        <a
          className="term-brand"
          href="/"
          onClick={(event) => onDeskClick(event, () => go('/'))}
        >
          QUANTANAMO
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
        <div className="term-live">
          <i className={age(desk.generated_at, now) === 'n/a' ? 'stale' : 'live'} />
          {desk.source} · {age(desk.generated_at, now)}
        </div>
        <SessionControls email={operatorEmail} />
      </header>
      {notice && <div className="term-banner" role="status">{notice}</div>}
      <main className="term-main">
        {surface === 'home' && (
          <HomePanel
            desk={desk}
            now={now}
            selectedThesisId={selectedThesis?.id}
            onThesis={setSelectedThesisId}
          />
        )}
        {surface === 'book' && <BookPanel desk={desk} />}
        {surface === 'theses' && (
          <ThesesPanel
            desk={desk}
            selected={selectedThesis}
            busy={busy}
            onSelect={setSelectedThesisId}
            onMutate={mutate(setBusy, setNotice, setDesk)}
          />
        )}
        {surface === 'runs' && <RunsPanel desk={desk} now={now} />}
        {surface === 'backtests' && <BacktestsPanel desk={desk} />}
        {surface === 'catalysts' && <CatalystsPanel desk={desk} />}
        {surface === 'learnings' && (
          <LearningsPanel
            desk={desk}
            busy={busy}
            onMutate={mutate(setBusy, setNotice, setDesk)}
          />
        )}
        {surface === 'ontology' && <OntologyPanel desk={desk} />}
        {surface === 'risk' && <RiskPanel desk={desk} />}
      </main>
      <footer className="term-status">
        <span>NAV {ledgerFigure(desk.book.current_nav, moneyPrecise)}</span>
        <span>CASH {ledgerFigure(desk.book.cash, money)}</span>
        <span>DEPLOYED {ledgerFigure(desk.book.deployed, money)}</span>
        <span>POS {desk.counts.open_positions}</span>
        <span>Q {desk.counts.open_research}</span>
        <span>
          LAST {lastLive
            ? `${lastLive.name} ${age(lastLive.last_run_at ?? undefined, now)}`
            : 'no QUANTANAMO run in ledger'}
        </span>
        <span className="term-kbd">1-9 panels · g then letter · j/k thesis · r refresh · ? help</span>
      </footer>
      {help && (
        <aside className="term-help">
          <b>Keyboard</b>
          <p>1 Home · 2 Book · 3 Theses · 4 Runs · 5 Tests · 6 Catalysts · 7 Lessons · 8 Ontology · 9 Risk</p>
          <p>g h home · g b book · g t theses · g r runs · g e tests · g c catalysts · g l lessons · g o ontology · g i risk</p>
          <p>j/k move thesis · Enter open theses · r reload ledger · Esc close</p>
        </aside>
      )}
    </div>
  );
}

function onDeskClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  navigate();
}

function mutate(
  setBusy: (value: boolean) => void,
  setNotice: (value: string | null) => void,
  setDesk: (desk: DeskPayload) => void,
) {
  return async (label: string, work: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      await refreshDesk(setDesk, setNotice);
      setNotice(label);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Mutation failed');
    } finally {
      setBusy(false);
    }
  };
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

function BookStrip({ book }: { book: BookPerformance }) {
  return (
    <>
      <div className="term-kpis">
        <div>
          <i>NAV</i>
          <b>{ledgerFigure(book.current_nav, moneyPrecise)}</b>
        </div>
        <div>
          <i>vs start</i>
          <b className={pnlClass(book.vs_start)}>{signedMoney(book.vs_start)}</b>
        </div>
        <div>
          <i>Cash</i>
          <b>{ledgerFigure(book.cash, moneyPrecise)}</b>
        </div>
        <div>
          <i>Deployed</i>
          <b>{ledgerFigure(book.deployed, moneyPrecise)}</b>
        </div>
        <div>
          <i>Day P/L</i>
          <b className={pnlClass(book.day_pnl)}>{signedMoney(book.day_pnl)}</b>
        </div>
        <div>
          <i>vs cost</i>
          <b className={pnlClass(book.vs_cost)}>{signedMoney(book.vs_cost)}</b>
        </div>
      </div>
      <p className="term-prose dim">
        {book.account_label || 'Agentic'} proof book
        {book.observed_at ? ` · snapshot ${nyStamp(book.observed_at)}` : ''}
        {book.starting_nav !== null ? ` · start ${moneyPrecise(book.starting_nav)}` : ` · start ${book.vs_start_note}`}
        {`. Day P/L: ${book.day_pnl_note}. vs cost: ${book.vs_cost_note}.`}
      </p>
      <table>
        <thead>
          <tr>
            <th>Sym</th>
            <th>Qty</th>
            <th>Avg cost</th>
            <th>Cost</th>
            <th>Mark</th>
            <th>P/L</th>
          </tr>
        </thead>
        <tbody>
          {book.names.map((row) => (
            <tr key={row.symbol}>
              <td className="sym">{row.symbol}</td>
              <td>{qty(row.quantity)}</td>
              <td>{ledgerFigure(row.average_cost, moneyPrecise)}</td>
              <td>{ledgerFigure(row.cost, moneyPrecise)}</td>
              <td>{row.mark === null ? row.note : moneyPrecise(row.mark)}</td>
              <td className={pnlClass(row.pnl)}>{row.pnl === null ? row.note : signedMoney(row.pnl)}</td>
            </tr>
          ))}
          {!book.names.length && (
            <tr><td colSpan={6} className="empty">No open episodes in the ledger</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function pnlClass(value: number | null): string {
  if (value === null) return 'muted';
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'muted';
}

function HomePanel({
  desk,
  now,
  selectedThesisId,
  onThesis,
}: {
  desk: DeskPayload;
  now: number | null;
  selectedThesisId?: string;
  onThesis: (id: string) => void;
}) {
  const latestEvidence = desk.evidence.slice(0, 8);
  const live = desk.routines.filter((row) => row.status === 'live');
  const retired = desk.routines.filter((row) => row.status === 'retired');
  return (
    <div className="term-grid term-grid-home">
      <section className="term-panel term-panel-span">
        <header>
          <b>AGENTIC BOOK</b>
          <span>proof account · canonical snapshots</span>
        </header>
        <BookStrip book={desk.book} />
      </section>
      <section className="term-panel">
        <header><b>THESES</b><span>{desk.theses.length}</span></header>
        <table>
          <thead><tr><th>Id</th><th>St</th><th>Conf</th><th>Stance</th></tr></thead>
          <tbody>
            {desk.theses.map((row) => (
              <tr
                key={row.id}
                className={row.id === selectedThesisId ? 'sel' : ''}
                onClick={() => onThesis(row.id)}
              >
                <td className="sym">{row.id}</td>
                <td className={toneForStatus(row.status)}>{row.status}</td>
                <td>{row.confidence}</td>
                <td>{row.stance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="term-panel">
        <header><b>TAPE</b><span>runs + evidence</span></header>
        {desk.runs.slice(0, 6).map((run) => (
          <div key={run.id} className="term-line">
            <b className={toneForStatus(run.parsed.outcome)}>{run.parsed.outcome}</b>
            <span>{run.run_type}</span>
            <i>{age(run.started_at, now)}</i>
            <p>{run.parsed.summary.slice(0, 140)}</p>
          </div>
        ))}
        {latestEvidence.map((row) => (
          <div key={`ev-${row.id}`} className="term-line">
            <b className={toneForStatus(row.direction)}>{row.thesis_id}</b>
            <span>{row.evidence_type}</span>
            <p>{row.summary.slice(0, 140)}</p>
          </div>
        ))}
      </section>
      <section className="term-panel">
        <header><b>QUANTANAMO</b><span>Grok Bot routines</span></header>
        {live.map((row) => (
          <RoutineLine key={row.id} row={row} now={now} />
        ))}
        <header><b>RETIRED</b><span>Cloudflare / ThesisForge / Codex</span></header>
        {retired.map((row) => (
          <RoutineLine key={row.id} row={row} now={now} />
        ))}
        <header><b>QUEUE</b><span>{desk.counts.open_research} open</span></header>
        {desk.queue.filter((row) => row.status === 'open').slice(0, 6).map((row) => (
          <div key={row.id} className="term-line">
            <b>{row.priority}</b>
            <span>{row.topic}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function RoutineLine({ row, now }: { row: DeskRoutine; now: number | null }) {
  return (
    <div className="term-line">
      <b className={row.status === 'live' ? 'up' : 'muted'}>{row.status}</b>
      <span>{row.name}</span>
      <i>{row.last_run_at ? age(row.last_run_at, now) : 'no run in ledger'}</i>
      <p>{row.cadence}{row.last_summary ? ` · ${row.last_summary.slice(0, 120)}` : ''}</p>
    </div>
  );
}

function BookPanel({ desk }: { desk: DeskPayload }) {
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header>
          <b>LIVE BOOK</b>
          <span>{desk.book.account_label || 'no snapshot'} · {nyStamp(desk.book.observed_at)}</span>
        </header>
        <BookStrip book={desk.book} />
        <header><b>EPISODES</b></header>
        <table>
          <thead><tr><th>Symbol</th><th>Qty</th><th>Avg cost</th><th>Opened</th><th>Status</th></tr></thead>
          <tbody>
            {desk.positions.map((row) => (
              <tr key={row.id}>
                <td className="sym">{row.symbol}</td>
                <td>{qty(row.quantity)}</td>
                <td>{ledgerFigure(row.average_cost, moneyPrecise)}</td>
                <td>{nyStamp(row.opened_at)}</td>
                <td className={toneForStatus(row.status)}>{row.status}</td>
              </tr>
            ))}
            {!desk.positions.length && <tr><td colSpan={5} className="empty">No open episodes</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="term-panel">
        <header><b>INTENTS / PROPOSALS</b></header>
        {desk.intents.map((row) => (
          <div key={row.id} className="term-line">
            <b className="sym">{row.symbol}</b>
            <span>{row.side} {row.mode} {money(row.notional)} · {qty(row.quantity)}</span>
            <i className={toneForStatus(row.status)}>{row.status}</i>
            <p>{row.order_type} {row.broker_order_id || ''}</p>
          </div>
        ))}
        {desk.proposals.slice(0, 8).map((row) => (
          <div key={`p-${row.id}`} className="term-line">
            <b>{row.symbol}</b>
            <span>{row.side} {money(row.notional)}</span>
            <i>{row.status}</i>
            <p>{row.rationale.slice(0, 180)}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

function ThesesPanel({
  desk,
  selected,
  busy,
  onSelect,
  onMutate,
}: {
  desk: DeskPayload;
  selected?: ThesisRow;
  busy: boolean;
  onSelect: (id: string) => void;
  onMutate: (label: string, work: () => Promise<void>) => Promise<void>;
}) {
  const evidence = desk.evidence.filter((row) => row.thesis_id === selected?.id).slice(0, 12);
  const scores = desk.scores.filter((row) => row.thesis_id === selected?.id).slice(0, 24).reverse();
  const [summary, setSummary] = useState('');
  const [direction, setDirection] = useState<'supporting' | 'challenging' | 'neutral'>('supporting');

  return (
    <div className="term-grid term-grid-theses">
      <section className="term-panel">
        <header><b>THESES</b><span>j/k · enter</span></header>
        <table>
          <thead><tr><th>Id</th><th>Status</th><th>C</th><th>Stance</th><th>Symbols</th></tr></thead>
          <tbody>
            {desk.theses.map((row) => (
              <tr key={row.id} className={row.id === selected?.id ? 'sel' : ''} onClick={() => onSelect(row.id)}>
                <td className="sym">{row.id}</td>
                <td className={toneForStatus(row.status)}>{row.status}</td>
                <td>{row.confidence}</td>
                <td>{row.stance}</td>
                <td>{row.symbols.slice(0, 4).join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
            <div className="term-actions">
              {THESIS_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  className={selected.status === status ? 'on' : ''}
                  disabled={busy}
                  onClick={() => void onMutate(`Status → ${status}`, async () => {
                    await postJson('/api/ledger/thesis', { thesis_id: selected.id, status });
                  })}
                >
                  {status}
                </button>
              ))}
            </div>
            <form
              className="term-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!summary.trim()) return;
                void onMutate('Evidence appended', async () => {
                  await postJson('/api/ledger/evidence', {
                    thesis_id: selected.id,
                    evidence_type: 'operator_note',
                    direction,
                    summary,
                    confidence: selected.confidence,
                  });
                  setSummary('');
                });
              }}
            >
              <select
                value={direction}
                onChange={(event) => {
                  const parsed = DirectionSchema.safeParse(event.target.value);
                  if (parsed.success) setDirection(parsed.data);
                }}
              >
                <option value="supporting">supporting</option>
                <option value="challenging">challenging</option>
                <option value="neutral">neutral</option>
              </select>
              <input
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                placeholder="Append evidence to this thesis"
              />
              <button type="submit" disabled={busy || !summary.trim()}>Add</button>
            </form>
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

function RunsPanel({ desk, now }: { desk: DeskPayload; now: number | null }) {
  const live = desk.routines.filter((row) => row.status === 'live');
  const retired = desk.routines.filter((row) => row.status === 'retired');
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>RUNS</b><span>{desk.runs.length}</span></header>
        {desk.runs.map((run) => (
          <div key={run.id} className="term-line">
            <b className={toneForStatus(run.parsed.outcome)}>{run.parsed.outcome}</b>
            <span>{run.run_type} · {run.parsed.headline}</span>
            <i>{nyStamp(run.started_at)}</i>
            <p>{run.parsed.summary}</p>
          </div>
        ))}
      </section>
      <section className="term-panel">
        <header><b>QUANTANAMO ROUTINES</b><span>last run from ledger</span></header>
        {live.map((row) => (
          <RoutineLine key={row.id} row={row} now={now} />
        ))}
        <header><b>RETIRED</b><span>not due</span></header>
        {retired.map((row) => (
          <RoutineLine key={row.id} row={row} now={now} />
        ))}
        {desk.cloud_runs.slice(0, 8).map((run) => (
          <div key={run.id} className="term-line">
            <b className="muted">{run.status}</b>
            <span>retired cloud {run.trigger_source} {run.market_slot || ''} {run.mode}</span>
            <i>{nyStamp(run.started_at || run.scheduled_for)}</i>
            {run.error_text && <p className="dim">{run.error_text}</p>}
          </div>
        ))}
      </section>
    </div>
  );
}

function BacktestsPanel({ desk }: { desk: DeskPayload }) {
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>CYCLES</b></header>
        {desk.cycles.map((cycle) => (
          <div key={cycle.id} className="term-line">
            <b>{cycle.thesis_id}</b>
            <span>{cycle.stage} · {cycle.status} · {cycle.market_regime}</span>
            <p>{cycle.hypothesis}</p>
            <p className="dim">Preregistered: {cycle.preregistered_outcome}</p>
          </div>
        ))}
      </section>
      <section className="term-panel">
        <header><b>STRATEGY TESTS</b><span>{desk.counts.tests_survived} survived / {desk.counts.tests_killed} killed</span></header>
        <table>
          <thead><tr><th>Variant</th><th>Status</th><th>Ret</th><th>DD</th><th>dSharpe</th></tr></thead>
          <tbody>
            {desk.tests.map((row) => (
              <tr key={row.id}>
                <td>{row.variant_label}</td>
                <td className={toneForStatus(row.status)}>{row.status}</td>
                <td className={row.total_return !== null && row.total_return < 0 ? 'down' : 'up'}>{pct(row.total_return)}</td>
                <td className="down">{pct(row.max_drawdown)}</td>
                <td>{row.deflated_sharpe?.toFixed(2) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <header><b>SCENARIOS</b><span>{desk.counts.scenario_cells}</span></header>
        {desk.scenarios.slice(0, 18).map((row) => (
          <div key={row.id} className="term-line">
            <b className={toneForStatus(row.outcome)}>{row.outcome}</b>
            <span>{row.scenario_key} · {row.market_regime} · {row.cost_multiplier}x</span>
            <i>{pct(row.metric_value)}</i>
          </div>
        ))}
      </section>
    </div>
  );
}

function CatalystsPanel({ desk }: { desk: DeskPayload }) {
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>CATALYSTS</b></header>
        {desk.catalysts.map((row) => (
          <div key={row.id} className="term-line">
            <b className="sym">{row.symbol || '—'}</b>
            <span>{row.catalyst_type} · {row.event_date || 'undated'} · {row.thesis_id}</span>
            <i className={toneForStatus(row.status)}>{row.status}</i>
            <p>{row.summary}</p>
          </div>
        ))}
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
      </section>
    </div>
  );
}

function LearningsPanel({
  desk,
  busy,
  onMutate,
}: {
  desk: DeskPayload;
  busy: boolean;
  onMutate: (label: string, work: () => Promise<void>) => Promise<void>;
}) {
  const [thesisId, setThesisId] = useState(desk.theses[0]?.id ?? '');
  const [lesson, setLesson] = useState('');
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>LESSONS</b><span>{desk.lessons.filter((row) => !row.incorporated).length} open loops</span></header>
        {desk.lessons.map((row) => (
          <div key={row.id} className="term-line">
            <b>{row.lesson_type}</b>
            <span>{row.thesis_id} · {row.market_regime}</span>
            <i className={row.incorporated ? 'up' : 'warn'}>{row.incorporated ? 'in model' : 'pending'}</i>
            <p>{row.summary}</p>
          </div>
        ))}
        <form
          className="term-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!lesson.trim() || !thesisId) return;
            void onMutate('Lesson recorded', async () => {
              await postJson('/api/ledger/lesson', {
                thesis_id: thesisId,
                lesson_type: 'operator_note',
                summary: lesson,
                market_regime: 'live_desk',
              });
              setLesson('');
            });
          }}
        >
          <select value={thesisId} onChange={(event) => setThesisId(event.target.value)}>
            {desk.theses.map((row) => (
              <option key={row.id} value={row.id}>{row.id}</option>
            ))}
          </select>
          <input value={lesson} onChange={(event) => setLesson(event.target.value)} placeholder="Append a lesson" />
          <button type="submit" disabled={busy || !lesson.trim()}>Add</button>
        </form>
      </section>
      <section className="term-panel">
        <header><b>POSTMORTEMS / INSIGHTS</b></header>
        {desk.postmortems.map((row) => (
          <div key={row.id} className="term-line">
            <b>{row.outcome}</b>
            <span>{row.thesis_id || 'unlinked'}</span>
            <p>{row.lesson}</p>
          </div>
        ))}
        {desk.insights.map((row) => (
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

function OntologyPanel({ desk }: { desk: DeskPayload }) {
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>THEMES</b></header>
        {desk.ontology_themes.map((row) => (
          <div key={row.id} className="term-line">
            <b>{row.name}</b>
            <span>{row.kind} · {row.id}</span>
            <i className={toneForStatus(row.status)}>{row.status}</i>
            <p>{row.description}</p>
          </div>
        ))}
      </section>
      <section className="term-panel">
        <header><b>CANDIDATES</b></header>
        {desk.ontology_candidates.slice(0, 30).map((row) => (
          <div key={row.id} className="term-line">
            <b>{row.proposed_label}</b>
            <span>{row.candidate_type} · {row.source_count} src</span>
            <i>{row.score}</i>
          </div>
        ))}
      </section>
    </div>
  );
}

function RiskPanel({ desk }: { desk: DeskPayload }) {
  return (
    <section className="term-panel">
      <header><b>RISK CONTROLS</b></header>
      {desk.risk_controls.map((row) => (
        <div key={row.id} className="term-line">
          <b>{titleCase(row.control_type)}</b>
          <span>{row.scope} · {row.enforcement_level}</span>
          <i className={toneForStatus(row.status)}>{row.status}</i>
          <p>{row.threshold_json}</p>
        </div>
      ))}
    </section>
  );
}

type MutationBody =
  | { thesis_id: string; status: string }
  | {
      thesis_id: string;
      evidence_type: string;
      direction: string;
      summary: string;
      confidence: number;
    }
  | { thesis_id: string; lesson_type: string; summary: string; market_regime: string };

async function postJson(url: string, body: MutationBody): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsedBody = await response.json().catch(() => null);
  const ErrorSchema = z.object({ error: z.string() }).passthrough();
  if (!response.ok) {
    throw new Error(ErrorSchema.safeParse(parsedBody).data?.error || `Request failed (${response.status})`);
  }
}
