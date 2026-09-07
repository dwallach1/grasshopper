import { describe, expect, test } from 'bun:test';

import { AVATAR_COLORS } from './desk-team';
import {
  stewardAvatarLabel,
  stewardAvatarSeed,
  stewardBotKind,
  stewardBotPalette,
  stewardEmoteDelayMs,
  stewardFaceLayout,
  stewardFurTone,
  type StewardBotKind,
} from './desk-avatar';

describe('desk steward avatars', () => {
  test('seed prefers slug so Team and Board render the same face', () => {
    expect(stewardAvatarSeed('quantanamo', 'OTHER NAME')).toBe('quantanamo');
    expect(stewardAvatarSeed('  ODDSBORNE  ', 'odds')).toBe('oddsborne');
    expect(stewardAvatarSeed('', 'BANDIT')).toBe('bandit');
    expect(stewardAvatarSeed('', '')).toBe('spark');
  });

  test('known stewards map to distinct blob kinds and desk palettes', () => {
    expect(stewardBotKind('quantanamo', 'QUANTANAMO')).toBe('quantanamo');
    expect(stewardBotKind('oddsborne', 'ODDSBORNE')).toBe('oddsborne');
    expect(stewardBotKind('bandit', 'BANDIT')).toBe('bandit');
    expect(stewardBotKind('grasshopper', 'GRASSHOPPER')).toBe('grasshopper');
    expect(stewardBotKind('newcomer', 'NEWCOMER')).toBe('spark');
    expect(stewardBotPalette({ slug: 'grasshopper', name: 'GRASSHOPPER' }).accent).toBe(AVATAR_COLORS.brown);
    expect(stewardBotPalette({ slug: 'quantanamo', name: 'QUANTANAMO' }).accent).toBe(AVATAR_COLORS.green);
    expect(stewardBotPalette({ slug: 'oddsborne', name: 'ODDSBORNE' }).accent).toBe(AVATAR_COLORS.blue);
    expect(stewardBotPalette({ slug: 'bandit', name: 'BANDIT' }).accent).toBe(AVATAR_COLORS.red);
    expect(stewardBotPalette({ slug: 'newcomer', name: 'NEWCOMER', accent: '#94a3b8' })).toEqual({
      kind: 'spark',
      accent: '#94a3b8',
    });
    const kinds = ['grasshopper', 'quantanamo', 'oddsborne', 'bandit'].map((slug) =>
      stewardBotKind(slug, slug),
    );
    expect(new Set(kinds).size).toBe(4);
  });

  test('emote delay is stable per steward and staggered across the desk', () => {
    expect(stewardEmoteDelayMs('quantanamo', 'OTHER')).toBe(stewardEmoteDelayMs('quantanamo', 'QUANTANAMO'));
    expect(stewardEmoteDelayMs('quantanamo', 'QUANTANAMO')).not.toBe(stewardEmoteDelayMs('bandit', 'BANDIT'));
  });

  test('accessible label uses the steward name', () => {
    expect(stewardAvatarLabel('QUANTANAMO')).toBe('QUANTANAMO');
    expect(stewardAvatarLabel('  BANDIT  ')).toBe('BANDIT');
    expect(stewardAvatarLabel('')).toBe('Desk steward');
  });

  test('fur tones stay in one pastel family and stay distinct per steward', () => {
    const kinds: StewardBotKind[] = ['quantanamo', 'oddsborne', 'bandit'];
    const tones = kinds.map(stewardFurTone);
    expect(new Set(tones.map((tone) => tone.base)).size).toBe(3);
    expect(new Set(tones.map((tone) => tone.seed)).size).toBe(3);
    for (const tone of tones) {
      expect(tone.base).not.toBe(AVATAR_COLORS.green);
      expect(tone.base).not.toBe(AVATAR_COLORS.blue);
      expect(tone.base).not.toBe(AVATAR_COLORS.red);
      const [r, g, b] = hexRgb(tone.base);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(80);
      expect(Math.min(r, g, b)).toBeGreaterThan(140);
      expect(Math.max(r, g, b)).toBeLessThan(220);
    }
  });

  test('sleepy faces differ by eye spacing and lid tilt, not chrome', () => {
    const kinds: StewardBotKind[] = ['quantanamo', 'oddsborne', 'bandit'];
    const faces = kinds.map(stewardFaceLayout);
    expect(new Set(faces.map((face) => Number((face.right - face.left).toFixed(2)))).size).toBe(3);
    expect(new Set(faces.map((face) => `${face.lidTiltL},${face.lidTiltR}`)).size).toBe(3);
    expect(faces.every((face) => face.lidCover >= 0.45 && face.lidCover <= 0.65)).toBe(true);
    expect(stewardFaceLayout('oddsborne').lidCover).toBeGreaterThan(stewardFaceLayout('quantanamo').lidCover);
  });
});

function hexRgb(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}
