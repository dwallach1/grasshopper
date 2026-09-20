'use client';

import { useMemo } from 'react';

import { humanizeRule } from '../../lib/beliefs';
import type { DeskPayload } from '../../lib/ledger-types';
import {
  assembleBeliefsInForce,
  assembleTaggedLots,
  type BeliefInForceCard,
  type TaggedLotCard,
} from '../../lib/learning-inspect';

export function BeliefQueue({ desk }: { desk: DeskPayload }) {
  const queue = useMemo(() => assembleBeliefsInForce(desk), [desk]);

  return (
    <section className="review-queue belief-queue" aria-label="Beliefs in force">
      <header className="review-mast">
        <p className="paper-title">Beliefs</p>
        <p className="thesis-lede">
          {queue.length
            ? 'Newest playbook rule per thesis. Public phone is read-only.'
            : 'No playbook beliefs in force on this desk.'}
        </p>
      </header>
      {queue.length ? (
        <ul className="review-list">
          {queue.map((row) => (
            <BeliefCard key={row.id} row={row} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function TaggedLotQueue({ desk }: { desk: DeskPayload }) {
  const queue = useMemo(() => assembleTaggedLots(desk), [desk]);

  return (
    <section className="review-queue tagged-lot-queue" aria-label="Open-book thesis tags">
      <header className="review-mast">
        <p className="paper-title">Tagged lots</p>
        <p className="thesis-lede">
          {queue.length
            ? 'Open lots that carry a thesis id.'
            : 'No open lot is thesis-tagged.'}
        </p>
      </header>
      {queue.length ? (
        <ul className="review-list">
          {queue.map((row) => (
            <TaggedLotCardView key={row.id} row={row} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function BeliefCard({ row }: { row: BeliefInForceCard }) {
  const bind = row.holdings.length
    ? `binds ${row.holdings.map((lot) => lot.name).join(', ')}`
    : 'no open lot';

  return (
    <li
      className="review-card"
      data-belief={row.id}
      data-thesis={row.thesis_id}
      data-from-lesson={row.from_lesson ? '1' : '0'}
    >
      <span className="review-card-copy">
        <b>{row.thesis_name}</b>
        <i>
          {row.thesis_id}
          {row.steward ? ` · ${row.steward}` : ''}
          {' · '}
          {row.observed_at.slice(0, 10)}
          {' · '}
          {bind}
        </i>
        {row.rules.length ? (
          <i>{row.rules.map(humanizeRule).join(' · ')}</i>
        ) : null}
        {row.rationale ? <p>{row.rationale}</p> : null}
      </span>
      <span className="review-card-meta">
        <span className="thesis-chip">in force</span>
        {row.from_lesson ? <span className="thesis-chip">from lesson</span> : null}
      </span>
    </li>
  );
}

function TaggedLotCardView({ row }: { row: TaggedLotCard }) {
  return (
    <li
      className="review-card"
      data-tagged-lot={row.id}
      data-thesis={row.thesis_id}
    >
      <span className="review-card-copy">
        <b>{row.name}</b>
        <i>{row.thesis_id} · {row.thesis_name}</i>
      </span>
      <span className="review-card-meta">
        <span className="thesis-chip">tagged lot</span>
      </span>
    </li>
  );
}
