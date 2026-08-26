'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import type { DeskPayload, ThesisRow } from '../../lib/ledger-types';
import { THESIS_STATUSES } from '../../lib/thesis-status';
import { SessionControls } from './session-controls';
import { age, money, moneyPrecise, nyStamp, pct, qty, titleCase, toneForStatus, until } from './format';

const POLL_MS = 15_000;

const NAV = [
  { href: '/', id: 'monitor', key: '1', label: 'MON' },
  { href: '/book', id: 'book', key: '2', label: 'BOOK' },
  { href: '/theses', id: 'theses', key: '3', label: 'THES' },
  { href: '/runs', id: 'runs', key: '4', label: 'RUNS' },
  { href: '/backtests', id: 'backtests', key: '5', label: 'TEST' },
  { href: '/catalysts', id: 'catalysts', key: '6', label: 'CAT' },
  { href: '/learnings', id: 'learnings', key: '7', label: 'LRN' },
] as const;

const EXTRA = [
  { href: '/ontology', id: 'ontology', label: 'ONT' },
  { href: '/risk', id: 'risk', label: 'RISK' },
] as const;

const ErrorSchema = z.object({ error: z.string() }).passthrough();
const DirectionSchema = z.enum(['supporting', 'challenging', 'neutral']);

const DeskWireSchema = z
  .object({
    generated_at: z.string().min(1),
    source: z.enum(['postgres', 'postgrest']),
    theses: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
  })
  .passthrough();

