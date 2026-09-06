import { describe, expect, test } from 'bun:test';

import { AVATAR_COLORS } from './desk-team';
import {
  stewardAvatarLabel,
  stewardAvatarSeed,
  stewardBotKind,
  stewardBotPalette,
  stewardEmoteDelayMs,
} from './desk-avatar';

describe('desk steward avatars', () => {
  test('seed prefers slug so Team and Board render the same robot', () => {
    expect(stewardAvatarSeed('quantanamo', 'OTHER NAME')).toBe('quantanamo');
    expect(stewardAvatarSeed('  ODDSBORNE  ', 'odds')).toBe('oddsborne');
    expect(stewardAvatarSeed('', 'BANDIT')).toBe('bandit');
    expect(stewardAvatarSeed('', '')).toBe('spark');
  });

  test('known stewards map to distinct WALL-E kinds and desk palettes', () => {
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
});
