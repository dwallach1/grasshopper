'use client';

import { useMemo, useState } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { assembleDeskBookRollup } from '../../lib/desk-book-rollup';
import {
  assembleLiveline,
  bookCurve,
  type LivelineBookId,
} from '../../lib/desk-liveline';
import { lotKey, rowVenue, type VenueFilter } from '../../lib/desk-venue';
import { nextHeldCatalyst } from '../../lib/held-catalyst';
import type { BookPerformance, DeskPayload, FillLogRow, ThesisLot, ThesisRow } from '../../lib/ledger-types';
import { latestMemePnl, memeDesk } from '../../lib/meme-book';
import { ledgerAmount, ledgerAmountFor } from '../../lib/money-units';
import {
  deskBookNames,
  filterBookNames,
  filterFillLog,
  filterIntents,
  latestPredictionPnl,
  predictionDesk,
} from '../../lib/prediction-book';
import { fillLogCaption, NO_POSITION } from '../../lib/thesis-book';
import { DeskLiveline } from './desk-liveline';
import { VenueFilterBar, VenueMark } from './venue-filter';
import {
  ledgerFigure,
  moneyPrecise,
  nyStamp,
  pnlClass,
  qty,
  signedMoney,
  toneForStatus,
} from './format';

function venueBook(venue: Exclude<VenueFilter, 'all'>): LivelineBookId {
  if (venue === 'prediction') return 'oddsborne';
  if (venue === 'meme') return 'bandit';
  return 'quantanamo';
}

