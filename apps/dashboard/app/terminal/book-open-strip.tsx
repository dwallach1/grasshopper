'use client';

import { DeskLiveline } from './desk-liveline';
import type { BookOpen, BookOpenSteward, BookOpenTicket } from '../../lib/book-open-strip';
import { formatAmount } from '../../lib/money-units';

export function BookOpenStrip({ open }: { open: BookOpen }) {
  if (open.rows.length === 0) return null;

  return (
    <section className="book-open" aria-label="Open tickets">
      <header className="book-open-mast">
        <p className="book-open-kicker">BOOK // OPEN</p>
        <p className="book-open-lede">
          Live marks. Cost is the reference. Missing series omitted.
        </p>
      </header>
      <div className="book-open-stack">
        {open.rows.map((row) => (
          <OpenSteward key={row.id} row={row} />
        ))}
      </div>
    </section>
  );
}

function OpenSteward({ row }: { row: BookOpenSteward }) {
  return (
    <article className="book-open-card" aria-label={`${row.steward} open`}>
      <header className="book-open-who">
        <b>{row.steward}</b>
        <i>{row.venue_label} · {row.unit}</i>
      </header>
      <ul className="book-open-tickets">
        {row.tickets.map((ticket) => (
          <li key={ticket.id}>
            <OpenTicket ticket={ticket} />
          </li>
        ))}
      </ul>
    </article>
  );
}

function OpenTicket({ ticket }: { ticket: BookOpenTicket }) {
  const cost = ticket.cost === null ? null : formatAmount(ticket.cost, ticket.unit);
  return (
    <div className="book-open-ticket">
      <div className="book-open-ticket-id">
        <b>{ticket.label}</b>
        <span>
          {ticket.meta}
          {cost ? ` · cost ${cost}` : ''}
        </span>
      </div>
      <DeskLiveline
        compact
        points={ticket.points}
        value={ticket.value}
        series={ticket.overlays}
        unit={ticket.unit}
        color={ticket.color}
        showValue={false}
        referenceLine={ticket.cost === null ? undefined : { value: ticket.cost, label: 'cost' }}
        emptyText="not in ledger"
        className="book-open-line"
      />
    </div>
  );
}
