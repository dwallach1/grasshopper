'use client';

import { useMemo, useState } from 'react';

import {
  closeBeliefForLesson,
  closeMoveLine,
  earningsBoundLessonIds,
  lessonDeskChip,
  lessonNeedsDecision,
  lessonWithBelief,
  scoredCloseLessonIds,
} from '../../lib/beliefs';
import {
  incorporateResearchLesson,
  rankLessonsForDesk,
  thesisNameForLesson,
} from '../../lib/lesson-incorporate';
import {
  lessonAgeDays,
  lessonAgeLine,
  lessonWaitLine,
  openLessonGroup,
  OPEN_LESSON_STALE_DAYS,
  type LessonWait,
} from '../../lib/lesson-waits';
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
  const waits = useMemo(
    () => new Map((desk.lesson_waits ?? []).map((row) => [row.lesson_id, row])),
    [desk.lesson_waits],
  );
  const grouped = useMemo(() => {
    const all = desk.lessons ?? [];
    const beliefs = desk.beliefs ?? [];
    const scored = scoredCloseLessonIds(beliefs);
    const earningsBound = earningsBoundLessonIds(beliefs, all, desk.cycles ?? []);
    const newest = (a: LessonRow, b: LessonRow) => b.created_at.localeCompare(a.created_at) || b.id - a.id;
    const oldest = (a: LessonRow, b: LessonRow) => a.created_at.localeCompare(b.created_at) || a.id - b.id;
    const open = all.filter((row) => lessonNeedsDecision(row, scored, earningsBound)).sort(oldest);
    return {
      ready: open.filter((row) => openLessonGroup(waits.get(row.id)) === 'ready'),
      waiting: open.filter((row) => openLessonGroup(waits.get(row.id)) === 'waiting'),
      scored: all.filter((row) => scored.has(String(row.id))).sort(newest),
      playbook: rankLessonsForDesk(all.filter((row) => lessonWithBelief(row, scored, earningsBound))),
      earningsBound,
    };
  }, [desk.beliefs, desk.cycles, desk.lessons, waits]);
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
          {grouped.ready.length || grouped.waiting.length || grouped.scored.length || grouped.playbook.length
            ? 'Lessons ready to write into the playbook come first. Ones still waiting on a test sit next. Closes that already moved confidence sit apart. Then the playbook.'
            : 'No research lessons on this desk.'}
          {canIncorporate
            ? ' Incorporate writes a playbook rule.'
            : ' Public phone is read-only.'}
        </p>
      </header>
      <LessonLane
        lane="ready"
        label="Ready to write into the playbook"
        rows={grouped.ready}
        desk={desk}
        waits={waits}
        now={now}
        canIncorporate={canIncorporate}
        onIncorporated={onIncorporated}
      />
      <LessonLane
        lane="waiting"
        label="Still waiting on a test"
        rows={grouped.waiting}
        desk={desk}
        waits={waits}
        now={now}
        canIncorporate={canIncorporate}
        onIncorporated={onIncorporated}
      />
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
                earningsBound={grouped.earningsBound.has(String(row.id))}
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
                earningsBound={grouped.earningsBound.has(String(row.id))}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function LessonLane({
  lane,
  label,
  rows,
  desk,
  waits,
  now,
  canIncorporate,
  onIncorporated,
}: {
  lane: 'ready' | 'waiting';
  label: string;
  rows: LessonRow[];
  desk: DeskPayload;
  waits: ReadonlyMap<number, LessonWait>;
  now: number;
  canIncorporate: boolean;
  onIncorporated?: () => void;
}) {
  if (!rows.length) return null;
  return (
    <>
      <p className="books-section-label">{label} · {rows.length}</p>
      <ul className="review-list" data-lesson-lane={lane}>
        {rows.map((row) => (
          <LessonCard
            key={row.id}
            row={row}
            lane={lane}
            thesisName={thesisNameForLesson(row, desk.theses ?? [])}
            canIncorporate={canIncorporate}
            onIncorporated={onIncorporated}
            age={lessonAgeLine(row.created_at, now)}
            wait={lessonWaitLine(waits.get(row.id))}
            stale={(lessonAgeDays(row.created_at, now) ?? 0) >= OPEN_LESSON_STALE_DAYS}
          />
        ))}
      </ul>
    </>
  );
}

function LessonCard({
  row,
  lane,
  thesisName,
  canIncorporate = false,
  onIncorporated,
  age = null,
  wait = null,
  stale = false,
  scored = false,
  earningsBound = false,
  move = null,
}: {
  row: LessonRow;
  lane?: 'ready' | 'waiting';
  thesisName: string;
  canIncorporate?: boolean;
  onIncorporated?: () => void;
  age?: string | null;
  wait?: string | null;
  stale?: boolean;
  scored?: boolean;
  earningsBound?: boolean;
  move?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const open = !row.incorporated && !scored && !earningsBound;
  const chip = lessonDeskChip({ incorporated: row.incorporated, scored, earningsBound });

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
      data-lesson-lane={lane}
      data-incorporated={row.incorporated ? '1' : '0'}
      data-scored={scored ? '1' : undefined}
      data-earnings-bound={earningsBound ? '1' : undefined}
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
        {wait ? <p className="books-lesson-wait">{wait}</p> : null}
        {earningsBound ? <p className="books-lesson-wait">Belief already written. Confidence stays.</p> : null}
        {move ? <p className="books-close-move">{move}</p> : null}
      </span>
      <span className="review-card-meta">
        <span className="thesis-chip">{chip}</span>
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
