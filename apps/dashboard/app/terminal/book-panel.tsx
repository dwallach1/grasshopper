'use client';

import { useMemo, useState } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { lotKey, matchesVenueFilter, rowVenue, type VenueFilter } from '../../lib/desk-venue';
import { nextHeldCatalyst } from '../../lib/held-catalyst';
import type { BookPerformance, DeskPayload, FillLogRow, ThesisLot, ThesisRow } from '../../lib/ledger-types';
import { latestMemePnl, memeDesk } from '../../lib/meme-book';
import {
  deskBookNames,
  filterBookNames,
  filterFillLog,
  filterIntents,
  latestPredictionPnl,
  predictionDesk,
} from '../../lib/prediction-book';
import { fillLogCaption, NO_POSITION } from '../../lib/thesis-book';
import { BookDiagnostic } from './book-diagnostic';
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

  return (
    <div className="term-grid term-grid-book">
      <section className="term-panel term-book-kpis">
        <header>
          <b>BOOK</b>
          <span>
            one desk · three venues
            {desk.book.observed_at ? ` · ${nyStamp(desk.book.observed_at)}` : ''}
          </span>
        </header>
        <VenueFilterBar value={venue} onChange={setVenue} />
        {matchesVenueFilter('equity', venue) && <BookKpis book={desk.book} />}
        {matchesVenueFilter('prediction', venue) && (
          <PredictionKpis desk={desk} compact={venue === 'all'} />
        )}
        {matchesVenueFilter('meme', venue) && (
          <CoinKpis desk={desk} compact={venue === 'all'} />
        )}
      </section>
      <section className="term-panel term-book-table">
        <header>
          <b>LOTS</b>
          <span>table is canonical · venue chip · marks ledger-only</span>
        </header>
        <div className="term-scroll">
          <BookTable
            names={names}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      </section>
      {matchesVenueFilter('equity', venue) && (
        <BookDiagnostic
          desk={desk}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
      <section className="term-panel term-book-catalyst">
        <header>
          <b>NEXT DATED CATALYST</b>
          <span>held names only · full sheet is Events</span>
        </header>
        {catalyst ? (
          <div className="term-line">
            <b className="sym">{catalyst.symbol}</b>
            <span>{catalyst.catalyst_type} · {catalyst.event_date} · {catalyst.thesis_id || 'unlinked'}</span>
            <i className={toneForStatus(catalyst.status)}>{catalyst.status}</i>
            <p>{catalyst.summary}</p>
          </div>
        ) : (
          <p className="empty">{NOT_IN_LEDGER}</p>
        )}
      </section>
      <section className="term-panel term-book-fills">
        <header>
          <b>FILLS</b>
          <span>{fillLogCaption(fillLog)} · tape time per row</span>
        </header>
        <FillLogTable rows={fillLog} />
        <header>
          <b>INTENTS</b>
          <span>unfilled / working</span>
        </header>
        {intents.filter((row) => {
          const status = row.status.toLowerCase();
          return status !== 'filled' && status !== 'canceled' && status !== 'cancelled';
        }).slice(0, 8).map((row) => (
          <div key={`${row.venue}-${row.id}`} className="term-line">
            <b className="sym">{row.symbol} <VenueMark venue={row.venue} /></b>
            <span>{row.side} {row.mode} {row.notional === null ? NOT_IN_LEDGER : moneyPrecise(row.notional)} · {qty(row.quantity)}</span>
            <i className={toneForStatus(row.status)}>{row.status}</i>
            <p>{row.order_type} {row.broker_order_id || ''}</p>
          </div>
        ))}
      </section>
      <section className="term-panel term-book-lots">
        <header>
          <b>THESIS LOTS</b>
          <span>
            same 7638 snapshot
            {desk.book.observed_at ? ` · ${nyStamp(desk.book.observed_at)}` : ` · ${NOT_IN_LEDGER}`}
          </span>
        </header>
        {skinned.map((row) => (
          <ThesisSkin key={row.id} row={row} venue={venue} />
        ))}
        {!skinned.length && <p className="empty">{NO_POSITION}</p>}
      </section>
    </div>
  );
}

function BookKpis({ book }: { book: BookPerformance }) {
  return (
    <>
      <div className="term-kpis">
        <div className="term-kpi-hero">
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
          <i>Buying power</i>
          <b>{ledgerFigure(book.buying_power, moneyPrecise)}</b>
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
        {book.account_label || 'Agentic'} last4 {book.last4 || '7638'}
        {book.observed_at ? ` · snapshot ${nyStamp(book.observed_at)}` : ` · snapshot ${NOT_IN_LEDGER}`}
        {book.starting_nav !== null ? ` · start ${moneyPrecise(book.starting_nav)}` : ` · start ${book.vs_start_note}`}
        {`. Day P/L: ${book.day_pnl_note}. vs cost: ${book.vs_cost_note}. Marks are ledger-only.`}
      </p>
    </>
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
          <th>Avg cost</th>
          <th>Cost</th>
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
              <td>{ledgerFigure(row.average_cost, moneyPrecise)}</td>
              <td>{ledgerFigure(row.cost, moneyPrecise)}</td>
              <td>{row.mark === null ? row.note : moneyPrecise(row.mark)}</td>
              <td className={pnlClass(row.pnl)}>{row.pnl === null ? row.note : signedMoney(row.pnl)}</td>
            </tr>
          );
        })}
        {!names.length && (
          <tr><td colSpan={6} className="empty">{NOT_IN_LEDGER}</td></tr>
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
      {rows.map((row) => (
        <div key={row.id} className="term-line">
          <b className="sym">{row.symbol || NOT_IN_LEDGER} <VenueMark venue={rowVenue(row)} /></b>
          <span>
            {row.side || NOT_IN_LEDGER} {qty(row.quantity)} · {row.price === null ? (row.note || NOT_IN_LEDGER) : moneyPrecise(row.price)} / {ledgerFigure(row.notional, moneyPrecise)}
          </span>
          <i className={toneForStatus(row.status)}>{row.status}</i>
          <p>{nyStamp(row.at)}</p>
        </div>
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
        <i>{row.confidence} · {row.stance}</i>
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
        <b>{lot.symbol} <VenueMark venue={rowVenue(lot)} /> · {lot.side.toUpperCase()} · {qty(lot.quantity)}</b>
      </div>
      <div>
        <i>Invested</i>
        <b>{ledgerFigure(lot.invested, moneyPrecise)}</b>
      </div>
      <div>
        <i>Current</i>
        <b className={pnlClass(lot.pnl)}>{currentCell(lot)}</b>
      </div>
    </div>
  );
}

function PredictionKpis({ desk, compact = false }: { desk: DeskPayload; compact?: boolean }) {
  const pnl = latestPredictionPnl(predictionDesk(desk));
  if (!pnl) {
    return compact ? null : <p className="empty">ODDSBORNE book {NOT_IN_LEDGER}</p>;
  }
  return (
    <div className={compact ? 'term-prose dim' : undefined}>
      {!compact && (
        <div className="term-kpis">
          <div>
            <i>Predictions equity</i>
            <b>{ledgerFigure(pnl.equity, moneyPrecise)}</b>
          </div>
          <div>
            <i>Cash</i>
            <b>{ledgerFigure(pnl.cash, moneyPrecise)}</b>
          </div>
          <div>
            <i>Realized</i>
            <b className={pnlClass(pnl.realized)}>{signedMoney(pnl.realized)}</b>
          </div>
          <div>
            <i>Unrealized</i>
            <b className={pnlClass(pnl.unrealized)}>{signedMoney(pnl.unrealized)}</b>
          </div>
        </div>
      )}
      <p className="term-prose dim">
        ODDSBORNE {nyStamp(pnl.as_of)}
        {pnl.notes ? ` · ${pnl.notes}` : ''}
        {compact ? ` · equity ${ledgerFigure(pnl.equity, moneyPrecise)}` : ''}
        . Marks are ledger-only.
      </p>
    </div>
  );
}

function CoinKpis({ desk, compact = false }: { desk: DeskPayload; compact?: boolean }) {
  const pnl = latestMemePnl(memeDesk(desk));
  if (!pnl) {
    return compact ? null : <p className="empty">BANDIT book {NOT_IN_LEDGER}</p>;
  }
  return (
    <div className={compact ? 'term-prose dim' : undefined}>
      {!compact && (
        <div className="term-kpis">
          <div>
            <i>Coins equity</i>
            <b>{ledgerFigure(pnl.equity_sol, moneyPrecise)}</b>
          </div>
          <div>
            <i>Cash</i>
            <b>{ledgerFigure(pnl.cash_sol, moneyPrecise)}</b>
          </div>
          <div>
            <i>Realized</i>
            <b className={pnlClass(pnl.realized)}>{signedMoney(pnl.realized)}</b>
          </div>
          <div>
            <i>Unrealized</i>
            <b className={pnlClass(pnl.unrealized)}>{signedMoney(pnl.unrealized)}</b>
          </div>
        </div>
      )}
      <p className="term-prose dim">
        BANDIT {nyStamp(pnl.as_of)}
        {pnl.notes ? ` · ${pnl.notes}` : ''}
        {compact ? ` · equity ${ledgerFigure(pnl.equity_sol, moneyPrecise)}` : ''}
        . Marks are ledger-only.
      </p>
    </div>
  );
}

function currentCell(lot: ThesisLot): string {
  if (lot.mark === null) return lot.note || 'mark not in ledger';
  if (lot.pnl === null) return moneyPrecise(lot.mark);
  return `${moneyPrecise(lot.mark)} ${signedMoney(lot.pnl)}`;
}
