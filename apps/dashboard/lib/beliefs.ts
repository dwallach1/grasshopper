/**
 * Lean belief_updates on the desk. Playbook rules are meta.kind = playbook_rule.
 * A slug stays in force on the newest belief that lists it for that thesis and
 * domain. A later kill or negative_result lesson does not retire older process
 * slugs. Never invent a rule or a close lesson.
 */
import { z } from 'zod';

import { asOptionalNumber, requireIso } from './numbers';
import type { DeskPayload, DeskTeamPayload, LessonRow, ThesisRow } from './ledger-types';
import type { JsonObjectRow } from './ledger-map';

export const PLAYBOOK_RULE_KIND = 'playbook_rule';
export const BELIEF_RATIONALE_CAP = 180;
/**
 * Process and structure slugs on a lot. `kill` and `negative_result` append
 * after this cap so an autopsy lesson cannot be the only rule in force.
 */
export const RULES_IN_FORCE_CAP = 8;
export const BELIEF_TRAIL_CAP = 8;

/** Incorporated walk-forward outcomes. Real learning; not standing process. */
const AUTOPSY_OUTCOME_SLUGS = new Set(['kill', 'negative_result']);

export type BeliefUpdateRow = {
  id: string;
  thesis_id: string;
  domain_id: string | null;
  agent_id: string | null;
  prior_confidence: number | null;
  new_confidence: number | null;
  rationale: string;
  observed_at: string;
  kind: string;
  rules: string[];
  steward: string | null;
  research_lesson_id: string | null;
};

export type PlaybookRule = {
  id: string;
  thesis_id: string;
  domain_id: string | null;
  steward: string | null;
  rules: string[];
  rationale: string;
  observed_at: string;
  prior_confidence: number | null;
  new_confidence: number | null;
  research_lesson_id: string | null;
};

export type ClipBeliefNote = {
  key: string;
  summary: string;
};

/** Closed-clip feedback. `belief` is set only when a lesson and a playbook rule both exist. */
export type ClipNote = {
  key: string;
  kind: 'lesson' | 'belief';
  summary: string;
  belief: ClipBeliefNote | null;
};

const OptionalText = z.union([z.string(), z.null()]).transform((value) => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
});

const Confidence = z
  .union([z.string(), z.number(), z.null()])
  .transform((value) => asOptionalNumber(value, 'belief.confidence'));

const BeliefSchema = z
  .object({
    id: z.string(),
    thesis_id: z.string(),
    domain_id: OptionalText,
    agent_id: OptionalText,
    prior_confidence: Confidence,
    new_confidence: Confidence,
    rationale: z.string().default(''),
    observed_at: z.union([z.string(), z.date()]),
    meta: z.unknown().optional(),
  })
  .passthrough();