function surfaceFromPath(pathname: string): string {
  if (pathname === '/') return 'monitor';
  return pathname.replace(/^\//, '').split('/')[0] || 'monitor';
}

function needsXReauthorization(text: string): boolean {
  return /x token|reauthorization is required|x credential vault/i.test(text);
}

function deskNeedsXReauthorization(desk: DeskPayload): boolean {
  return desk.runs.some((run) => (
    run.parsed.outcome === 'failed'
    && needsXReauthorization(`${run.parsed.error || ''} ${run.parsed.summary}`)
  )) || desk.cloud_runs.some((run) => (
    (run.status === 'failed' || run.status === 'error')
    && needsXReauthorization(`${run.error_text || ''} ${run.summary}`)
  ));
}

export function TerminalApp({ initial, operatorEmail }: { initial: DeskPayload; operatorEmail: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const surface = surfaceFromPath(pathname);
  const [desk, setDesk] = useState(initial);
  const [now, setNow] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedThesisId, setSelectedThesisId] = useState(initial.theses[0]?.id ?? '');
  const [goArmed, setGoArmed] = useState(false);

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
        if (event.key === 'b') router.push('/book');
        else if (event.key === 't') router.push('/theses');
        else if (event.key === 'r') router.push('/runs');
        else if (event.key === 'k') router.push('/backtests');
        else if (event.key === 'c') router.push('/catalysts');
        else if (event.key === 'l') router.push('/learnings');
        else if (event.key === 'm' || event.key === 'h') router.push('/');
        return;
      }
      if (event.key === 'g') {
        setGoArmed(true);
        return;
      }
      const nav = NAV.find((item) => item.key === event.key);
      if (nav) {
        event.preventDefault();
        router.push(nav.href);
        return;
      }
      if (event.key === 'r') {
        event.preventDefault();
        void refreshDesk(setDesk, setNotice);
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        document.getElementById('term-search')?.focus();
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
      if (event.key === 'Enter' && surface !== 'theses') router.push('/theses');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desk.theses, goArmed, router, selectedThesisId, surface]);

  const selectedThesis = desk.theses.find((row) => row.id === selectedThesisId) ?? desk.theses[0];
  const nextFire = desk.schedule[0];
  const xAuthBroken = deskNeedsXReauthorization(desk);

  return (
    <div className="term">
      <header className="term-top">
        <Link className="term-brand" href="/">QUANTANAMO</Link>
        <nav className="term-nav" aria-label="Terminal">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={surface === item.id ? 'on' : ''}>
              <kbd>{item.key}</kbd>
              {item.label}
            </Link>
          ))}
          {EXTRA.map((item) => (
            <Link key={item.href} href={item.href} className={surface === item.id ? 'on' : ''}>
              {item.label}
            </Link>
          ))}
        </nav>
        <input
          id="term-search"
          className="term-search"
          placeholder="/ filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="term-live">
          <i className={age(desk.generated_at, now) === 'n/a' ? 'stale' : 'live'} />
          {desk.source} · {age(desk.generated_at, now)}
        </div>
        <SessionControls email={operatorEmail} />
      </header>
      {notice && <div className="term-banner" role="status">{notice}</div>}
      {xAuthBroken && (
        <div className="term-banner" role="alert">
          X bookmark access expired.{' '}
          <a href="/api/x/authorize">Reconnect X</a>
          {' '}then press Run on the knowledge pipeline.
        </div>
      )}
      <main className="term-main">
        {surface === 'monitor' && (
          <MonitorPanel
            desk={desk}
            now={now}
            selectedThesisId={selectedThesis?.id}
            onThesis={setSelectedThesisId}
          />
        )}
        {surface === 'book' && <BookPanel desk={desk} query={query} />}
        {surface === 'theses' && (
          <ThesesPanel
            desk={desk}
            query={query}
            selected={selectedThesis}
            busy={busy}
            onSelect={setSelectedThesisId}
            onMutate={async (label, work) => {
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
            }}
          />
        )}
        {surface === 'runs' && <RunsPanel desk={desk} now={now} query={query} />}
        {surface === 'backtests' && <BacktestsPanel desk={desk} query={query} />}
        {surface === 'catalysts' && <CatalystsPanel desk={desk} query={query} />}
        {surface === 'learnings' && (
          <LearningsPanel
            desk={desk}
            query={query}
            busy={busy}
            onMutate={async (label, work) => {
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
            }}
          />
        )}
        {surface === 'ontology' && <OntologyPanel desk={desk} query={query} />}
        {surface === 'risk' && <RiskPanel desk={desk} />}
      </main>
      <footer className="term-status">
        <span>NAV {moneyPrecise(desk.account?.total_value)}</span>
        <span>CASH {money(desk.account?.cash)}</span>
        <span>BP {money(desk.account?.buying_power)}</span>
        <span>POS {desk.counts.open_positions}</span>
        <span>Q {desk.counts.open_research}</span>
        <span>NEXT {nextFire ? `${nextFire.name} ${until(nextFire.at, now ?? 0)}` : '—'}</span>
        <span className="term-kbd">1-7 panels · g then b/t/r/c/l · j/k thesis · r refresh · / filter · ? help</span>
      </footer>
      {help && (
        <aside className="term-help">
          <b>Keyboard</b>
          <p>1 MON · 2 BOOK · 3 THES · 4 RUNS · 5 TEST · 6 CAT · 7 LRN</p>
          <p>g b book · g t theses · g r runs · g c catalysts · g l learnings</p>
          <p>j/k move thesis · Enter open theses · r reload ledger · Esc close</p>
        </aside>
      )}
    </div>
  );
}

