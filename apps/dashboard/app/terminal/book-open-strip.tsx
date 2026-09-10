'use client';

import { DeskLiveline } from './desk-liveline';
import { age } from './format';
import type { BookOpen, BookOpenTicket } from '../../lib/book-open-strip';
import { formatAmount } from '../../lib/money-units';

export function BookOpenStrip({
  open,
  now = null,
}: {
  open: BookOpen;
  now?: number | null;
}) {
  const tickets = open.rows.flatMap((row) => row.tickets);
  if (tickets.length === 0) return null;

  return (
    <section className="book-open" aria-label="Open tickets">
      <p className="book-open-kicker">
        OPEN
        {open.rows.map((row) => (
          <span key={row.id} className="book-open-age">
            {row.steward} marks {age(row.marked_at ?? undefined, now)}
          </span>
        ))}
      </p>
      <ul className="book-open-tickets">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <OpenTicket ticket={ticket} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OpenTicket({
  ticket,
  now,
}: {
  ticket: BookOpenTicket;
  now: number | null;
}) {
  const costLabel = ticket.cost === null ? undefined : formatAmount(ticket.cost, ticket.unit);
  const markAge = age(ticket.marked_at ?? undefined, now);
  return (
    <div className="book-open-ticket" aria-label={`${ticket.steward} ${ticket.label} ${ticket.meta} marks ${markAge}`}>
      <div className="book-open-ticket-id">
        <b>{ticket.label}</b>
        <span>{ticket.meta} · {markAge}</span>
      </div>
      {ticket.drawable ? (
        <DeskLiveline
          compact
          points={ticket.points}
          value={ticket.value}
          series={ticket.overlays}
          unit={ticket.unit}
          color={ticket.color}
          showValue={false}
          referenceLine={ticket.cost === null || !costLabel
            ? undefined
            : { value: ticket.cost, label: costLabel }}
          emptyText="not in ledger"
          className="book-open-line"
        />
      ) : null}
    </div>
  );
}
