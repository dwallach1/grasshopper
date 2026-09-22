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

export function BeliefQueue({
  desk,
  onOpenThesis,
}: {
  desk: DeskPayload;
  onOpenThesis: (thesisId: string) => void;
}) {
  const queue = useMemo(() => assembleBeliefsInForce(desk), [desk]);

  return (
    <section
      id="beliefs-in-force"
      className="review-queue belief-queue"
      aria-label="Beliefs in force"
      tabIndex={-1}
    >
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
            <BeliefCard key={row.id} row={row} onOpenThesis={onOpenThesis} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function TaggedLotQueue({
  desk,
  onOpenThesis,
}: {
  desk: DeskPayload;
  onOpenThesis: (thesisId: string) => void;
}) {
  const queue = useMemo(() => assembleTaggedLots(desk), [desk]);

  return (
    <section
      id="tagged-lots"
      className="review-queue tagged-lot-queue"
      aria-label="Open-book thesis tags"
      tabIndex={-1}
    >
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
            <TaggedLotCardView key={row.id} row={row} onOpenThesis={onOpenThesis} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function BeliefCard({
  row,
  onOpenThesis,
}: {
  row: BeliefInForceCard;
  onOpenThesis: (thesisId: string) => void;
}) {
  const bind = row.holdings.length
    ? `binds ${row.holdings.map((lot) => lot.name).join(', ')}`
    : 'no open lot';

  return (
    <li>
      <button
        type="button"
        className="review-card"
        data-belief={row.id}
        data-thesis={row.thesis_id}
        data-from-lesson={row.from_lesson ? '1' : '0'}
        onClick={() => onOpenThesis(row.thesis_id)}
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
      </button>
    </li>
  );
}

function TaggedLotCardView({
  row,
  onOpenThesis,
}: {
  row: TaggedLotCard;
  onOpenThesis: (thesisId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="review-card"
        data-tagged-lot={row.id}
        data-thesis={row.thesis_id}
        onClick={() => onOpenThesis(row.thesis_id)}
      >
        <span className="review-card-copy">
          <b>{row.name}</b>
          <i>{row.thesis_id} · {row.thesis_name}</i>
        </span>
        <span className="review-card-meta">
          <span className="thesis-chip">tagged lot</span>
        </span>
      </button>
    </li>
  );
}
