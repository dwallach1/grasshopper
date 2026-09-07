/**
 * Steward identity for Team + Board fluff faces.
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

export type StewardFurTone = {
  base: string;
  deep: string;
  lit: string;
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

/** GPU mound: peak/girth/bump stay in one species, eyes stay sleepy. */
export type StewardMeshSpec = {
  peak: number;
  girth: number;
  flatten: number;
  bumpX: number;
  bumpY: number;
  bumpGain: number;
  eyeSpread: number;
  eyeY: number;
  eyeZ: number;
  eyeR: number;
  lidCover: number;
  lidTiltL: number;
  lidTiltR: number;
};

const KNOWN_ACCENTS = {
  bandit: AVATAR_COLORS.red,
  grasshopper: AVATAR_COLORS.brown,
  oddsborne: AVATAR_COLORS.blue,
  quantanamo: AVATAR_COLORS.green,
} as const;

/** Felt pastels in one periwinkle family. Hue-shift only — not book greens/reds. */
const FUR_TONES = {
  quantanamo: { base: '#9BB8C4', deep: '#6F8E9A', lit: '#D4E4EA', seed: 11 },
  oddsborne: { base: '#A8A9D0', deep: '#7B7DA8', lit: '#DDDEF0', seed: 23 },
  bandit: { base: '#C4A4B0', deep: '#947784', lit: '#E8D4DC', seed: 37 },
  grasshopper: { base: '#B5A89E', deep: '#8A7E74', lit: '#E2D8D0', seed: 5 },
  spark: { base: '#A4AEB8', deep: '#78828C', lit: '#D8DEE4', seed: 17 },
} as const satisfies Record<StewardBotKind, StewardFurTone>;

const FACE_LAYOUTS = {
  quantanamo: { left: 21.6, right: 42.0, cy: 29.2, r: 8.7, lidTiltL: 0, lidTiltR: -4, lidCover: 0.5 },
  oddsborne: { left: 25.0, right: 38.8, cy: 26.4, r: 8.3, lidTiltL: -10, lidTiltR: -12, lidCover: 0.6 },
  bandit: { left: 23.8, right: 40.0, cy: 28.0, r: 8.1, lidTiltL: -6, lidTiltR: -16, lidCover: 0.54 },
  grasshopper: { left: 23.2, right: 40.8, cy: 27.6, r: 8.4, lidTiltL: -8, lidTiltR: -8, lidCover: 0.52 },
  spark: { left: 24.4, right: 39.6, cy: 28.4, r: 7.8, lidTiltL: -7, lidTiltR: -7, lidCover: 0.5 },
} as const satisfies Record<StewardBotKind, StewardFaceLayout>;

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

type StewardMound = Pick<StewardMeshSpec, 'peak' | 'girth' | 'flatten' | 'bumpX' | 'bumpY' | 'bumpGain'>;

const MESH_MOUNDS = {
  quantanamo: { peak: 0.84, girth: 1.3, flatten: 0.24, bumpX: -0.38, bumpY: 0.12, bumpGain: 0.17 },
  oddsborne: { peak: 1.2, girth: 0.94, flatten: 0.1, bumpX: 0.06, bumpY: 0.48, bumpGain: 0.11 },
  bandit: { peak: 0.95, girth: 1.1, flatten: 0.16, bumpX: 0.44, bumpY: 0.04, bumpGain: 0.2 },
  grasshopper: { peak: 0.9, girth: 1.22, flatten: 0.2, bumpX: 0, bumpY: 0.08, bumpGain: 0.06 },
  spark: { peak: 0.98, girth: 1.04, flatten: 0.14, bumpX: 0.12, bumpY: 0.1, bumpGain: 0.08 },
} as const satisfies Record<StewardBotKind, StewardMound>;

export function stewardMeshSpec(kind: StewardBotKind): StewardMeshSpec {
  const face = FACE_LAYOUTS[kind];
  const mound = MESH_MOUNDS[kind];
  return {
    ...mound,
    eyeSpread: (face.right - face.left) / 64,
    eyeY: (32 - face.cy) / 36,
    eyeZ: 0.66,
    eyeR: face.r / 36,
    lidCover: face.lidCover,
    lidTiltL: (face.lidTiltL * Math.PI) / 180,
    lidTiltR: (face.lidTiltR * Math.PI) / 180,
  };
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
