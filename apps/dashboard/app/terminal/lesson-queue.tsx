'use client';

import { useMemo, useState } from 'react';

import { closeBeliefForLesson, closeMoveLine, scoredCloseLessonIds } from '../../lib/beliefs';
import {
  incorporateResearchLesson,
  rankLessonsForDesk,
  thesisNameForLesson,
} from '../../lib/lesson-incorporate';
import { lessonAgeDays, lessonAgeLine, OPEN_LESSON_STALE_DAYS } from '../../lib/lesson-waits';
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
  const grouped = useMemo(() => {
    const all = desk.lessons ?? [];
    const scored = scoredCloseLessonIds(desk.beliefs ?? []);
    const newest = (a: LessonRow, b: LessonRow) => b.created_at.localeCompare(a.created_at) || b.id - a.id;
    const oldest = (a: LessonRow, b: LessonRow) => a.created_at.localeCompare(b.created_at) || a.id - b.id;
    return {
      open: all.filter((row) => !row.incorporated && !scored.has(String(row.id))).sort(oldest),
      scored: all.filter((row) => scored.has(String(row.id))).sort(newest),
      playbook: rankLessonsForDesk(all.filter((row) => row.incorporated && !scored.has(String(row.id)))),
    };
  }, [desk.beliefs, desk.lessons]);
  const now = Date.parse(desk.generated_at);

  return (
    <section
      id="lessons-parchment"
      className="review-queue lesson-queue"
      aria-label="Research lessons"
      tabIndex={-1}
    >
      <header className="review-mast">
        <p className="paper-title">Lessons</p>
        <p className="thesis-lede">
          {grouped.open.length || grouped.scored.length || grouped.playbook.length
            ? 'Open lessons waiting for a decision come first. Closes that already moved confidence sit apart. Then the playbook.'
            : 'No research lessons on this desk.'}
          {canIncorporate
            ? ' Incorporate writes a playbook rule.'
            : ' Public phone is read-only.'}
        </p>
      </header>
      {grouped.open.length ? (
        <>
          <p className="books-section-label">Open lessons waiting for a decision · {grouped.open.length}</p>
          <ul className="review-list">
            {grouped.open.map((row) => (
              <LessonCard
                key={row.id}
                row={row}
                thesisName={thesisNameForLesson(row, desk.theses ?? [])}
                canIncorporate={canIncorporate}
                onIncorporated={onIncorporated}
                age={lessonAgeLine(row.created_at, now)}
                stale={(lessonAgeDays(row.created_at, now) ?? 0) >= OPEN_LESSON_STALE_DAYS}
              />
            ))}
          </ul>
        </>
      ) : null}
      {grouped.scored.length ? (
        <>
          <p className="books-section-label">Already moved confidence · {grouped.scored.length}</p>
          <ul className="review-list">
            {grouped.scored.map((row) => (
              <LessonCard
                key={row.id}
                row={row}
                thesisName={thesisNameForLesson(row, desk.theses ?? [])}
                move={closeMoveLine(closeBeliefForLesson(row.id, desk.beliefs ?? []) ?? {
                  prior_confidence: null,
                  new_confidence: null,
                })}
                scored
              />
            ))}
          </ul>
        </>
      ) : null}
      {grouped.playbook.length ? (
        <>
          <p className="books-section-label">In the playbook · {grouped.playbook.length}</p>
          <ul className="review-list">
            {grouped.playbook.map((row) => (
              <LessonCard
                key={row.id}
                row={row}
                thesisName={thesisNameForLesson(row, desk.theses ?? [])}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function LessonCard({
  row,
  thesisName,
  canIncorporate = false,
  onIncorporated,
  age = null,
  stale = false,
  scored = false,
  move = null,
}: {
  row: LessonRow;
  thesisName: string;
  canIncorporate?: boolean;
  onIncorporated?: () => void;
  age?: string | null;
  stale?: boolean;
  scored?: boolean;
  move?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const open = !row.incorporated && !scored;

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
      data-scored={scored ? '1' : undefined}
      data-stale={stale ? '1' : undefined}
      data-lesson-type={row.lesson_type}
    >
      <span className="review-card-copy">
        <b>{thesisName}</b>
        <i>
          {row.lesson_type}
          {row.market_regime ? ` · ${row.market_regime}` : ''}
          {age ? ` · ${age}` : ''}
        </i>
        <p>{row.summary}</p>
        {move ? <p className="books-close-move">{move}</p> : null}
      </span>
      <span className="review-card-meta">
        <span className="thesis-chip">{scored ? 'moved confidence' : open ? 'open' : 'in playbook'}</span>
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
