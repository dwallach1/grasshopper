/**
 * Theses learning pulse. Counts already on /api/desk — never invent a score,
 * a lesson, a belief, or a tagged lot. To-review matches the parchment queue
 * (ranked, junk dropped, cap 40), not the grind backlog.
 *
 * Open-book coverage is gate-honest: a live lot with thesis_id is a tagged
 * lot (not a count of theses in the system);
 * a live lot with an explicit untagged reason (historical leftovers,
 * sync_missing_thesis, …) is legacy, not a write-habit miss; only neither
 * is a missing gate.
 */
import { assemblePlaybookRules } from './beliefs';
import { assembleBookHoldings, type BookHolding } from './book-holdings';
import { leanPendingCandidates } from './candidate-review';
import type { DeskPayload } from './ledger-types';

export type LearningPulse = {
  to_review: number;
  lessons_open: number;
  lessons_incorporated: number;
  beliefs_in_force: number;
  open_books: number;
  open_books_tagged: number;
  open_books_gate_ok: number;
  open_books_legacy_untagged: number;
  open_books_missing_gate: number;
};

function liveBookGate(row: Pick<BookHolding, 'thesis_id' | 'untagged'>) {
  const tagged = Boolean(row.thesis_id);
  const untagged = Boolean(row.untagged);
  return {
    tagged,
    gate_ok: tagged || untagged,
    legacy_untagged: !tagged && untagged,
    missing_gate: !tagged && !untagged,
  };
}

export function assembleLearningPulse(desk: DeskPayload): LearningPulse {
  const lessons = desk.lessons ?? [];
  const live = assembleBookHoldings(desk).rows.filter((row) => row.life === 'live');
  const gates = live.map(liveBookGate);
  return {
    to_review: leanPendingCandidates(desk.ontology_candidates ?? []).length,
    lessons_open: lessons.filter((row) => !row.incorporated).length,
    lessons_incorporated: lessons.filter((row) => row.incorporated).length,
    beliefs_in_force: assemblePlaybookRules(desk.beliefs ?? []).length,
    open_books: live.length,
    open_books_tagged: gates.filter((row) => row.tagged).length,
    open_books_gate_ok: gates.filter((row) => row.gate_ok).length,
    open_books_legacy_untagged: gates.filter((row) => row.legacy_untagged).length,
    open_books_missing_gate: gates.filter((row) => row.missing_gate).length,
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
    open_books_gate_ok: pulse.open_books_gate_ok,
    open_books_legacy_untagged: pulse.open_books_legacy_untagged,
    open_books_missing_gate: pulse.open_books_missing_gate,
  };
}

function formatOpenBooks(pulse: LearningPulse): string {
  if (pulse.open_books <= 0) return 'no open books';
  const taggedWord = pulse.open_books_tagged === 1 ? 'tagged lot' : 'tagged lots';
  const missingWord = pulse.open_books_missing_gate === 1 ? 'missing gate' : 'missing gates';
  return [
    `${pulse.open_books_tagged} ${taggedWord}`,
    `${pulse.open_books_legacy_untagged} legacy untagged`,
    `${pulse.open_books_missing_gate} ${missingWord}`,
  ].join(' · ');
}

/** One parchment sentence. Queue headers do not repeat these counts. */
export function formatLearningPulse(pulse: LearningPulse): string {
  const beliefWord = pulse.beliefs_in_force === 1 ? 'belief' : 'beliefs';
  return [
    `${pulse.to_review} to review`,
    `${pulse.lessons_open} open / ${pulse.lessons_incorporated} in playbook`,
    `${pulse.beliefs_in_force} ${beliefWord} in force`,
    formatOpenBooks(pulse),
  ].join(' · ');
}
