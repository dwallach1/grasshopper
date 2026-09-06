/**
 * Deterministic steward faces for Team + Board.
 * DiceBear Lorelei (MIT core, CC0 drawings) — seed is slug, palette from desk accents.
 * Presentation only. Does not invent ledger marks or roster rows.
 */
import { createAvatar } from '@dicebear/core';
import type { StyleOptions } from '@dicebear/core';
import * as lorelei from '@dicebear/lorelei';
import type { Options as LoreleiOptions } from '@dicebear/lorelei';

import { AVATAR_COLORS } from './desk-team';

export type StewardAvatarSize = 'board' | 'team';

const DESK_INK = '101216';
const DESK_SKIN = 'f2f2f4';

type HairVariant = NonNullable<LoreleiOptions['hair']>[number];
type EyesVariant = NonNullable<LoreleiOptions['eyes']>[number];
type MouthVariant = NonNullable<LoreleiOptions['mouth']>[number];
type GlassesVariant = NonNullable<LoreleiOptions['glasses']>[number];

type StewardFace = {
  seed: string;
  hair: HairVariant;
  eyes: EyesVariant;
  mouth: MouthVariant;
  glasses: GlassesVariant | null;
  hairHex: string;
  backgroundHex: string;
};

const KNOWN_FACES = {
  grasshopper: {
    seed: 'grasshopper',
    hair: 'variant14',
    eyes: 'variant12',
    mouth: 'happy02',
    glasses: null,
    hairHex: AVATAR_COLORS.brown,
    backgroundHex: '1a1408',
  },
  quantanamo: {
    seed: 'quantanamo',
    hair: 'variant08',
    eyes: 'variant06',
    mouth: 'happy08',
    glasses: null,
    hairHex: AVATAR_COLORS.green,
    backgroundHex: '08140e',
  },
  oddsborne: {
    seed: 'oddsborne',
    hair: 'variant22',
    eyes: 'variant16',
    mouth: 'happy11',
    glasses: 'variant03',
    hairHex: AVATAR_COLORS.blue,
    backgroundHex: '0a1220',
  },
  bandit: {
    seed: 'bandit',
    hair: 'variant36',
    eyes: 'variant20',
    mouth: 'happy14',
    glasses: null,
    hairHex: AVATAR_COLORS.red,
    backgroundHex: '160808',
  },
} as const satisfies Record<'bandit' | 'grasshopper' | 'oddsborne' | 'quantanamo', StewardFace>;

export type StewardAvatarInput = {
  slug: string;
  name: string;
  accent?: string;
};

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

export function knownStewardFace(seed: string): StewardFace | null {
  switch (seed) {
    case 'bandit':
    case 'grasshopper':
    case 'oddsborne':
    case 'quantanamo':
      return KNOWN_FACES[seed];
    default:
      return null;
  }
}

function inkHex(color: string): string {
  return color.startsWith('#') ? color.slice(1) : color;
}

export function stewardAvatarOptions(input: StewardAvatarInput): StyleOptions<LoreleiOptions> {
  const seed = stewardAvatarSeed(input.slug, input.name);
  const known = knownStewardFace(seed);
  const hairHex = inkHex(known?.hairHex ?? input.accent ?? AVATAR_COLORS.green);
  const backgroundHex = known?.backgroundHex ?? DESK_INK;
  const options: StyleOptions<LoreleiOptions> = {
    seed: known?.seed ?? seed,
    scale: 115,
    radius: 16,
    backgroundColor: [backgroundHex],
    skinColor: [DESK_SKIN],
    hairColor: [hairHex],
    eyebrowsColor: [DESK_INK],
    eyesColor: [DESK_INK],
    noseColor: [DESK_INK],
    mouthColor: [DESK_INK],
    glassesColor: [DESK_INK],
    earringsProbability: 0,
    frecklesProbability: 0,
    hairAccessoriesProbability: 0,
    beardProbability: 0,
    glassesProbability: 0,
  };
  if (!known) return options;
  options.hair = [known.hair];
  options.eyes = [known.eyes];
  options.mouth = [known.mouth];
  if (known.glasses) {
    options.glasses = [known.glasses];
    options.glassesProbability = 100;
  }
  return options;
}

export function stewardAvatarDataUri(input: StewardAvatarInput): string {
  return createAvatar(lorelei, stewardAvatarOptions(input)).toDataUri();
}