export function BookPanel({
  desk,
  nowIso,
}: {
  desk: DeskPayload;
  nowIso: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [venue, setVenue] = useState<VenueFilter>('all');
  const names = useMemo(() => filterBookNames(deskBookNames(desk), venue), [desk, venue]);
  const prediction = useMemo(() => predictionDesk(desk), [desk]);
  const coins = useMemo(() => memeDesk(desk), [desk]);
  const catalyst = useMemo(
    () => nextHeldCatalyst(desk.catalysts, names, nowIso),
    [desk.catalysts, names, nowIso],
  );
  const skinned = desk.theses.filter((row) =>
    row.lots.some((lot) => venue === 'all' || rowVenue(lot) === venue),
  );
  const fillLog = filterFillLog(desk.fill_log, venue);
  const intents = filterIntents(desk.intents, prediction, venue, coins);
  const rollup = useMemo(() => assembleDeskBookRollup(desk), [desk]);
  const line = useMemo(() => assembleLiveline(desk), [desk]);

  return (
    <div className="line-stage line-book">
      <header className="line-mast">
        <p className="line-kicker">native books</p>
        <h1>Book</h1>
        <p className="line-lede">
          Equity in the unit it was marked. USD and SOL never share an axis.
          {desk.book.observed_at ? ` · ${nyStamp(desk.book.observed_at)}` : ''}
        </p>
      </header>

      <VenueFilterBar value={venue} onChange={setVenue} />

      {venue === 'all' ? (
        <div className="line-stack">
          {line.books.map((book) => (
            <article key={book.id} className="line-card">
              <header>
                <b>{book.label}</b>
                <span>{book.unit}</span>
              </header>
              <DeskLiveline
                points={book.equity}
                value={book.now}
                unit={book.unit}
                color={book.color}
                emptyText={book.empty_text}
                returnPct={book.return_pct}
                degen
              />
            </article>
          ))}
          <p className="line-caption">{rollup.note}</p>
        </div>
      ) : (
        <section className="line-hero" aria-label="Book equity line">
          <DeskLiveline
            points={bookCurve(line, venueBook(venue))?.equity ?? []}
            value={bookCurve(line, venueBook(venue))?.now ?? null}
            unit={bookCurve(line, venueBook(venue))?.unit ?? 'USD'}
            color={bookCurve(line, venueBook(venue))?.color}
            emptyText={bookCurve(line, venueBook(venue))?.empty_text}
            returnPct={bookCurve(line, venueBook(venue))?.return_pct ?? null}
            degen
          />
          <BookAside desk={desk} venue={venue} />
        </section>
      )}

      <section className="line-sheet">
        <header>
          <b>Lots</b>
          <span>ledger marks only</span>
        </header>
        <div className="term-scroll">
          <BookTable
            names={names}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      </section>

      <section className="line-quiet">
        <header>
          <b>Next dated catalyst</b>
          <span>held names · Events has the sheet</span>
        </header>
        {catalyst ? (
          <p className="line-whisper">
            <b>{catalyst.symbol}</b>
            {' '}
            {catalyst.catalyst_type} · {catalyst.event_date} · {catalyst.status}
          </p>
        ) : (
          <p className="empty">{NOT_IN_LEDGER}</p>
        )}
        <header>
          <b>Fills</b>
          <span>{fillLogCaption(fillLog)}</span>
        </header>
        <FillLogTable rows={fillLog} />
        <header>
          <b>Working</b>
        </header>
        {intents.filter((row) => {
          const status = row.status.toLowerCase();
          return status !== 'filled' && status !== 'canceled' && status !== 'cancelled';
        }).slice(0, 6).map((row) => (
          <p key={`${row.venue}-${row.id}`} className="line-whisper">
            <b>{row.symbol} <VenueMark venue={row.venue} /></b>
            {' '}
            {row.side} · {row.status}
          </p>
        ))}
      </section>

      <section className="line-quiet">
        <header>
          <b>Thesis lots</b>
          <span>same 7638 snapshot</span>
        </header>
        {skinned.map((row) => (
          <ThesisSkin key={row.id} row={row} venue={venue} />
        ))}
        {!skinned.length && <p className="empty">{NO_POSITION}</p>}
      </section>
    </div>
  );
}

function BookAside({ desk, venue }: { desk: DeskPayload; venue: Exclude<VenueFilter, 'all'> }) {
  if (venue === 'equity') return <StockNote book={desk.book} />;
  if (venue === 'prediction') return <PredictionNote desk={desk} />;
  return <CoinNote desk={desk} />;
}

function StockNote({ book }: { book: BookPerformance }) {
  return (
    <p className="line-caption">
      NAV {ledgerFigure(book.current_nav, moneyPrecise)}
      {' · cash '}
      {ledgerFigure(book.cash, moneyPrecise)}
      {' · vs start '}
      <span className={pnlClass(book.vs_start)}>{signedMoney(book.vs_start)}</span>
      {book.observed_at ? ` · ${nyStamp(book.observed_at)}` : ''}
      . Marks are ledger-only.
    </p>
  );
}

function PredictionNote({ desk }: { desk: DeskPayload }) {
  const pnl = latestPredictionPnl(predictionDesk(desk));
  if (!pnl) return <p className="line-caption">ODDSBORNE {NOT_IN_LEDGER}</p>;
  return (
    <p className="line-caption">
      equity {ledgerAmount(pnl.equity, 'USD')}
      {' · cash '}
      {ledgerAmount(pnl.cash, 'USD')}
      {' · '}
      {nyStamp(pnl.as_of)}
      . Marks are ledger-only.
    </p>
  );
}

function CoinNote({ desk }: { desk: DeskPayload }) {
  const pnl = latestMemePnl(memeDesk(desk));
  if (!pnl) return <p className="line-caption">BANDIT {NOT_IN_LEDGER}</p>;
  return (
    <p className="line-caption">
      equity {ledgerAmount(pnl.equity_sol, 'SOL')}
      {' · cash '}
      {ledgerAmount(pnl.cash_sol, 'SOL')}
      {' · SOL native — not USD · '}
      {nyStamp(pnl.as_of)}
    </p>
  );
}

function BookTable({
  names,
  selectedId,
  onSelect,
}: {
  names: BookPerformance['names'];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Qty</th>
          <th>Mark</th>
          <th>P/L</th>
        </tr>
      </thead>
      <tbody>
        {names.map((row) => {
          const id = lotKey(rowVenue(row), row.symbol);
          return (
            <tr
              key={id}
              className={selectedId === id || selectedId === row.symbol ? 'sel' : ''}
              onClick={() => onSelect(id === selectedId || row.symbol === selectedId ? null : id)}
            >
              <td className="sym">{row.symbol} <VenueMark venue={rowVenue(row)} /></td>
              <td>{qty(row.quantity)}</td>
              <td>{row.mark === null ? row.note : ledgerAmountFor(row, row.mark)}</td>
              <td className={pnlClass(row.pnl)}>{row.pnl === null ? row.note : ledgerAmountFor(row, row.pnl, true)}</td>
            </tr>
          );
        })}
        {!names.length && (
          <tr><td colSpan={4} className="empty">{NOT_IN_LEDGER}</td></tr>
        )}
      </tbody>
    </table>
  );
}

function FillLogTable({ rows }: { rows: FillLogRow[] }) {
  if (!rows.length) {
    return <p className="empty">{NOT_IN_LEDGER}</p>;
  }
  return (
    <>
      {rows.slice(0, 8).map((row) => (
        <p key={row.id} className="line-whisper">
          <b>{row.symbol || NOT_IN_LEDGER} <VenueMark venue={rowVenue(row)} /></b>
          {' '}
          {row.side || NOT_IN_LEDGER} {qty(row.quantity)}
          {' · '}
          {nyStamp(row.at)}
        </p>
      ))}
    </>
  );
}

function ThesisSkin({ row, venue }: { row: ThesisRow; venue: VenueFilter }) {
  const lots = row.lots.filter((lot) => venue === 'all' || rowVenue(lot) === venue);
  return (
    <div className="term-thesis">
      <div className="term-thesis-head">
        <b className="sym">{row.id}</b>
        <span className={toneForStatus(row.status)}>{row.status}</span>
      </div>
      {lots.map((lot) => (
        <LotBar key={`${row.id}-${rowVenue(lot)}-${lot.symbol}`} lot={lot} />
      ))}
    </div>
  );
}

function LotBar({ lot }: { lot: ThesisLot }) {
  return (
    <div className="term-skin">
      <div>
        <i>Position</i>
        <b>{lot.symbol} <VenueMark venue={rowVenue(lot)} /> · {qty(lot.quantity)}</b>
      </div>
      <div>
        <i>Mark</i>
        <b className={pnlClass(lot.pnl)}>{currentCell(lot)}</b>
      </div>
    </div>
  );
}

function currentCell(lot: ThesisLot): string {
  if (lot.mark === null) return lot.note || 'mark not in ledger';
  if (lot.pnl === null) return ledgerAmountFor(lot, lot.mark);
  return `${ledgerAmountFor(lot, lot.mark)} ${ledgerAmountFor(lot, lot.pnl, true)}`;
}
