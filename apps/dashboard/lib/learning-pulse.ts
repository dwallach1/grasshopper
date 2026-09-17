/**
 * Theses learning pulse. Counts already on /api/desk — never invent a score,
 * a lesson, a belief, or a tagged lot. To-review matches the parchment queue
 * (ranked, junk dropped, cap 40), not the grind backlog.
 */
import { assemblePlaybookRules } from './beliefs';
import { assembleBookHoldings } from './book-holdings';
import { leanPendingCandidates } from './candidate-review';
import type { DeskPayload } from './ledger-types';

export type LearningPulse = {
  to_review: number;
  lessons_open: number;
  lessons_incorporated: number;
  beliefs_in_force: number;
  open_books: number;
  open_books_tagged: number;
};

export function assembleLearningPulse(desk: DeskPayload): LearningPulse {
  const lessons = desk.lessons ?? [];
  const live = assembleBookHoldings(desk).rows.filter((row) => row.life === 'live');
  return {
    to_review: leanPendingCandidates(desk.ontology_candidates ?? []).length,
    lessons_open: lessons.filter((row) => !row.incorporated).length,
    lessons_incorporated: lessons.filter((row) => row.incorporated).length,
    beliefs_in_force: assemblePlaybookRules(desk.beliefs ?? []).length,
    open_books: live.length,
    open_books_tagged: live.filter((row) => Boolean(row.thesis_id)).length,
  };
}

export function learningPulseSummary(pulse: LearningPulse): LearningPulse {
  return {
    to_review: pulse.to_review,
    lessons_open: pulse.lessons_open,
    lessons_incorporated: pulse.lessons_incorporated,
    beliefs_in_force: pulse.beliefs_in_force,
    open_books: pulse.open_books,
    open_books_tagged: pulse.open_books_tagged,
  };
}

/** One parchment sentence. Queue headers do not repeat these counts. */
export function formatLearningPulse(pulse: LearningPulse): string {
  const beliefWord = pulse.beliefs_in_force === 1 ? 'belief' : 'beliefs';
  const books = pulse.open_books > 0
    ? `${pulse.open_books_tagged} of ${pulse.open_books} open books tagged`
    : 'no open books';
  return [
    `${pulse.to_review} to review`,
    `${pulse.lessons_open} open / ${pulse.lessons_incorporated} in playbook`,
    `${pulse.beliefs_in_force} ${beliefWord} in force`,
    books,
  ].join(' · ');
}
