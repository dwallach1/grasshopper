import { describe, expect, test } from 'bun:test';

import { riveKeyedObjectId, stewardRiveArtboard, stewardRiveArtboards, stewardRivePlay, stewardRiveSrc } from './steward-rive';
import { decodeAllStewardRivs, expectedStewardArtboards, sampleStewardFigure } from './steward-rive-decode';

describe('steward rive artboards', () => {
  test('play picks still when motion is reduced and alive when the heartbeat is fresh', () => {
    expect(stewardRivePlay('up', true, true)).toBe('still');
    expect(stewardRivePlay('idle', true, false)).toBe('alive');
    expect(stewardRivePlay('down', false, false)).toBe('down');
    expect(stewardRivePlay('up', false, false)).toBe('up');
  });

  test('artboard names are KIND_play so the official runtime can select without animation names', () => {
    expect(stewardRiveArtboard('quantanamo', 'idle')).toBe('QUANTANAMO_idle');
    expect(stewardRiveArtboard('oddsborne', 'down')).toBe('ODDSBORNE_down');
    expect(stewardRiveSrc('quantanamo', 'up')).toBe('/stewards/quantanamo_up.riv');
    expect(stewardRiveArtboards()).toHaveLength(25);
  });
});

describe('official @rive-app/canvas decode', () => {
  test('each generated steward .riv loads as one artboard with one clip', async () => {
    const decoded = await decodeAllStewardRivs();
    expect(decoded).toHaveLength(25);
    expect(decoded.map((row) => row.artboard)).toEqual(expectedStewardArtboards());
    for (const row of decoded) {
      expect(row.fingerprint).toBe('RIVE');
      expect(row.bytes).toBeGreaterThan(400);
      expect(row.animationCount).toBe(1);
    }
  }, 30_000);

  test('KeyedObject ids are artboard-relative so official apply moves Figure', async () => {
    expect(riveKeyedObjectId(1, 2)).toBe(1);
    const idle = await sampleStewardFigure('quantanamo', 'idle');
    const still = await sampleStewardFigure('quantanamo', 'still');
    expect(idle.yMid).toBeLessThan(idle.y0 - 8);
    expect(idle.scaleXMid).toBeGreaterThan(idle.scaleX0 + 0.1);
    expect(still.yMid).toBe(still.y0);
    expect(still.scaleXMid).toBe(still.scaleX0);
  }, 30_000);
});
