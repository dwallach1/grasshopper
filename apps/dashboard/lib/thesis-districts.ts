/**
 * Phone Theses world. A district is a live ontology theme (or an orphan thesis).
 * Buildings are theses. No invented themes, no Book/Board stats on the lot.
 */
import { AVATAR_COLORS } from './desk-team';
import type { DeskVenue } from './desk-venue';
import { rowVenue } from './desk-venue';
import type { DeskPayload, OntologyThemeRow, ThesisRow } from './ledger-types';
import { stewardIdCards } from './steward-id';

export const LIVE_THESIS_STATUSES = ['forming', 'hardening'] as const;

export const DISTRICT_PLACES = ['campus', 'plant', 'hangar', 'lab', 'yard'] as const;
export type ThesisDistrictPlace = (typeof DISTRICT_PLACES)[number];

export type ThesisBuilding = {
  id: string;
  name: string;
  summary: string;
  falsifier: string | null;
  accent: string;
  steward: string;
};

export type ThesisDistrict = {
  id: string;
  name: string;
  description: string;
  source: 'theme' | 'thesis';
  place: ThesisDistrictPlace;
  buildings: ThesisBuilding[];
};

const LIVE = new Set<string>(LIVE_THESIS_STATUSES);

export function isLiveThesisStatus(status: string): boolean {
  return LIVE.has(status);
}

export function isLiveThesis(row: Pick<ThesisRow, 'status'>): boolean {
  return isLiveThesisStatus(row.status);
}

/** Massing only — tokens come from real theme/thesis ids and names. */
export function districtPlace(id: string, name = ''): ThesisDistrictPlace {
  const hay = `${id} ${name}`.toLowerCase();
  if (/\bneocloud\b|gpu compute|data[- ]center/.test(hay)) return 'campus';
  if (/\bnuclear\b|\bpower\b|\benergy\b|\bgrid\b/.test(hay)) return 'plant';
  if (/\bdefense\b|\bdrone\b|\bspace\b/.test(hay)) return 'hangar';
  if (/\bquantum\b|\bsoftware\b|\bbiotech\b|\bapp|\bphotonics\b|\bsemis\b|\bsemiconductor/.test(hay)) {
    return 'lab';
  }
  return 'yard';
}

export function thesisStewardSlug(venues: readonly DeskVenue[] | undefined): string {
  const venue = venues?.[0] ?? 'equity';
  if (venue === 'prediction') return 'oddsborne';
  if (venue === 'meme') return 'bandit';
  return 'quantanamo';
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

function buildingFrom(thesis: ThesisRow, desk?: Pick<DeskPayload, 'team'>): ThesisBuilding {
  const venues = thesis.venues?.length
    ? thesis.venues
    : thesis.lots.length
      ? [rowVenue(thesis.lots[0]!)]
      : (['equity'] as const);
  return {
    id: thesis.id,
    name: thesis.name,
    summary: thesis.summary,
    falsifier: thesis.falsifier,
    accent: thesisStewardAccent(venues, desk),
    steward: thesisStewardSlug(venues),
  };
}

function themeThesis(
  theme: OntologyThemeRow,
  liveById: Map<string, ThesisRow>,
): ThesisRow | undefined {
  if (theme.thesis_id) {
    const linked = liveById.get(theme.thesis_id);
    if (linked) return linked;
  }
  return liveById.get(theme.id);
}

/**
 * Districts from live `kind=theme` rows that still have a live thesis.
 * An orphan live thesis (no theme) is its own small district — thesis name,
 * not a made-up theme. Concepts without a thesis do not become empty cities.
 */
export function assembleThesisDistricts(
  desk: Pick<DeskPayload, 'theses' | 'ontology_themes' | 'team'>,
): ThesisDistrict[] {
  const live = (desk.theses ?? []).filter(isLiveThesis);
  const liveById = new Map(live.map((row) => [row.id, row]));
  const claimed = new Set<string>();
  const districts: ThesisDistrict[] = [];

  const themes = (desk.ontology_themes ?? [])
    .filter((row) => row.kind === 'theme' && row.status === 'active')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  for (const theme of themes) {
    const thesis = themeThesis(theme, liveById);
    if (!thesis) continue;
    claimed.add(thesis.id);
    districts.push({
      id: theme.id,
      name: theme.name,
      description: theme.description,
      source: 'theme',
      place: districtPlace(theme.id, theme.name),
      buildings: [buildingFrom(thesis, desk)],
    });
  }

  const orphans = live
    .filter((row) => !claimed.has(row.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  for (const thesis of orphans) {
    districts.push({
      id: thesis.id,
      name: thesis.name,
      description: '',
      source: 'thesis',
      place: districtPlace(thesis.id, thesis.name),
      buildings: [buildingFrom(thesis, desk)],
    });
  }

  return districts;
}

export function districtForThesis(
  districts: readonly ThesisDistrict[],
  thesisId: string,
): ThesisDistrict | undefined {
  return districts.find((row) => row.buildings.some((building) => building.id === thesisId));
}

export function buildingForThesis(
  districts: readonly ThesisDistrict[],
  thesisId: string,
): ThesisBuilding | undefined {
  for (const district of districts) {
    const hit = district.buildings.find((building) => building.id === thesisId);
    if (hit) return hit;
  }
  return undefined;
}
