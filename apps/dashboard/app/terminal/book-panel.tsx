'use client';

import { useMemo } from 'react';

import { assembleBookHoldings } from '../../lib/book-holdings';
import { assembleBookOpen } from '../../lib/book-open-strip';
import { assembleDeskBookHealth } from '../../lib/desk-book-health';
import { stewardDeskFaces } from '../../lib/steward-face';
import type { DeskPayload } from '../../lib/ledger-types';
import { BookOpenStrip } from './book-open-strip';
import { age } from './format';

export function BookPanel({
  desk,
  nowIso,
}: {
  desk: DeskPayload;
  nowIso?: string;
}) {
  const open = useMemo(() => assembleBookOpen(desk), [desk]);
  const holdings = useMemo(() => assembleBookHoldings(desk), [desk]);
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const faces = useMemo(
    () => stewardDeskFaces(desk, nowMs),
    [desk, nowMs],
  );
  const health = useMemo(() => assembleDeskBookHealth(desk, nowMs), [desk, nowMs]);

  return (
    <div className="line-stage crt-book">
      <h1 className="visually-hidden">Book</h1>
      <header className="crt-book-mast">
        <p className="crt-book-kicker paper-title">Book</p>
        <p className="crt-book-lede">
          Open and closed names in the table. Native units. Missing marks stay unmarked.
        </p>
      </header>

      <BookOpenStrip
        open={open}
        holdings={holdings.rows}
        faces={faces}
        now={nowIso ? Date.parse(nowIso) : null}
      />
      <BookHealthStrip health={health} now={nowIso ? Date.parse(nowIso) : null} />
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
