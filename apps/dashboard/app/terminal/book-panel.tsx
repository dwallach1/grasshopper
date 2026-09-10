'use client';

import { useMemo } from 'react';

import {
  asciiFillBar,
  asciiRangeBar,
  assembleBookEdge,
  formatEdgeAmount,
  formatHold,
  type StewardEdge,
} from '../../lib/book-edge-stats';
import { assembleBookOpen } from '../../lib/book-open-strip';
import { assembleDeskBookHealth } from '../../lib/desk-book-health';
import { assembleStewardFreshness, type StewardFreshness } from '../../lib/desk-freshness';
import { QUIET_STEWARD_FACE, stewardDeskFaces, type StewardFace } from '../../lib/steward-face';
import type { DeskPayload } from '../../lib/ledger-types';
import { BookOpenStrip } from './book-open-strip';
import { age } from './format';
import { StewardAvatar } from './steward-avatar';

export function BookPanel({
  desk,
  nowIso,
}: {
  desk: DeskPayload;
  nowIso?: string;
}) {
  const edge = useMemo(() => assembleBookEdge(desk), [desk]);
  const open = useMemo(() => assembleBookOpen(desk), [desk]);
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const faces = useMemo(
    () => stewardDeskFaces(desk, nowMs),
    [desk, nowMs],
  );
  const marks = useMemo(() => assembleStewardFreshness(desk), [desk]);
  const health = useMemo(() => assembleDeskBookHealth(desk, nowMs), [desk, nowMs]);

  return (
    <div className="line-stage crt-book">
      <h1 className="visually-hidden">Book</h1>
      <header className="crt-book-mast">
        <p className="crt-book-kicker">BOOK // EDGE</p>
        <p className="crt-book-lede">
          Closed lots only. Native units. Missing exits stay unmarked.
        </p>
      </header>

      <BookHealthStrip health={health} now={nowIso ? Date.parse(nowIso) : null} />
      <BookOpenStrip open={open} now={nowIso ? Date.parse(nowIso) : null} />

      <div className="crt-book-stack">
        {edge.rows.map((row) => (
          <StewardEdgeCard
            key={row.id}
            row={row}
            face={faces.get(row.slug)}
            freshness={marks.find((item) => item.id === row.id)}
            now={nowIso ? Date.parse(nowIso) : null}
          />
        ))}
      </div>
    </div>
  );
}

function BookHealthStrip({
  health,
  now,
}: {
  health: ReturnType<typeof assembleDeskBookHealth>;
  now: number | null;
}) {
  if (health.alerts.length === 0) return null;
  return (
    <section className="book-health" aria-label="Book health">
      <p className="book-open-kicker">HEALTH</p>
      <ul className="book-health-alerts">
        {health.alerts.map((alert) => (
          <li key={alert.id}>
            {alert.steward === 'oddsborne' ? 'ODD' : 'BND'} {alert.label}
            {' · '}
            {alert.detail}
            {' · '}
            {age(alert.at ?? undefined, now)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StewardEdgeCard({
  row,
  face = QUIET_STEWARD_FACE,
  freshness,
  now,
}: {
  row: StewardEdge;
  face?: StewardFace;
  freshness?: StewardFreshness;
  now: number | null;
}) {
  const markAge = age(freshness?.mark_at ?? undefined, now);
  return (
    <article
      className={`crt-book-card${row.thin ? ' is-thin' : ''}`}
      aria-label={`${row.steward} edge · marks ${markAge}`}
    >
      <header className="crt-book-who">
        <StewardAvatar
          slug={row.slug}
          name={row.steward}
          size="board"
          accent={row.accent}
          {...face}
        />
        <div className="crt-book-id">
          <b>{row.steward}</b>
          <i>{row.venue_label} · {row.unit} · marks {markAge}</i>
        </div>
      </header>

      <div className="crt-book-tube crt-scan">
        <span className="crt-boot-corner crt-boot-corner-tl" aria-hidden="true" />
        <span className="crt-boot-corner crt-boot-corner-tr" aria-hidden="true" />
        <span className="crt-boot-corner crt-boot-corner-bl" aria-hidden="true" />
        <span className="crt-boot-corner crt-boot-corner-br" aria-hidden="true" />
        <pre className="crt-book-readout" aria-hidden="true">
          {readout(row)}
        </pre>
        <dl className="visually-hidden">
          <dt>Win rate</dt>
          <dd>{row.win_rate === null ? row.note : `${row.win_rate.toFixed(1)}%`}</dd>
          <dt>Good</dt>
          <dd>{row.wins}</dd>
          <dt>Bad</dt>
          <dd>{row.losses}</dd>
          <dt>Size</dt>
          <dd>{row.size ? `${formatEdgeAmount(row.size.avg, row.unit)} avg` : row.note}</dd>
          <dt>Hold</dt>
          <dd>{row.hold ? formatHold(row.hold.avg) : row.note}</dd>
        </dl>
      </div>
    </article>
  );
}

function readout(row: StewardEdge): string {
  const width = 34;
  const title = clip(`${row.steward} · ${row.unit}`, width - 6);
  const foot = clip(row.note, width - 6);
  const lines = [
    `┌ ${title} ${'─'.repeat(Math.max(1, width - title.length - 5))}┐`,
  ];

  if (row.closed === 0) {
    lines.push(box('WIN  ░░░░░░░░░░░░░░░░   —', width));
    lines.push(box('GOOD 0   BAD 0   n=0', width));
    lines.push(box('', width));
    lines.push(box('no closed lots', width));
    lines.push(box('not in ledger', width));
    lines.push(`└ ${foot} ${'─'.repeat(Math.max(1, width - foot.length - 5))}┘`);
    return lines.join('\n');
  }

  const rate = row.win_rate === null ? '  — ' : `${row.win_rate.toFixed(1).padStart(5)}%`;
  lines.push(box(`WIN  ${asciiFillBar(row.win_rate, 16)} ${rate}`, width));
  lines.push(box(`GOOD ${row.wins}   BAD ${row.losses}   n=${row.closed}`, width));
  lines.push(box('', width));
  lines.push(box('SIZE', width));
  if (row.size) {
    lines.push(box(`AVG ${formatEdgeAmount(row.size.avg, row.unit)}`, width));
    lines.push(box(`MIN ${formatEdgeAmount(row.size.min, row.unit)}  MAX ${formatEdgeAmount(row.size.max, row.unit)}`, width));
    lines.push(box(`STD ${row.size.std === null ? '—' : formatEdgeAmount(row.size.std, row.unit)}`, width));
    lines.push(box(asciiRangeBar(row.size.min, row.size.avg, row.size.max, 16), width));
  } else {
    lines.push(box('size not in ledger', width));
  }
  lines.push(box('', width));
  lines.push(box('HOLD', width));
  if (row.hold) {
    lines.push(box(`AVG ${formatHold(row.hold.avg)}`, width));
    lines.push(box(`MIN ${formatHold(row.hold.min)}  MAX ${formatHold(row.hold.max)}`, width));
    lines.push(box(`STD ${formatHold(row.hold.std)}`, width));
    lines.push(box(asciiRangeBar(row.hold.min, row.hold.avg, row.hold.max, 16), width));
  } else {
    lines.push(box('hold not in ledger', width));
  }
  lines.push(`└ ${foot} ${'─'.repeat(Math.max(1, width - foot.length - 5))}┘`);
  return lines.join('\n');
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function box(inner: string, width: number): string {
  const room = width - 4;
  const text = inner.length > room ? inner.slice(0, room) : inner.padEnd(room, ' ');
  return `│ ${text} │`;
}
