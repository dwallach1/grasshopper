import { describe, expect, test } from 'bun:test';

import { AVATAR_COLORS } from './desk-team';
import {
  knownStewardFace,
  stewardAvatarDataUri,
  stewardAvatarLabel,
  stewardAvatarOptions,
  stewardAvatarSeed,
} from './desk-avatar';

describe('desk steward avatars', () => {
  test('seed prefers slug so Team and Board render the same face', () => {
    expect(stewardAvatarSeed('quantanamo', 'OTHER NAME')).toBe('quantanamo');
    expect(stewardAvatarSeed('  ODDSBORNE  ', 'odds')).toBe('oddsborne');
    expect(stewardAvatarSeed('', 'BANDIT')).toBe('bandit');
    expect(stewardAvatarSeed('', '')).toBe('spark');
  });

  test('same steward always produces the same SVG data URI', () => {
    const once = stewardAvatarDataUri({ slug: 'quantanamo', name: 'QUANTANAMO' });
    const again = stewardAvatarDataUri({ slug: 'quantanamo', name: 'Other label' });
    expect(once).toBe(again);
    expect(once.startsWith('data:image/svg+xml')).toBe(true);
    expect(once).toContain('svg');
  });

  test('known stewards stay visually distinct and on-brand', () => {
    const slugs = ['grasshopper', 'quantanamo', 'oddsborne', 'bandit'] as const;
    const uris = slugs.map((slug) => stewardAvatarDataUri({ slug, name: slug.toUpperCase() }));
    expect(new Set(uris).size).toBe(4);
    expect(knownStewardFace('grasshopper')?.hairHex).toBe(AVATAR_COLORS.brown);
    expect(knownStewardFace('quantanamo')?.hairHex).toBe(AVATAR_COLORS.green);
    expect(knownStewardFace('oddsborne')?.hairHex).toBe(AVATAR_COLORS.blue);
    expect(knownStewardFace('bandit')?.hairHex).toBe(AVATAR_COLORS.red);
    expect(stewardAvatarOptions({ slug: 'quantanamo', name: 'QUANTANAMO' }).hairColor).toEqual([
      AVATAR_COLORS.green.slice(1),
    ]);
    expect(stewardAvatarOptions({ slug: 'oddsborne', name: 'ODDSBORNE' }).glassesProbability).toBe(100);
    expect(stewardAvatarOptions({ slug: 'newcomer', name: 'NEWCOMER', accent: '#94a3b8' }).hairColor).toEqual([
      '94a3b8',
    ]);
  });

  test('accessible label uses the steward name', () => {
    expect(stewardAvatarLabel('QUANTANAMO')).toBe('QUANTANAMO');
    expect(stewardAvatarLabel('  BANDIT  ')).toBe('BANDIT');
    expect(stewardAvatarLabel('')).toBe('Desk steward');
  });
});