export function truncateRationale(text: string, cap = BELIEF_RATIONALE_CAP): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap).trimEnd()}…`;
}

export function humanizeRule(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isPlaybookRule(row: Pick<BeliefUpdateRow, 'kind'>): boolean {
  return row.kind.trim().toLowerCase() === PLAYBOOK_RULE_KIND;
}

export function mapBeliefs(rows: JsonObjectRow[]): BeliefUpdateRow[] {
  return z.array(BeliefSchema).parse(rows).map((row) => {
    const meta = asMeta(row.meta);
    return {
      id: row.id,
      thesis_id: row.thesis_id,
      domain_id: row.domain_id,
      agent_id: row.agent_id,
      prior_confidence: row.prior_confidence,
      new_confidence: row.new_confidence,
      rationale: row.rationale,
      observed_at: requireIso(row.observed_at, 'belief.observed_at'),
      kind: textField(meta.kind) || 'belief',
      rules: stringList(meta.rules),
      steward: textField(meta.steward),
      research_lesson_id: lessonId(meta.research_lesson_id),
    };
  });
}

/**
 * Playbook beliefs that still own a slug. Each slug is kept on the newest
 * playbook_rule for that thesis + domain that lists it. A newer row wins only
 * the slugs it repeats.
 */
export function assemblePlaybookRules(beliefs: readonly BeliefUpdateRow[]): PlaybookRule[] {
  const newestBySlug = new Map<string, BeliefUpdateRow>();
  for (const row of beliefs) {
    if (!isPlaybookRule(row)) continue;
    for (const slug of row.rules) {
      const key = slugKey(row, slug);
      const current = newestBySlug.get(key);
      if (!current || newerBelief(row, current)) newestBySlug.set(key, row);
    }
  }

  const byId = new Map<string, BeliefUpdateRow>();
  for (const row of newestBySlug.values()) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }

  return [...byId.values()]
    .sort(compareBeliefs)
    .map((row) => toPlaybookRule(row, ownedSlugs(row, newestBySlug)));
}

export function beliefTrailFor(
  thesisId: string,
  beliefs: readonly BeliefUpdateRow[],
  cap = BELIEF_TRAIL_CAP,
): BeliefUpdateRow[] {
  return beliefs
    .filter((row) => row.thesis_id === thesisId)
    .slice()
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at) || b.id.localeCompare(a.id))
    .slice(0, cap)
    .map((row) => ({ ...row, rationale: truncateRationale(row.rationale) }));
}

export function rulesInForceFor(input: {
  thesisId: string | null;
  domainId: string | null;
  beliefs: readonly BeliefUpdateRow[];
  cap?: number;
}): string[] {
  const cap = input.cap ?? RULES_IN_FORCE_CAP;
  const rules = assemblePlaybookRules(input.beliefs);
  const matched = input.thesisId
    ? rules.filter((row) => row.thesis_id === input.thesisId)
    : input.domainId
      ? rules.filter((row) => row.domain_id === input.domainId)
      : [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const row of matched) {
    for (const slug of row.rules) {
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      ordered.push(slug);
    }
  }
  const process = ordered.filter((slug) => !isAutopsyOutcomeSlug(slug));
  const outcomes = ordered.filter((slug) => isAutopsyOutcomeSlug(slug));
  return [...process.slice(0, Math.max(0, cap)), ...outcomes];
}

export function clipNoteFor(input: {
  thesisId: string | null;
  beliefs?: readonly BeliefUpdateRow[];
  lessons?: readonly LessonRow[];
}): ClipNote | null {
  const thesisId = input.thesisId;
  if (!thesisId) return null;
  const lesson = (input.lessons ?? [])
    .filter((row) => row.thesis_id === thesisId)
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
  const beliefs = (input.beliefs ?? [])
    .filter((row) => row.thesis_id === thesisId)
    .slice()
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at) || b.id.localeCompare(a.id));
  if (!lesson) {
    const belief = beliefs[0];
    const summary = belief ? truncateRationale(belief.rationale) : '';
    if (!belief || !summary) return null;
    return {
      key: `belief:${belief.id}`,
      kind: 'belief',
      summary,
      belief: null,
    };
  }
  const summary = truncateRationale(lesson.summary);
  const playbook = beliefs.filter(isPlaybookRule);
  const lessonKey = String(lesson.id);
  const linked = playbook.find((row) => row.research_lesson_id === lessonKey) ?? null;
  // Link wins. When it is missing, the newest playbook rule still sits beside the lesson.
  const companion = linked ?? playbook[0] ?? null;
  const belief = companion ? clipBelief(companion) : null;
  if (!summary && !belief) return null;
  if (!summary && belief) {
    return {
      key: belief.key,
      kind: 'belief',
      summary: belief.summary,
      belief: null,
    };
  }
  return {
    key: `lesson:${lesson.id}`,
    kind: 'lesson',
    summary,
    belief,
  };
}

export function domainIdForSteward(
  team: DeskTeamPayload | undefined,
  slug: string,
): string | null {
  const domains = team?.domains ?? [];
  const wanted = slug === 'oddsborne' ? 'prediction' : slug === 'bandit' ? 'meme' : 'equity';
  const match = domains.find((row) => row.slug === wanted)
    ?? domains.find((row) => row.slug === slug);
  return match?.id ?? null;
}

export function thesisForHolding(
  theses: readonly ThesisRow[],
  input: { symbol: string; thesisId?: string | null },
): { id: string; name: string } | null {
  if (input.thesisId) {
    const named = theses.find((row) => row.id === input.thesisId);
    if (named) return { id: named.id, name: named.name };
    return { id: input.thesisId, name: input.thesisId };
  }
  const symbol = input.symbol.trim();
  if (!symbol) return null;
  const held = theses.find((row) => row.lots.some((lot) => lot.symbol === symbol));
  if (held) return { id: held.id, name: held.name };
  const listed = theses.find((row) => row.symbols.includes(symbol));
  return listed ? { id: listed.id, name: listed.name } : null;
}

export function beliefsFromDesk(desk: Pick<DeskPayload, 'beliefs'>): BeliefUpdateRow[] {
  return desk.beliefs ?? [];
}

function clipBelief(row: BeliefUpdateRow): ClipBeliefNote | null {
  const summary = truncateRationale(row.rationale);
  if (!summary) return null;
  return { key: `belief:${row.id}`, summary };
}

function newerBelief(next: BeliefUpdateRow, current: BeliefUpdateRow): boolean {
  return next.observed_at.localeCompare(current.observed_at) > 0
    || (next.observed_at === current.observed_at && next.id.localeCompare(current.id) > 0);
}

function compareBeliefs(a: BeliefUpdateRow, b: BeliefUpdateRow): number {
  return b.observed_at.localeCompare(a.observed_at)
    || a.thesis_id.localeCompare(b.thesis_id)
    || a.id.localeCompare(b.id);
}

function slugKey(row: Pick<BeliefUpdateRow, 'thesis_id' | 'domain_id'>, slug: string): string {
  return `${row.thesis_id}\0${row.domain_id ?? ''}\0${slug}`;
}

function ownedSlugs(
  row: BeliefUpdateRow,
  newestBySlug: ReadonlyMap<string, BeliefUpdateRow>,
): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const slug of row.rules) {
    if (!slug || seen.has(slug)) continue;
    if (newestBySlug.get(slugKey(row, slug))?.id !== row.id) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

function toPlaybookRule(row: BeliefUpdateRow, rules: string[]): PlaybookRule {
  return {
    id: row.id,
    thesis_id: row.thesis_id,
    domain_id: row.domain_id,
    steward: row.steward,
    rules,
    rationale: truncateRationale(row.rationale),
    observed_at: row.observed_at,
    prior_confidence: row.prior_confidence,
    new_confidence: row.new_confidence,
    research_lesson_id: row.research_lesson_id,
  };
}

function isAutopsyOutcomeSlug(slug: string): boolean {
  return AUTOPSY_OUTCOME_SLUGS.has(slug.trim().toLowerCase());
}

function asMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function lessonId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return textField(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}
