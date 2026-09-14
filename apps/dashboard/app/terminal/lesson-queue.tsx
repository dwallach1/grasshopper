'use client';

import { useMemo, useState } from 'react';

import {
  incorporateResearchLesson,
  openLessonCount,
  rankLessonsForDesk,
  thesisNameForLesson,
} from '../../lib/lesson-incorporate';
import type { DeskPayload, LessonRow } from '../../lib/ledger-types';

export function LessonQueue({
  desk,
  canIncorporate = false,
  onIncorporated,
}: {
  desk: DeskPayload;
  canIncorporate?: boolean;
  onIncorporated?: () => void;
}) {
  const queue = useMemo(
    () => rankLessonsForDesk(desk.lessons ?? []),
    [desk.lessons],
  );
  const open = openLessonCount(queue);

  return (
    <section className="review-queue lesson-queue" aria-label="Research lessons">
      <header className="review-mast">
        <p className="paper-title">Lessons</p>
        <p className="thesis-lede">
          {queue.length
            ? `${open} open · ${queue.length - open} in playbook`
            : 'No research lessons on this desk.'}
          {canIncorporate
            ? ' Incorporate writes a playbook rule.'
            : ' Public phone is read-only.'}
        </p>
      </header>
      {queue.length ? (
        <ul className="review-list">
          {queue.map((row) => (
            <LessonCard
              key={row.id}
              row={row}
              thesisName={thesisNameForLesson(row, desk.theses ?? [])}
              canIncorporate={canIncorporate}
              onIncorporated={onIncorporated}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function LessonCard({
  row,
  thesisName,
  canIncorporate,
  onIncorporated,
}: {
  row: LessonRow;
  thesisName: string;
  canIncorporate: boolean;
  onIncorporated?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const open = !row.incorporated;

  async function act() {
    if (!canIncorporate || !open || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await incorporateResearchLesson({ lesson_id: row.id });
      onIncorporated?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Incorporate failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="review-card"
      data-lesson={row.id}
      data-incorporated={row.incorporated ? '1' : '0'}
      data-lesson-type={row.lesson_type}
    >
      <span className="review-card-copy">
        <b>{thesisName}</b>
        <i>
          {row.lesson_type}
          {row.market_regime ? ` · ${row.market_regime}` : ''}
        </i>
        <p>{row.summary}</p>
      </span>
      <span className="review-card-meta">
        <span className="thesis-chip">{open ? 'open' : 'in playbook'}</span>
      </span>
      {canIncorporate && open ? (
        <div className="review-actions">
          <div className="review-buttons">
            <button type="button" disabled={busy} onClick={() => void act()}>
              {busy ? 'Incorporating…' : 'Incorporate'}
            </button>
          </div>
          {notice ? <p className="review-notice" role="status">{notice}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
