/**
 * Steward identity for Team + Board fluff faces.
 * Presentation only — slug/name/accent from the ledger. No invented marks.
 * Vector mascots (SVG artboard), not a lit 3D mesh.
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

export type StewardFurTone = {
  base: string;
  deep: string;
  lit: string;
  pad: string;
  seed: number;
};

export type StewardFaceLayout = {
  left: number;
  right: number;
  cy: number;
  r: number;
  lidTiltL: number;
  lidTiltR: number;
  lidCover: number;
};

/** Flat vector mound: peak/girth stay in one species, path is the silhouette. */
export type StewardSilhouette = {
  path: string;
  peak: number;
  girth: number;
};

const KNOWN_ACCENTS = {
  bandit: AVATAR_COLORS.red,
  grasshopper: AVATAR_COLORS.brown,
  oddsborne: AVATAR_COLORS.blue,
  quantanamo: AVATAR_COLORS.green,
} as const;

/** Felt pastels in one periwinkle family. Hue-shift only — not book greens/reds. */
const FUR_TONES = {
  quantanamo: { base: '#B3D1DB', deep: '#7FA0AB', lit: '#E7F3F6', pad: '#D7E6EC', seed: 11 },
  oddsborne: { base: '#B8BAD8', deep: '#8A8CB8', lit: '#EEF0FA', pad: '#DDDEF0', seed: 23 },
  bandit: { base: '#D6B6C2', deep: '#A38490', lit: '#F4E4EA', pad: '#EBD6DE', seed: 37 },
  grasshopper: { base: '#C8BDB4', deep: '#97897F', lit: '#F0E8E2', pad: '#E4DBD4', seed: 5 },
  spark: { base: '#B7C2CC', deep: '#87929C', lit: '#E8EEF2', pad: '#D6DEE4', seed: 17 },
} as const satisfies Record<StewardBotKind, StewardFurTone>;

const FACE_LAYOUTS = {
  quantanamo: { left: 21.6, right: 42.0, cy: 29.2, r: 8.7, lidTiltL: 0, lidTiltR: -4, lidCover: 0.5 },
  oddsborne: { left: 25.0, right: 38.8, cy: 26.4, r: 8.3, lidTiltL: -10, lidTiltR: -12, lidCover: 0.6 },
  bandit: { left: 23.8, right: 40.0, cy: 28.0, r: 8.1, lidTiltL: -6, lidTiltR: -16, lidCover: 0.54 },
  grasshopper: { left: 23.2, right: 40.8, cy: 27.6, r: 8.4, lidTiltL: -8, lidTiltR: -8, lidCover: 0.52 },
  spark: { left: 24.4, right: 39.6, cy: 28.4, r: 7.8, lidTiltL: -7, lidTiltR: -7, lidCover: 0.5 },
} as const satisfies Record<StewardBotKind, StewardFaceLayout>;

const SILHOUETTES = {
  quantanamo: {
    peak: 0.84,
    girth: 1.3,
    path: 'M4.2 50.6C3.2 41 8 26 16 18.6C20.4 13.8 26.8 15 30.2 18C34.2 12.4 40.8 11.2 46.6 16.6C54.4 23.8 59.2 35.2 59.4 46C59.6 53.2 53.2 58.8 42.4 60.2C31.8 61.6 12.4 59.6 4.2 50.6Z',
  },
  oddsborne: {
    peak: 1.2,
    girth: 0.94,
    path: 'M13.6 53C11.4 41.8 16 20.2 26.4 8.8C29.8 4.6 34 3 36.6 6.4C38.4 8.8 37.8 11.6 41 13.8C47.8 19.4 52.6 31.4 54 42.8C55 51.4 51 57.8 42.4 59.4C34.6 60.8 22.8 60.4 16.4 56.6C14.2 55.2 13.6 54.2 13.6 53Z',
  },
  bandit: {
    peak: 0.95,
    girth: 1.1,
    path: 'M10.4 53C9.2 41.2 14.4 22.8 24.6 14.6C30.4 9.6 36.8 10.4 40.6 15.4C44.4 20.4 45.6 28.6 53.6 36.4C59.2 42.4 59.6 51.8 50.6 57.2C41.4 61.2 22.6 60.4 13.6 56.2C11.2 54.8 10.4 53.8 10.4 53Z',
  },
  grasshopper: {
    peak: 0.9,
    girth: 1.22,
    path: 'M7.4 53C6.4 43.6 10.6 26 20.4 18.4C26.4 14.4 38.2 14.4 44.2 18.4C54 26 57.6 43.6 56.6 53C55.6 58.6 43.8 60.4 32 60.4C20.2 60.4 8.4 58.6 7.4 53Z',
  },
  spark: {
    peak: 0.98,
    girth: 1.04,
    path: 'M13.4 51.8C12.4 41.6 16.6 26 26 18.4C30.4 15.2 36.6 15.2 40.6 19C48.2 26.2 51.6 40 50.6 50.8C49.8 56.6 40.2 59.2 32 59.2C22.6 59.2 14.4 56.6 13.4 51.8Z',
  },
} as const satisfies Record<StewardBotKind, StewardSilhouette>;

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

export function stewardFurTone(kind: StewardBotKind): StewardFurTone {
  return FUR_TONES[kind];
}

export function stewardFaceLayout(kind: StewardBotKind): StewardFaceLayout {
  return FACE_LAYOUTS[kind];
}

export function stewardSilhouette(kind: StewardBotKind): StewardSilhouette {
  return SILHOUETTES[kind];
}

/** Board day face from ranked % return. Missing / flat stays idle. */
export function stewardMood(returnPct: number | null | undefined): StewardMood {
  if (returnPct === null || returnPct === undefined || !Number.isFinite(returnPct)) return 'idle';
  if (returnPct > 0) return 'up';
  if (returnPct < 0) return 'down';
  return 'idle';
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
