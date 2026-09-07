/**
 * Steward identity for Team + Board living icons.
 * One soft circle + two morphable eyes, in code. Slug/name/accent from the ledger.
 */
import { AVATAR_COLORS } from './desk-team';

export type StewardAvatarSize = 'board' | 'team';

export type StewardBotKind = 'bandit' | 'grasshopper' | 'oddsborne' | 'quantanamo' | 'spark';

export type StewardMood = 'down' | 'idle' | 'up';

export type StewardAvatarInput = {
  slug: string;
  name: string;
  accent?: string;
};

export type StewardBotPalette = {
  accent: string;
  kind: StewardBotKind;
};

/** Soft fill + eye spacing. Same species; stewards differ by color and gap. */
export type StewardSpecies = {
  fill: string;
  eye: string;
  gap: number;
  eyeY: number;
  restW: number;
  restH: number;
  restTilt: number;
  leftBias: number;
  rightBias: number;
};

const KNOWN_ACCENTS = {
  bandit: AVATAR_COLORS.red,
  grasshopper: AVATAR_COLORS.brown,
  oddsborne: AVATAR_COLORS.blue,
  quantanamo: AVATAR_COLORS.green,
} as const;

const SPECIES = {
  quantanamo: {
    fill: '#9EC9C8',
    eye: '#F3EEE4',
    gap: 0.34,
    eyeY: -0.12,
    restW: 0.145,
    restH: 0.22,
    restTilt: -0.08,
    leftBias: 0.04,
    rightBias: -0.02,
  },
  oddsborne: {
    fill: '#B0AEDA',
    eye: '#F3EEE4',
    gap: 0.24,
    eyeY: -0.15,
    restW: 0.12,
    restH: 0.24,
    restTilt: 0.12,
    leftBias: -0.06,
    rightBias: -0.1,
  },
  bandit: {
    fill: '#D7A8B4',
    eye: '#F3EEE4',
    gap: 0.29,
    eyeY: -0.1,
    restW: 0.155,
    restH: 0.175,
    restTilt: 0.18,
    leftBias: -0.12,
    rightBias: 0.2,
  },
  grasshopper: {
    fill: '#C6B49A',
    eye: '#F3EEE4',
    gap: 0.31,
    eyeY: -0.08,
    restW: 0.135,
    restH: 0.2,
    restTilt: 0,
    leftBias: 0,
    rightBias: 0,
  },
  spark: {
    fill: '#A9B6C0',
    eye: '#F3EEE4',
    gap: 0.27,
    eyeY: -0.11,
    restW: 0.12,
    restH: 0.175,
    restTilt: 0.04,
    leftBias: -0.03,
    rightBias: 0.03,
  },
} as const satisfies Record<StewardBotKind, StewardSpecies>;

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

export function stewardSpecies(kind: StewardBotKind): StewardSpecies {
  return SPECIES[kind];
}

/** Board day face from ranked % return. Missing / flat stays idle. */
export function stewardMood(returnPct: number | null | undefined): StewardMood {
  if (returnPct === null || returnPct === undefined || !Number.isFinite(returnPct)) return 'idle';
  if (returnPct > 0) return 'up';
  if (returnPct < 0) return 'down';
  return 'idle';
}

/** Watching stewards dwell in the thinking morph. */
export function stewardThinking(status: string): boolean {
  return status.trim().toLowerCase() === 'watching';
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
