/**
 * Phone Theses surface. Ledger theses as a parchment list — not a 3D world.
 * No Book/Board marks, NAV, or win rate on the lot.
 */
import { AVATAR_COLORS } from './desk-team';
import type { DeskVenue } from './desk-venue';
import { rowVenue } from './desk-venue';
import type {
  DeskPayload,
  OntologyThemeRow,
  ThesisEvidenceRow,
  ThesisRow,
} from './ledger-types';
import { stewardIdCards } from './steward-id';
import { isLiveThesis } from './thesis-status';
import type { ThesisStatus } from './thesis-status';

export { isLiveThesis, LIVE_THESIS_STATUSES } from './thesis-status';

export type ThesisEvidenceNote = {
  id: number;
  direction: string;
  evidence_type: string;
  summary: string;
  confidence: number;
  created_at: string;
};

export type ThesisRosterRow = {
  id: string;
  name: string;
  summary: string;
  falsifier: string | null;
  stance: string;
  status: ThesisStatus;
  confidence: number;
  domain: string;
  steward: string;
  steward_name: string;
  accent: string;
  venue: DeskVenue;
  live: boolean;
  evidence: ThesisEvidenceNote[];
};

export type ThesisRoster = {
  rows: ThesisRosterRow[];
};

const EVIDENCE_CAP = 8;

export function thesisStewardSlug(venues: readonly DeskVenue[] | undefined): string {
  const venue = venues?.[0] ?? 'equity';
  if (venue === 'prediction') return 'oddsborne';
  if (venue === 'meme') return 'bandit';
  return 'quantanamo';
}

export function thesisVenue(venues: readonly DeskVenue[] | undefined): DeskVenue {
  return venues?.[0] ?? 'equity';
}

export function thesisStewardName(slug: string): string {
  if (slug === 'oddsborne') return 'ODDSBORNE';
  if (slug === 'bandit') return 'BANDIT';
  return 'QUANTANAMO';
}

export function thesisStewardAccent(
  venues: readonly DeskVenue[] | undefined,
  desk?: Pick<DeskPayload, 'team'>,
): string {
  const slug = thesisStewardSlug(venues);
  if (desk) {
    const card = stewardIdCards(desk).find((row) => row.slug === slug);
    if (card?.accent) return card.accent;
  }
  if (slug === 'oddsborne') return AVATAR_COLORS.blue;
  if (slug === 'bandit') return AVATAR_COLORS.red;
  return AVATAR_COLORS.green;
}

export function thesisDomainLabel(
  thesis: Pick<ThesisRow, 'id' | 'venues' | 'lots'>,
  themes: readonly OntologyThemeRow[] = [],
): string {
  const match = themes
    .filter((row) => row.kind === 'theme' && row.status === 'active')
    .find((theme) => thesisBelongsToTheme(theme, thesis));
  if (match?.name.trim()) return match.name.trim();
  const slug = thesisStewardSlug(thesisVenues(thesis));
  if (slug === 'oddsborne') return 'Predictions';
  if (slug === 'bandit') return 'Coins';
  return 'Stocks';
}

export function thesisForId(
  roster: readonly ThesisRosterRow[],
  thesisId: string,
): ThesisRosterRow | undefined {
  return roster.find((row) => row.id === thesisId);
}

export function assembleThesisRoster(
  desk: Pick<DeskPayload, 'theses' | 'ontology_themes' | 'team' | 'evidence'>,
): ThesisRoster {
  const themes = desk.ontology_themes ?? [];
  const evidence = desk.evidence ?? [];
  const rows = (desk.theses ?? [])
    .map((thesis) => rowFrom(thesis, themes, evidence, desk))
    .sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { rows };
}

function thesisVenues(thesis: Pick<ThesisRow, 'venues' | 'lots'>): DeskVenue[] {
  if (thesis.venues?.length) return [...thesis.venues];
  if (thesis.lots.length) return [rowVenue(thesis.lots[0]!)];
  return ['equity'];
}

function thesisBelongsToTheme(
  theme: Pick<OntologyThemeRow, 'id' | 'thesis_id'>,
  thesis: Pick<ThesisRow, 'id'>,
): boolean {
  if (theme.thesis_id && theme.thesis_id === thesis.id) return true;
  if (theme.id === thesis.id) return true;
  return thesis.id.startsWith(`${theme.id}_`);
}

function evidenceFor(
  thesisId: string,
  rows: readonly ThesisEvidenceRow[],
): ThesisEvidenceNote[] {
  return rows
    .filter((row) => row.thesis_id === thesisId)
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    .slice(0, EVIDENCE_CAP)
    .map((row) => ({
      id: row.id,
      direction: row.direction,
      evidence_type: row.evidence_type,
      summary: row.summary,
      confidence: row.confidence,
      created_at: row.created_at,
    }));
}

function rowFrom(
  thesis: ThesisRow,
  themes: readonly OntologyThemeRow[],
  evidence: readonly ThesisEvidenceRow[],
  desk?: Pick<DeskPayload, 'team'>,
): ThesisRosterRow {
  const venues = thesisVenues(thesis);
  const slug = thesisStewardSlug(venues);
  const card = desk ? stewardIdCards(desk).find((row) => row.slug === slug) : undefined;
  return {
    id: thesis.id,
    name: thesis.name,
    summary: thesis.summary,
    falsifier: thesis.falsifier,
    stance: thesis.stance,
    status: thesis.status,
    confidence: thesis.confidence,
    domain: thesisDomainLabel(thesis, themes),
    steward: slug,
    steward_name: card?.display_name ?? thesisStewardName(slug),
    accent: thesisStewardAccent(venues, desk),
    venue: thesisVenue(venues),
    live: isLiveThesis(thesis),
    evidence: evidenceFor(thesis.id, evidence),
  };
}
