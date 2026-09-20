/**
 * Inspectable Theses learning rows. Same /api/desk arrays the pulse counts —
 * playbook beliefs in force and open lots that carry a thesis tag.
 * Lesson summaries already on the Lessons parchment are not repeated here.
 */
import {
  assemblePlaybookRules,
  thesisForHolding,
  truncateRationale,
  type PlaybookRule,
} from './beliefs';
import { assembleBookHoldings, type BookHolding } from './book-holdings';
import type { DeskPayload, LessonRow } from './ledger-types';
import { rankLessonsForDesk } from './lesson-incorporate';

export type BoundHolding = {
  id: string;
  name: string;
};

export type BeliefInForceCard = {
  id: string;
  thesis_id: string;
  thesis_name: string;
  rules: string[];
  rationale: string | null;
  from_lesson: boolean;
  observed_at: string;
  steward: string | null;
  holdings: BoundHolding[];
};

export type TaggedLotCard = {
  id: string;
  name: string;
  thesis_id: string;
  thesis_name: string;
};

export function assembleBeliefsInForce(desk: DeskPayload): BeliefInForceCard[] {
  const listed = rankLessonsForDesk(desk.lessons ?? []);
  const listedById = new Map(listed.map((row) => [String(row.id), row]));
  const live = assembleBookHoldings(desk).rows.filter((row) => row.life === 'live');
  return assemblePlaybookRules(desk.beliefs ?? []).map((rule) => {
    const thesis = thesisForHolding(desk.theses ?? [], {
      symbol: '',
      thesisId: rule.thesis_id,
    });
    const listedLesson = lessonListedFor(rule, listed, listedById);
    return {
      id: rule.id,
      thesis_id: rule.thesis_id,
      thesis_name: thesis?.name ?? rule.thesis_id,
      rules: rule.rules,
      rationale: listedLesson ? null : rule.rationale,
      from_lesson: Boolean(listedLesson),
      observed_at: rule.observed_at,
      steward: rule.steward,
      holdings: holdingsForThesis(live, rule.thesis_id),
    };
  });
}

export function assembleTaggedLots(desk: DeskPayload): TaggedLotCard[] {
  return assembleBookHoldings(desk).rows
    .filter((row): row is BookHolding & { thesis_id: string } => (
      row.life === 'live' && Boolean(row.thesis_id)
    ))
    .map((row) => ({
      id: row.id,
      name: row.name,
      thesis_id: row.thesis_id,
      thesis_name: row.thesis_name?.trim() || row.thesis_id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function lessonListedFor(
  rule: PlaybookRule,
  listed: readonly LessonRow[],
  listedById: ReadonlyMap<string, LessonRow>,
): LessonRow | null {
  if (rule.research_lesson_id) {
    const linked = listedById.get(rule.research_lesson_id);
    if (linked) return linked;
  }
  const rationale = truncateRationale(rule.rationale);
  if (!rationale) return null;
  return listed.find((row) => (
    row.thesis_id === rule.thesis_id
    && truncateRationale(row.summary) === rationale
  )) ?? null;
}

function holdingsForThesis(
  live: readonly BookHolding[],
  thesisId: string,
): BoundHolding[] {
  return live
    .filter((row) => row.thesis_id === thesisId)
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
