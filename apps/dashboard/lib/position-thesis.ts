/**
 * New equity / pm / meme lots bind a thesis_id or an explicit meta.untagged reason.
 * Book chips use the explicit id only — never infer from a symbol list.
 */
export const UNTAGGED_META_KEY = 'untagged';
export const SYNC_MISSING_THESIS = 'sync_missing_thesis';
export const HISTORICAL_UNTAGGED = 'historical';

/** Documented conservative backfill only. Skip guesses. */
export const CONSERVATIVE_POSITION_THESIS_BACKFILL = [
  { venue: 'equity', match: 'CODA', thesis_id: 'earnings_gap_structure' },
  { venue: 'prediction', match: 'tc-temp-laxhigh-', thesis_id: 'weather_same_day_high' },
] as const;

export type PositionThesisGate = {
  ok: boolean;
  thesis_id: string | null;
  untagged: string | null;
};

export function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function asMetaObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value as Record<string, unknown> };
}

export function untaggedReason(meta: unknown): string | null {
  return textOrNull(asMetaObject(meta)[UNTAGGED_META_KEY]);
}

export function positionThesisGate(input: {
  thesis_id?: string | null;
  meta?: unknown;
}): PositionThesisGate {
  const thesis_id = textOrNull(input.thesis_id);
  const untagged = untaggedReason(input.meta);
  return {
    ok: Boolean(thesis_id || untagged),
    thesis_id,
    untagged,
  };
}

/** Write path: keep an existing thesis, else require / stamp an untagged reason. */
export function bindPositionThesisWrite(input: {
  thesis_id?: string | null;
  existing_thesis_id?: string | null;
  meta?: unknown;
  existing_meta?: unknown;
  missingReason?: string;
}): { thesis_id: string | null; meta: Record<string, unknown> } {
  const thesis_id = textOrNull(input.thesis_id) ?? textOrNull(input.existing_thesis_id);
  const meta = {
    ...asMetaObject(input.existing_meta),
    ...asMetaObject(input.meta),
  };
  if (thesis_id) {
    delete meta[UNTAGGED_META_KEY];
    return { thesis_id, meta };
  }
  if (!untaggedReason(meta)) {
    meta[UNTAGGED_META_KEY] = input.missingReason ?? SYNC_MISSING_THESIS;
  }
  return { thesis_id: null, meta };
}

/** One matching thesis only. Multiple symbols-on-theses is a skip, not a guess. */
export function unambiguousThesisId(
  symbol: string,
  theses: readonly { id: string; symbols: readonly string[] }[],
): string | null {
  const wanted = symbol.trim();
  if (!wanted) return null;
  const matches = theses.filter((row) => row.symbols.includes(wanted));
  return matches.length === 1 ? matches[0].id : null;
}

export function isConservativeLaxWeatherSlug(slug: string | null | undefined): boolean {
  const value = (slug ?? '').trim().toLowerCase();
  return value.startsWith('tc-temp-laxhigh-');
}
