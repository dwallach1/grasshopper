'use client';

import { useMemo, useState } from 'react';

import { allocationSlices, bookSlabs, type AllocSlice } from '../../lib/book-slabs';
import { navPathSeries, type NavWindowId } from '../../lib/book-nav-path';
import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { DeskPayload } from '../../lib/ledger-types';
import { BookLotTiles } from './book-lot-tiles';
import { BookNavPath } from './book-nav-path';
import { ledgerFigure, moneyPrecise, nyStamp, pnlClass, signedMoney } from './format';

export function BookDiagnostic({
  desk,
  selectedId,
  onSelect,
}: {
  desk: DeskPayload;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [windowId, setWindowId] = useState<NavWindowId>('all');
  const slabs = useMemo(() => bookSlabs(desk.book), [desk.book]);
  const points = useMemo(
    () => navPathSeries({
      snapshotsNewestFirst: desk.snapshots,
      window: windowId,
      latestObservedAt: desk.book.observed_at,
    }),
    [desk.book.observed_at, desk.snapshots, windowId],
  );
  const slices = useMemo(
    () => allocationSlices(slabs, desk.book.current_nav),
    [desk.book.current_nav, slabs],
  );

  return (
    <section className="term-panel term-book-viz">
      <header>
        <b>BOOK DIAGNOSTIC</b>
        <span>lot tiles · live NAV path · leftover cash · table stays canonical</span>
      </header>
      <BookLotTiles slabs={slabs} selectedId={selectedId} onSelect={onSelect} />
      <BookNavPath
        points={points}
        value={desk.book.current_nav}
        startingNav={desk.book.starting_nav}
        dayPnl={desk.book.day_pnl}
        windowId={windowId}
        onWindow={setWindowId}
      />
      <AllocFooter desk={desk} slices={slices} />
    </section>
  );
}

function AllocFooter({
  desk,
  slices,
}: {
  desk: DeskPayload;
  slices: readonly AllocSlice[];
}) {
  const totalMass = slices.reduce((sum, row) => sum + row.mass, 0);
  return (
    <div className="term-alloc">
      <div className="term-alloc-bar" aria-hidden="true">
        {slices.map((row) => (
          <i
            key={row.id}
            className={row.muted ? `${row.tone} muted` : row.tone}
            style={{ flexGrow: Math.max(row.mass, 0.0001) }}
            title={row.pct === null
              ? `${row.symbol} ${NOT_IN_LEDGER}`
              : `${row.symbol} ${(row.pct * 100).toFixed(1)}%`}
          />
        ))}
        {totalMass <= 0 && <span className="empty">{NOT_IN_LEDGER}</span>}
      </div>
      <p className="term-alloc-readout">
        NAV {ledgerFigure(desk.book.current_nav, moneyPrecise)}
        {' · '}CASH {ledgerFigure(desk.book.cash, moneyPrecise)}
        {' · '}DEPLOYED {ledgerFigure(desk.book.deployed, moneyPrecise)}
        {' · '}
        <span className={pnlClass(desk.book.vs_start)}>
          vs start {signedMoney(desk.book.vs_start)}
        </span>
        {' · '}
        {desk.book.observed_at ? nyStamp(desk.book.observed_at) : NOT_IN_LEDGER}
      </p>
      <p className="term-alloc-legend">
        {slices.map((row) => (
          <span key={row.id}>
            {row.symbol} {row.pct === null ? NOT_IN_LEDGER : `${(row.pct * 100).toFixed(1)}%`}
          </span>
        ))}
      </p>
    </div>
  );
}