async function refreshDesk(
  setDesk: (desk: DeskPayload) => void,
  setNotice: (value: string | null) => void,
): Promise<void> {
  const response = await fetch('/api/ledger', { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) {
    setNotice(ErrorSchema.safeParse(body).data?.error || 'Ledger refresh failed');
    return;
  }
  const parsed = DeskWireSchema.safeParse(body);
  if (!parsed.success) {
    setNotice('Ledger payload failed schema checks');
    return;
  }
  // SAFETY: /api/ledger serializes the DeskPayload assembled by loadDesk(); DeskWireSchema verified the envelope.
  setDesk(parsed.data as DeskPayload);
  setNotice(null);
}

function MonitorPanel({
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
  return (
    <div className="term-grid term-grid-monitor">
      <section className="term-panel">
        <header><b>BOOK</b><span>{desk.positions.length} open</span></header>
        <table>
          <thead><tr><th>Sym</th><th>Qty</th><th>Avg</th><th>Status</th></tr></thead>
          <tbody>
            {desk.positions.map((row) => (
              <tr key={row.id}>
                <td className="sym">{row.symbol}</td>
                <td>{qty(row.quantity)}</td>
                <td>{moneyPrecise(row.average_cost)}</td>
                <td className={toneForStatus(row.status)}>{row.status}</td>
              </tr>
            ))}
            {!desk.positions.length && <tr><td colSpan={4} className="empty">No open episodes</td></tr>}
          </tbody>
        </table>
        <div className="term-sub">
          {desk.intents.slice(0, 4).map((intent) => (
            <div key={intent.id} className="term-line">
              <b className={toneForStatus(intent.status)}>{intent.symbol}</b>
              <span>{intent.side} {intent.mode} {money(intent.notional)}</span>
              <i>{intent.status}</i>
            </div>
          ))}
        </div>
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
        <header><b>NEXT</b></header>
        {desk.schedule.slice(0, 6).map((slot) => (
          <div key={`${slot.source}-${slot.id}-${slot.at}`} className="term-line">
            <b>{until(slot.at, now ?? 0)}</b>
            <span>{slot.name}</span>
            <i>{slot.source}</i>
          </div>
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

function BookPanel({ desk, query }: { desk: DeskPayload; query: string }) {
  const q = query.toLowerCase();
  const positions = desk.positions.filter((row) => row.symbol.toLowerCase().includes(q));
  const intents = desk.intents.filter((row) => `${row.symbol} ${row.status}`.toLowerCase().includes(q));
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header>
          <b>LIVE BOOK</b>
          <span>{desk.account?.account_label || 'no snapshot'} · {nyStamp(desk.account?.observed_at)}</span>
        </header>
        <div className="term-kpis">
          <div><i>NAV</i><b>{moneyPrecise(desk.account?.total_value)}</b></div>
          <div><i>Equity</i><b>{moneyPrecise(desk.account?.equity_value)}</b></div>
          <div><i>Cash</i><b>{moneyPrecise(desk.account?.cash)}</b></div>
          <div><i>BP</i><b>{moneyPrecise(desk.account?.buying_power)}</b></div>
        </div>
        <table>
          <thead><tr><th>Symbol</th><th>Qty</th><th>Avg cost</th><th>Opened</th><th>Status</th></tr></thead>
          <tbody>
            {positions.map((row) => (
              <tr key={row.id}>
                <td className="sym">{row.symbol}</td>
                <td>{qty(row.quantity)}</td>
                <td>{moneyPrecise(row.average_cost)}</td>
                <td>{nyStamp(row.opened_at)}</td>
                <td className={toneForStatus(row.status)}>{row.status}</td>
              </tr>
            ))}
            {!positions.length && <tr><td colSpan={5} className="empty">No positions match</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="term-panel">
        <header><b>INTENTS / PROPOSALS</b></header>
        {intents.map((row) => (
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
  query,
  selected,
  busy,
  onSelect,
  onMutate,
}: {
  desk: DeskPayload;
  query: string;
  selected?: ThesisRow;
  busy: boolean;
  onSelect: (id: string) => void;
  onMutate: (label: string, work: () => Promise<void>) => Promise<void>;
}) {
  const q = query.toLowerCase();
  const rows = desk.theses.filter((row) =>
    `${row.id} ${row.name} ${row.status} ${row.symbols.join(' ')}`.toLowerCase().includes(q),
  );
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
            {rows.map((row) => (
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

function RunsPanel({ desk, now, query }: { desk: DeskPayload; now: number | null; query: string }) {
  const q = query.toLowerCase();
  const runs = desk.runs.filter((row) => `${row.run_type} ${row.parsed.summary}`.toLowerCase().includes(q));
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>RUNS</b><span>{runs.length}</span></header>
        {runs.map((run) => (
          <div key={run.id} className="term-line">
            <b className={toneForStatus(run.parsed.outcome)}>{run.parsed.outcome}</b>
            <span>{run.run_type} · {run.parsed.headline}</span>
            <i>{nyStamp(run.started_at)}</i>
            <p>{run.parsed.summary}</p>
            {run.parsed.outcome === 'failed' && needsXReauthorization(`${run.parsed.error || ''} ${run.parsed.summary}`) && (
              <p><a href="/api/x/authorize">Reconnect X</a></p>
            )}
          </div>
        ))}
      </section>
      <section className="term-panel">
        <header><b>CLOUD</b><span>{desk.counts.queued_tasks} queued tasks</span></header>
        {desk.schedule.map((slot) => (
          <div key={`${slot.source}-${slot.id}-${slot.at}`} className="term-line">
            <b>{until(slot.at, now ?? 0)}</b>
            <span>{slot.name}</span>
            <i>{slot.source}</i>
          </div>
        ))}
        {desk.cloud_runs.slice(0, 12).map((run) => (
          <div key={run.id} className="term-line">
            <b className={toneForStatus(run.status)}>{run.status}</b>
            <span>{run.trigger_source} {run.market_slot || ''} {run.mode}</span>
            <i>{nyStamp(run.started_at || run.scheduled_for)}</i>
            {run.error_text && <p className="down">{run.error_text}</p>}
          </div>
        ))}
        {desk.cloud_tasks.filter((task) => task.status === 'queued' || task.status === 'running').map((task) => (
          <div key={task.id} className="term-line">
            <b className="warn">{task.status}</b>
            <span>{task.task_type} {task.entity_key || ''}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function BacktestsPanel({ desk, query }: { desk: DeskPayload; query: string }) {
  const q = query.toLowerCase();
  const tests = desk.tests.filter((row) => row.variant_label.toLowerCase().includes(q) || row.status.includes(q));
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
            {tests.map((row) => (
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

function CatalystsPanel({ desk, query }: { desk: DeskPayload; query: string }) {
  const q = query.toLowerCase();
  const catalysts = desk.catalysts.filter((row) =>
    `${row.symbol} ${row.summary} ${row.thesis_id}`.toLowerCase().includes(q),
  );
  const queue = desk.queue.filter((row) => `${row.topic} ${row.reason}`.toLowerCase().includes(q));
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>CATALYSTS</b></header>
        {catalysts.map((row) => (
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
        {queue.map((row) => (
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
  query,
  busy,
  onMutate,
}: {
  desk: DeskPayload;
  query: string;
  busy: boolean;
  onMutate: (label: string, work: () => Promise<void>) => Promise<void>;
}) {
  const q = query.toLowerCase();
  const [thesisId, setThesisId] = useState(desk.theses[0]?.id ?? '');
  const [lesson, setLesson] = useState('');
  const lessons = desk.lessons.filter((row) => row.summary.toLowerCase().includes(q));
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>LESSONS</b><span>{desk.lessons.filter((row) => !row.incorporated).length} open loops</span></header>
        {lessons.map((row) => (
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

function OntologyPanel({ desk, query }: { desk: DeskPayload; query: string }) {
  const q = query.toLowerCase();
  const themes = desk.ontology_themes.filter((row) => `${row.name} ${row.id}`.toLowerCase().includes(q));
  return (
    <div className="term-grid term-grid-2">
      <section className="term-panel">
        <header><b>THEMES</b></header>
        {themes.map((row) => (
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
  if (!response.ok) {
    throw new Error(ErrorSchema.safeParse(parsedBody).data?.error || `Request failed (${response.status})`);
  }
}
