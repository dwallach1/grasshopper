import {
  PUBLIC_CANDIDATE_CAP,
  publicPendingCandidates,
} from '@quantanamo/contracts/desk-snapshot';

import type { OntologyCandidateRow, OntologyThemeRow, ThesisRow } from './ledger-types';
import { isLiveThesis } from './thesis-status';

export const REVIEW_QUEUE_CAP = PUBLIC_CANDIDATE_CAP;
export {
  isJunkOntologyLabel,
  ONTOLOGY_JUNK_LABELS,
  PUBLIC_CANDIDATE_FETCH,
} from '@quantanamo/contracts/desk-snapshot';
export const REVIEW_ACTIONS = ['promote', 'reject', 'merge'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export type ReviewRequest = {
  candidate_id: number;
  action: ReviewAction;
  thesis_id: string | null;
  note: string | null;
};

export type ReviewResult = {
  ok: boolean;
  action: ReviewAction;
  candidate_id: number;
  status: string;
  thesis_id: string | null;
  theme_id: string | null;
  linked_existing_thesis: boolean;
  created_thesis_stub: boolean;
};

/** Pending only. Membership / real theme first, then ledger score. Drops deny-list junk. */
export function leanPendingCandidates(
  rows: readonly OntologyCandidateRow[],
  cap = REVIEW_QUEUE_CAP,
): OntologyCandidateRow[] {
  return publicPendingCandidates(rows, cap) as OntologyCandidateRow[];
}

export function liveThesesForLink(theses: readonly ThesisRow[]): ThesisRow[] {
  return theses
    .filter((row) => isLiveThesis(row))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Unlinked concept theme → sibling theme whose thesis already exists.
 * `ontology_themes.thesis_id` is UNIQUE, so the concept cannot bind that
 * thesis. Keep in sync with `private.ontology_theme_thesis_alias`.
 */
export const ONTOLOGY_THEME_THESIS_ALIASES = {
  neocloud: 'neocloud_compute',
  nuclear: 'ai_power_nuclear',
  ai_power: 'ai_power_nuclear',
  photonics: 'semis_photonics',
  crypto_ai: 'crypto',
  earnings_events: 'earnings_gap_structure',
} as const;

/** Concept themes with no live sibling — leave for a human. Do not invent. */
export const ONTOLOGY_THEME_THESIS_UNALIASED = ['ipo_events'] as const;

export function ontologyThemeThesisAlias(themeId: string | null | undefined): string | null {
  const id = String(themeId ?? '').trim();
  if (!id) return null;
  if ((ONTOLOGY_THEME_THESIS_UNALIASED as readonly string[]).includes(id)) return null;
  return ONTOLOGY_THEME_THESIS_ALIASES[id as keyof typeof ONTOLOGY_THEME_THESIS_ALIASES] ?? null;
}

function thesisIdFromTheme(
  theme: Pick<OntologyThemeRow, 'id' | 'thesis_id'> | undefined,
  liveIds: ReadonlySet<string>,
): string | null {
  if (!theme) return null;
  if (theme.thesis_id && liveIds.has(theme.thesis_id)) return theme.thesis_id;
  if (liveIds.has(theme.id)) return theme.id;
  return null;
}

/** Prefer an existing thesis already bound to the proposed theme. Never invents an id. */
export function suggestedThesisId(
  candidate: Pick<OntologyCandidateRow, 'proposed_theme_id' | 'proposed_label'>,
  themes: readonly OntologyThemeRow[],
  theses: readonly ThesisRow[],
): string | null {
  const ids = new Set(theses.map((row) => row.id));
  const theme = themes.find((row) => row.id === candidate.proposed_theme_id);
  const bound = thesisIdFromTheme(theme, ids);
  if (bound) return bound;
  const alias = ontologyThemeThesisAlias(candidate.proposed_theme_id);
  if (alias) {
    const aliased = thesisIdFromTheme(themes.find((row) => row.id === alias), ids);
    if (aliased) return aliased;
    if (ids.has(alias)) return alias;
  }
  const label = candidate.proposed_label.trim().toLowerCase();
  if (!label) return null;
  const named = theses.find((row) => row.name.trim().toLowerCase() === label || row.id === label);
  return named?.id ?? null;
}

/** Calm parchment line for membership/theme that already maps to a live thesis. */
export function reviewThesisHint(
  candidate: Pick<OntologyCandidateRow, 'candidate_type' | 'proposed_theme_id' | 'proposed_label'>,
  themes: readonly OntologyThemeRow[],
  theses: readonly ThesisRow[],
): string | null {
  if (candidate.candidate_type !== 'membership' && candidate.candidate_type !== 'theme') return null;
  const suggested = suggestedThesisId(candidate, themes, theses);
  if (!suggested) return null;
  const name = theses.find((row) => row.id === suggested)?.name;
  if (!name) return null;
  const theme = themes.find((row) => row.id === candidate.proposed_theme_id);
  if (theme && !theme.thesis_id) return `Unlinked concept · fits ${name}`;
  return `Fits ${name}`;
}

export function parseReviewRequest(value: unknown): ReviewRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const candidateId = Number(row.candidate_id);
  if (!Number.isInteger(candidateId) || candidateId <= 0) return null;
  const action = typeof row.action === 'string' ? row.action.trim().toLowerCase() : '';
  if (!REVIEW_ACTIONS.includes(action as ReviewAction)) return null;
  const thesis = typeof row.thesis_id === 'string' ? row.thesis_id.trim() : '';
  const note = typeof row.note === 'string' ? row.note.trim() : '';
  return {
    candidate_id: candidateId,
    action: action as ReviewAction,
    thesis_id: thesis || null,
    note: note || null,
  };
}

export function reviewHttpError(message: string): { status: number; error: string } {
  if (message.includes('not_operator')) {
    return { status: 403, error: 'This account is not on the operator allowlist' };
  }
  if (message.includes('candidate_not_found')) {
    return { status: 404, error: 'Candidate not in ledger' };
  }
  if (message.includes('candidate_not_pending')) {
    return { status: 409, error: 'Candidate is not pending' };
  }
  if (message.includes('thesis_required')) {
    return { status: 400, error: 'Pick an existing thesis to merge' };
  }
  if (message.includes('thesis_not_found')) {
    return { status: 404, error: 'Thesis not in ledger' };
  }
  if (message.includes('symbol_not_in_ledger')) {
    return { status: 400, error: 'Symbol not in ledger' };
  }
  if (message.includes('term_not_vocabulary')) {
    return { status: 400, error: 'Term is not vocabulary' };
  }
  if (message.includes('theme_required')) {
    return { status: 400, error: 'Theme not in ledger' };
  }
  return { status: 400, error: 'Review failed' };
}

export async function reviewOntologyCandidate(input: ReviewRequest): Promise<ReviewResult> {
  const response = await fetch('/api/ontology/review', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : 'Review failed';
    throw new Error(error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Review failed');
  }
  const row = parsed as Record<string, unknown>;
  if (row.ok !== true) throw new Error('Review failed');
  const action = String(row.action ?? '');
  if (!REVIEW_ACTIONS.includes(action as ReviewAction)) throw new Error('Review failed');
  return {
    ok: true,
    action: action as ReviewAction,
    candidate_id: Number(row.candidate_id),
    status: String(row.status ?? ''),
    thesis_id: typeof row.thesis_id === 'string' ? row.thesis_id : null,
    theme_id: typeof row.theme_id === 'string' ? row.theme_id : null,
    linked_existing_thesis: row.linked_existing_thesis === true,
    created_thesis_stub: row.created_thesis_stub === true,
  };
}
