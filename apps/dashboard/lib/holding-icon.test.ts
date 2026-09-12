import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { holdingIconKind, holdingMonogram, holdingTilePaint } from './holding-icon';

describe('holding icon tiles', () => {
  test('venue picks silhouette; letters stay the name', () => {
    expect(holdingIconKind('equity')).toBe('monogram');
    expect(holdingIconKind('prediction')).toBe('contract');
    expect(holdingIconKind('meme')).toBe('token');
    expect(holdingMonogram('NBIS', 'equity')).toBe('NBIS');
    expect(holdingMonogram('CIFR', 'equity')).toBe('CIFR');
    expect(holdingMonogram('CODA', 'equity')).toBe('CODA');
    expect(holdingMonogram('YES · rdc-usfed-fomc-2026-09-16-hike25', 'prediction')).toBe('YES');
    expect(holdingMonogram('NO · example', 'prediction')).toBe('NO');
    expect(holdingMonogram('BATON', 'meme')).toBe('BATO');
    expect(holdingMonogram('', 'prediction')).toBe('YES');
  });

  test('tile paint stays parchment-quiet and stable per seed', () => {
    const a = holdingTilePaint('NBIS', 'equity');
    const b = holdingTilePaint('NBIS', 'equity');
    expect(a).toEqual(b);
    expect(a.fill.startsWith('#d') || a.fill.startsWith('#e') || a.fill.startsWith('#c')).toBe(true);
    expect(a.ink.startsWith('#2') || a.ink.startsWith('#3') || a.ink.startsWith('#4')).toBe(true);
  });

  test('SVG tile is code-drawn — no loot art or steward faces', async () => {
    const svg = await readFile(join(import.meta.dir, '../app/terminal/holding-icon.tsx'), 'utf8');
    expect(svg).toContain('holdingIconKind');
    expect(svg).toContain('rx="8"');
    expect(svg).toContain('<circle');
    expect(svg).toContain('data-kind={kind}');
    expect(svg).not.toContain('sapphire');
    expect(svg).not.toContain('armor');
    expect(svg).not.toContain('StewardAvatar');
    expect(svg).not.toContain('.png');
    expect(svg).not.toContain('loot');
  });
});
