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

function beliefLabel(count: number): string {
  const word = count === 1 ? 'belief' : 'beliefs';
  return `${count} ${word} in force`;
}

function lessonsLabel(pulse: LearningPulse): string {
  return `${pulse.lessons_open} open / ${pulse.lessons_incorporated} in playbook`;
}

function taggedLabel(count: number): string {
  const word = count === 1 ? 'tagged lot' : 'tagged lots';
  return `${count} ${word}`;
}

function legacyLabel(count: number): string {
  return `${count} legacy untagged`;
}

function missingLabel(count: number): string {
  const word = count === 1 ? 'missing gate' : 'missing gates';
  return `${count} ${word}`;
}

export type LearningPulseControl =
  | 'count'
  | 'focus_lessons'
  | 'reveal_beliefs'
  | 'open_thesis'
  | 'focus_lots';

export type LearningPulsePart = {
  key: 'to_review' | 'lessons' | 'beliefs' | 'open_books' | 'tagged' | 'legacy' | 'missing';
  text: string;
  control: LearningPulseControl;
  thesisId: string | null;
};

export type LearningPulsePartOptions = {
  /** Distinct thesis ids on tagged live lots. Empty stays a count. */
  taggedThesisIds?: readonly string[];
  /** Roster can open this id. A missing thesis focuses the lot cards. */
  thesisOnRoster?: (thesisId: string) => boolean;
  /** Lessons parchment already lists a lesson. Otherwise the count stays quiet. */
  lessonsOnParchment?: boolean;
};

function taggedControl(pulse: LearningPulse, options: LearningPulsePartOptions) {
  if (pulse.open_books_tagged <= 0) {
    return { control: 'count', thesisId: null } satisfies Pick<LearningPulsePart, 'control' | 'thesisId'>;
  }
  const ids = [...new Set((options.taggedThesisIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const onRoster = options.thesisOnRoster ?? (() => false);
  const only = ids.length === 1 ? ids[0] : undefined;
  if (only && onRoster(only)) {
    return { control: 'open_thesis', thesisId: only } satisfies Pick<LearningPulsePart, 'control' | 'thesisId'>;
  }
  return { control: 'focus_lots', thesisId: null } satisfies Pick<LearningPulsePart, 'control' | 'thesisId'>;
}

/**
 * Same sentence as formatLearningPulse, split so beliefs, lessons, and the
 * tagged lot can be controls. Counts stay counts. Never invents a thesis.
 */
export function learningPulseParts(
  pulse: LearningPulse,
  options: LearningPulsePartOptions = {},
): LearningPulsePart[] {
  const parts: LearningPulsePart[] = [
    { key: 'to_review', text: `${pulse.to_review} to review`, control: 'count', thesisId: null },
    {
      key: 'lessons',
      text: lessonsLabel(pulse),
      control: options.lessonsOnParchment ? 'focus_lessons' : 'count',
      thesisId: null,
    },
    {
      key: 'beliefs',
      text: beliefLabel(pulse.beliefs_in_force),
      control: pulse.beliefs_in_force > 0 ? 'reveal_beliefs' : 'count',
      thesisId: null,
    },
  ];
  if (pulse.open_books <= 0) {
    parts.push({ key: 'open_books', text: 'no open books', control: 'count', thesisId: null });
    return parts;
  }
  const tagged = taggedControl(pulse, options);
  parts.push(
    { key: 'tagged', text: taggedLabel(pulse.open_books_tagged), control: tagged.control, thesisId: tagged.thesisId },
    { key: 'legacy', text: legacyLabel(pulse.open_books_legacy_untagged), control: 'count', thesisId: null },
    { key: 'missing', text: missingLabel(pulse.open_books_missing_gate), control: 'count', thesisId: null },
  );
  return parts;
}

/** One parchment sentence. Queue headers do not repeat these counts. */
export function formatLearningPulse(pulse: LearningPulse): string {
  return learningPulseParts(pulse).map((part) => part.text).join(' · ');
}
