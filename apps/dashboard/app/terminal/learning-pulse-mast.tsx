'use client';

import { Fragment, useMemo, useState } from 'react';

import { humanizeRule } from '../../lib/beliefs';
import type { DeskPayload } from '../../lib/ledger-types';
import { rankLessonsForDesk } from '../../lib/lesson-incorporate';
import { assembleBeliefsInForce, assembleTaggedLots } from '../../lib/learning-inspect';
import {
  assembleLearningPulse,
  formatLearningPulse,
  learningPulseParts,
  type LearningPulsePart,
} from '../../lib/learning-pulse';
import { assembleThesisRoster, thesisForId } from '../../lib/thesis-roster';

export function LearningPulseMast({
  desk,
  reduceMotion = false,
  onOpenThesis,
}: {
  desk: DeskPayload;
  reduceMotion?: boolean;
  onOpenThesis: (thesisId: string) => void;
}) {
  const pulse = useMemo(() => assembleLearningPulse(desk), [desk]);
  const beliefs = useMemo(() => assembleBeliefsInForce(desk), [desk]);
  const roster = useMemo(() => assembleThesisRoster(desk).rows, [desk]);
  const parts = useMemo(() => learningPulseParts(pulse, {
    taggedThesisIds: assembleTaggedLots(desk).map((row) => row.thesis_id),
    thesisOnRoster: (id) => Boolean(thesisForId(roster, id)),
    lessonsOnParchment: rankLessonsForDesk(desk.lessons ?? []).length > 0,
  }), [desk, pulse, roster]);
  const [beliefsOpen, setBeliefsOpen] = useState(false);

  function focusParchment(selector: string) {
    const root = document.querySelector('.thesis-world');
    if (!root) return;
    for (const node of root.querySelectorAll('.is-pulse-target')) {
      node.classList.remove('is-pulse-target');
    }
    const target = root.querySelector<HTMLElement>(selector);
    if (!target) return;
    target.classList.add('is-pulse-target');
    target.scrollIntoView({
      block: 'nearest',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
    target.focus({ preventScroll: true });
  }

  function onPart(part: LearningPulsePart) {
    if (part.control === 'reveal_beliefs') {
      setBeliefsOpen((open) => !open);
      return;
    }
    if (part.control === 'focus_lessons') {
      focusParchment('#lessons-parchment');
      return;
    }
    if (part.control === 'focus_lots') {
      focusParchment('#tagged-lots');
      return;
    }
    if (part.control === 'open_thesis' && part.thesisId) onOpenThesis(part.thesisId);
  }

  return (
    <div className="learning-pulse" aria-label="Learning loop">
      <p className="visually-hidden">{formatLearningPulse(pulse)}</p>
      <p className="learning-pulse-line">
        {parts.map((part, index) => (
          <Fragment key={part.key}>
            {index > 0 ? <span className="learning-pulse-sep" aria-hidden="true">{' · '}</span> : null}
            {part.control === 'count' ? (
              <span aria-hidden="true">{part.text}</span>
            ) : (
              <button
                type="button"
                className="learning-pulse-chip"
                data-pulse-beliefs={part.control === 'reveal_beliefs' ? '1' : undefined}
                data-pulse-lessons={part.control === 'focus_lessons' ? '1' : undefined}
                data-pulse-lots={part.control === 'focus_lots' ? '1' : undefined}
                data-pulse-thesis={part.control === 'open_thesis' ? part.thesisId ?? undefined : undefined}
                aria-expanded={part.control === 'reveal_beliefs' ? beliefsOpen : undefined}
                aria-controls={part.control === 'reveal_beliefs' ? 'learning-pulse-beliefs' : undefined}
                onClick={() => onPart(part)}
              >
                {part.text}
              </button>
            )}
          </Fragment>
        ))}
      </p>
      {beliefsOpen && beliefs.length ? (
        <ul id="learning-pulse-beliefs" className="learning-pulse-beliefs" aria-label="Beliefs in force">
          {beliefs.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="learning-pulse-belief"
                data-pulse-belief={row.id}
                data-thesis={row.thesis_id}
                onClick={() => onOpenThesis(row.thesis_id)}
              >
                <b>{row.thesis_name}</b>
                {row.rules.length ? <i>{row.rules.map(humanizeRule).join(' · ')}</i> : null}
                {row.rationale ? <p>{row.rationale}</p> : null}
                {row.from_lesson ? <span className="thesis-chip">from lesson</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
