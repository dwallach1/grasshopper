'use client';

import { useMemo, useState } from 'react';

import { holdingLifeLabel, holdingTicket, type BookHolding } from '../../lib/book-holdings';
import { isMarkStale } from '../../lib/desk-freshness';
import { formatAmount, ledgerAmount } from '../../lib/money-units';
import type { BookOpen, BookOpenTicket } from '../../lib/book-open-strip';
import { QUIET_STEWARD_FACE, type StewardFace } from '../../lib/steward-face';
import { DeskLiveline } from './desk-liveline';
import { HoldingIcon } from './holding-icon';
import { StewardAvatar } from './steward-avatar';
import { age, pct, pnlClass } from './format';

export function BookOpenStrip({
  open,
  holdings = [],
  faces,
  now = null,
}: {
  open: BookOpen;
  holdings?: readonly BookHolding[];
  faces?: ReadonlyMap<string, StewardFace>;
  now?: number | null;
}) {
  const tickets = useMemo(() => open.rows.flatMap((row) => row.tickets), [open.rows]);
  const rows = holdings.length ? holdings : [];
  const [selected, setSelected] = useState<string | null>(null);
  if (rows.length === 0 && tickets.length === 0) return null;
  const live = rows.filter((row) => row.life === 'live').length;
  const closed = rows.filter((row) => row.life === 'closed').length;

  return (
    <section className="book-open book-holdings" aria-label="Holdings">
      <p className="book-open-kicker">
        HOLDINGS
        <span className="book-open-age">{rows.length}</span>
        <span className="book-open-age">{live} live</span>
        <span className="book-open-age">{closed} closed</span>
        {open.rows.map((row) => (
          <span key={row.id} className="book-open-age">
            {row.steward} marks {age(row.marked_at ?? undefined, now)}
          </span>
        ))}
      </p>
      <div className="book-holdings-table" role="table">
        <div className="book-holdings-head" role="row">
          <span className="book-holdings-icon-col" aria-hidden="true" />
          <span>Name</span>
          <span>Who</span>
          <span>Life</span>
          <span className="book-holdings-num">Cost</span>
          <span className="book-holdings-num">Mark</span>
          <span className="book-holdings-num">%</span>
          <span className="book-holdings-num">Size</span>
          <span className="book-holdings-num book-holdings-upl">UPL</span>
        </div>
        <ul className="book-holdings-body">
          {rows.map((row) => {
            const ticket = holdingTicket(row, tickets);
            const expanded = selected === row.id;
            const face = faces?.get(row.steward_slug) ?? QUIET_STEWARD_FACE;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className={`book-holdings-row${expanded ? ' is-open' : ''}`}
                  data-life={row.life}
                  aria-expanded={expanded}
                  onClick={() => setSelected(expanded ? null : row.id)}
                >
                  <HoldingIcon name={row.name} venue={row.venue} seed={row.glyph} />
                  <span className="book-holdings-name">
                    <b>{row.name}</b>
                    <i className="book-holdings-who">
                      <StewardAvatar
                        slug={row.steward_slug}
                        name={row.steward}
                        size="glyph"
                        accent={undefined}
                        {...face}
                      />
                      {row.steward}
                    </i>
                  </span>
                  <span className="book-holdings-steward">{row.book_short}</span>
                  <span className={`book-life is-${row.life}`}>{holdingLifeLabel(row.life)}</span>
                  <span className="book-holdings-num">{row.cost === null ? '—' : formatAmount(row.cost, row.unit)}</span>
                  <span className="book-holdings-num">{row.mark === null ? '—' : formatAmount(row.mark, row.unit)}</span>
                  <span className={`book-holdings-num book-holdings-pct ${row.change_pct === null ? 'muted' : pnlClass(row.change_pct)}`}>
                    {pct(row.change_pct, 1)}
                  </span>
                  <span className="book-holdings-num">{formatSize(row.size)}</span>
                  <span className={`book-holdings-num book-holdings-upl ${row.upl === null ? 'muted' : pnlClass(row.upl)}`}>
                    {row.upl === null ? '—' : ledgerAmount(row.upl, row.unit, true)}
                  </span>
                </button>
                {expanded ? (
                  <HoldingDetail row={row} ticket={ticket} now={now} />
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function HoldingDetail({
  row,
  ticket,
  now,
}: {
  row: BookHolding;
  ticket?: BookOpenTicket;
  now: number | null;
}) {
  const costLabel = row.cost === null ? undefined : formatAmount(row.cost, row.unit);
  const markAge = ticket ? age(ticket.marked_at ?? undefined, now) : '—';
  return (
    <div className="book-holdings-detail">
      <p>
        {row.steward} · {holdingLifeLabel(row.life)} · {row.unit}
        {row.note ? ` · ${row.note}` : ''}
        {ticket ? ` · marks ${markAge}` : ''}
      </p>
      {ticket?.drawable ? (
        <OpenTicket ticket={ticket} now={now} costLabel={costLabel} />
      ) : null}
    </div>
  );
}

function OpenTicket({
  ticket,
  now,
  costLabel,
}: {
  ticket: BookOpenTicket;
  now: number | null;
  costLabel?: string;
}) {
  const markAge = age(ticket.marked_at ?? undefined, now);
  return (
    <div className={`book-open-ticket${isMarkStale(ticket.marked_at, now ?? Date.now()) ? ' is-stale' : ''}`} aria-label={`${ticket.steward} ${ticket.label} ${ticket.meta} marks ${markAge}${isMarkStale(ticket.marked_at, now ?? Date.now()) ? ' stale' : ''}`}>
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

function formatSize(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}
