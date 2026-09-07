import { describe, expect, test } from 'bun:test';

import { AVATAR_COLORS } from './desk-team';
import {
  stewardAvatarLabel,
  stewardAvatarSeed,
  stewardBotKind,
  stewardBotPalette,
  stewardEmoteDelayMs,
  stewardMood,
  stewardSpecies,
  stewardThinking,
  type StewardBotKind,
} from './desk-avatar';

describe('desk steward avatars', () => {
  test('seed prefers slug so Team and Board render the same face', () => {
    expect(stewardAvatarSeed('quantanamo', 'OTHER NAME')).toBe('quantanamo');
    expect(stewardAvatarSeed('  ODDSBORNE  ', 'odds')).toBe('oddsborne');
    expect(stewardAvatarSeed('', 'BANDIT')).toBe('bandit');
    expect(stewardAvatarSeed('', '')).toBe('spark');
  });

  test('known stewards map to distinct kinds and desk palettes', () => {
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

  test('species fills stay soft, distinct, and off the book P/L colors', () => {
    const kinds: StewardBotKind[] = ['quantanamo', 'oddsborne', 'bandit', 'grasshopper'];
    const faces = kinds.map(stewardSpecies);
    expect(new Set(faces.map((face) => face.fill)).size).toBe(4);
    expect(new Set(faces.map((face) => face.gap.toFixed(2))).size).toBe(4);
    for (const face of faces) {
      expect(face.fill).not.toBe(AVATAR_COLORS.green);
      expect(face.fill).not.toBe(AVATAR_COLORS.blue);
      expect(face.fill).not.toBe(AVATAR_COLORS.red);
      expect(face.fill).not.toBe('#000000');
      expect(face.fill).not.toBe('#111111');
      const [r, g, b] = hexRgb(face.fill);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(80);
      expect(Math.min(r, g, b)).toBeGreaterThan(140);
      expect(Math.max(r, g, b)).toBeLessThanOrEqual(220);
    }
    expect(stewardSpecies('quantanamo').gap).toBeGreaterThan(stewardSpecies('oddsborne').gap);
  });

  test('board mood follows ranked return: up / down / idle', () => {
    expect(stewardMood(1.2)).toBe('up');
    expect(stewardMood(-0.4)).toBe('down');
    expect(stewardMood(0)).toBe('idle');
    expect(stewardMood(null)).toBe('idle');
    expect(stewardMood(undefined)).toBe('idle');
    expect(stewardMood(Number.NaN)).toBe('idle');
  });

  test('watching status is the thinking dwell, not a guessed mood', () => {
    expect(stewardThinking('watching')).toBe(true);
    expect(stewardThinking('WATCHING')).toBe(true);
    expect(stewardThinking('active')).toBe(false);
    expect(stewardThinking('idle')).toBe(false);
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
