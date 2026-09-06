/**
 * Steward identity for Team + Board robot mascots.
 * Presentation only — slug/name/accent from the ledger. No invented marks.
 */
import { AVATAR_COLORS } from './desk-team';

export type StewardAvatarSize = 'board' | 'team';

export type StewardBotKind = 'bandit' | 'grasshopper' | 'oddsborne' | 'quantanamo' | 'spark';

export type StewardAvatarInput = {
  slug: string;
  name: string;
  accent?: string;
};

export type StewardBotPalette = {
  accent: string;
  kind: StewardBotKind;
};

const KNOWN_ACCENTS = {
  bandit: AVATAR_COLORS.red,
  grasshopper: AVATAR_COLORS.brown,
  oddsborne: AVATAR_COLORS.blue,
  quantanamo: AVATAR_COLORS.green,
} as const;

export function stewardAvatarSeed(slug: string, name: string): string {
  const fromSlug = slug.trim().toLowerCase();
  if (fromSlug) return fromSlug;
  const fromName = name.trim().toLowerCase();
  if (fromName) return fromName;
  return 'spark';
}

export function stewardAvatarLabel(name: string): string {
  const trimmed = name.trim();
  return trimmed || 'Desk steward';
}

export function stewardBotKind(slug: string, name: string): StewardBotKind {
  const seed = stewardAvatarSeed(slug, name);
  switch (seed) {
    case 'bandit':
    case 'grasshopper':
    case 'oddsborne':
    case 'quantanamo':
      return seed;
    default:
      return 'spark';
  }
}

export function stewardBotPalette(input: StewardAvatarInput): StewardBotPalette {
  const kind = stewardBotKind(input.slug, input.name);
  if (kind !== 'spark') {
    return { kind, accent: KNOWN_ACCENTS[kind] };
  }
  return { kind, accent: input.accent || '#94a3b8' };
}

/** Stagger blinks/glances so the desk does not pulse in lockstep. */
export function stewardEmoteDelayMs(slug: string, name: string): number {
  const seed = stewardAvatarSeed(slug, name);
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 33 + char.charCodeAt(0)) % 2600;
  }
  return hash;
}
