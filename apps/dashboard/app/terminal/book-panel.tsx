'use client';

import { useMemo, useState } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { assembleDeskBookRollup, type DeskBookRollup } from '../../lib/desk-book-rollup';
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
  const rollup = useMemo(() => assembleDeskBookRollup(desk), [desk]);

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
        {venue === 'all' && <AllKpis rollup={rollup} />}
        {venue === 'equity' && <BookKpis book={desk.book} />}
        {venue === 'prediction' && <PredictionKpis desk={desk} />}
        {venue === 'meme' && <CoinKpis desk={desk} />}
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
      {venue === 'equity' && (
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
            <span>{row.side} {row.mode} {row.notional === null ? NOT_IN_LEDGER : ledgerAmountFor(row, row.notional)} · {qty(row.quantity)}</span>
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

function AllKpis({ rollup }: { rollup: DeskBookRollup }) {
  return (
    <>
      <div className="term-kpis">
        <div className="term-kpi-hero">
          <i>USD NAV</i>
          <b>{ledgerAmount(rollup.usd_nav, 'USD')}</b>
        </div>
        <div>
          <i>USD cash</i>
          <b>{ledgerAmount(rollup.usd_cash, 'USD')}</b>
        </div>
        <div>
          <i>SOL equity</i>
          <b>{ledgerAmount(rollup.sol_equity, 'SOL')}</b>
        </div>
        <div>
          <i>SOL cash</i>
          <b>{ledgerAmount(rollup.sol_cash, 'SOL')}</b>
        </div>
        <div>
          <i>Open lots</i>
          <b>{rollup.open_lots}</b>
        </div>
      </div>
      <div className="term-rollup-legs">
        {rollup.legs.map((leg) => (
          <div key={leg.venue} className="term-line">
            <b className="sym">{leg.label} <VenueMark venue={leg.venue} /></b>
            <span>
              {leg.unit === 'SOL' ? 'equity' : 'NAV'} {ledgerAmount(leg.equity, leg.unit)}
              {' · cash '}
              {ledgerAmount(leg.cash, leg.unit)}
              {' · '}
              {leg.lots} {leg.lots === 1 ? 'lot' : 'lots'}
            </span>
            <i>{leg.as_of ? nyStamp(leg.as_of) : NOT_IN_LEDGER}</i>
          </div>
        ))}
      </div>
      <p className="term-prose dim">{rollup.note}</p>
    </>
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
              <td>{ledgerAmountFor(row, row.average_cost)}</td>
              <td>{ledgerAmountFor(row, row.cost)}</td>
              <td>{row.mark === null ? row.note : ledgerAmountFor(row, row.mark)}</td>
              <td className={pnlClass(row.pnl)}>{row.pnl === null ? row.note : ledgerAmountFor(row, row.pnl, true)}</td>
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
            {row.side || NOT_IN_LEDGER} {qty(row.quantity)} · {row.price === null ? (row.note || NOT_IN_LEDGER) : ledgerAmountFor(row, row.price)} / {ledgerAmountFor(row, row.notional)}
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
        <b>{ledgerAmountFor(lot, lot.invested)}</b>
      </div>
      <div>
        <i>Current</i>
        <b className={pnlClass(lot.pnl)}>{currentCell(lot)}</b>
      </div>
    </div>
  );
}

function PredictionKpis({ desk }: { desk: DeskPayload }) {
  const pnl = latestPredictionPnl(predictionDesk(desk));
  if (!pnl) {
    return <p className="empty">ODDSBORNE book {NOT_IN_LEDGER}</p>;
  }
  return (
    <>
      <div className="term-kpis">
        <div>
          <i>Predictions equity</i>
          <b>{ledgerAmount(pnl.equity, 'USD')}</b>
        </div>
        <div>
          <i>Cash</i>
          <b>{ledgerAmount(pnl.cash, 'USD')}</b>
        </div>
        <div>
          <i>Realized</i>
          <b className={pnlClass(pnl.realized)}>{ledgerAmount(pnl.realized, 'USD', true)}</b>
        </div>
        <div>
          <i>Unrealized</i>
          <b className={pnlClass(pnl.unrealized)}>{ledgerAmount(pnl.unrealized, 'USD', true)}</b>
        </div>
      </div>
      <p className="term-prose dim">
        ODDSBORNE {nyStamp(pnl.as_of)}
        {pnl.notes ? ` · ${pnl.notes}` : ''}
        . Marks are ledger-only.
      </p>
    </>
  );
}

function CoinKpis({ desk }: { desk: DeskPayload }) {
  const pnl = latestMemePnl(memeDesk(desk));
  if (!pnl) {
    return <p className="empty">BANDIT book {NOT_IN_LEDGER}</p>;
  }
  return (
    <>
      <div className="term-kpis">
        <div>
          <i>Coins equity</i>
          <b>{ledgerAmount(pnl.equity_sol, 'SOL')}</b>
        </div>
        <div>
          <i>Cash</i>
          <b>{ledgerAmount(pnl.cash_sol, 'SOL')}</b>
        </div>
        <div>
          <i>Realized</i>
          <b className={pnlClass(pnl.realized)}>{ledgerAmount(pnl.realized, 'SOL', true)}</b>
        </div>
        <div>
          <i>Unrealized</i>
          <b className={pnlClass(pnl.unrealized)}>{ledgerAmount(pnl.unrealized, 'SOL', true)}</b>
        </div>
      </div>
      <p className="term-prose dim">
        BANDIT {nyStamp(pnl.as_of)} · SOL native — not USD
        {pnl.notes ? ` · ${pnl.notes}` : ''}
        . Marks are ledger-only.
      </p>
    </>
  );
}

function currentCell(lot: ThesisLot): string {
  if (lot.mark === null) return lot.note || 'mark not in ledger';
  if (lot.pnl === null) return ledgerAmountFor(lot, lot.mark);
  return `${ledgerAmountFor(lot, lot.mark)} ${ledgerAmountFor(lot, lot.pnl, true)}`;
}
