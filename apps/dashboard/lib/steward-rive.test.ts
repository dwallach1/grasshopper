import { describe, expect, test } from 'bun:test';

import { stewardRiveArtboard, stewardRiveArtboards, stewardRivePlay } from './steward-rive';
import { decodeStewardRiv, expectedStewardArtboards } from './steward-rive-decode';

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
    expect(stewardRiveArtboards()).toHaveLength(25);
  });
});

describe('official @rive-app/canvas decode', () => {
  test('generated stewards.riv loads and exposes every steward artboard', async () => {
    const decoded = await decodeStewardRiv();
    expect(decoded.fingerprint).toBe('RIVE');
    expect(decoded.bytes).toBeGreaterThan(2_000);
    expect(decoded.artboardCount).toBe(25);
    expect(decoded.artboards).toEqual(expectedStewardArtboards());
    expect(decoded.animationsPerArtboard.every((count) => count === 1)).toBe(true);
  }, 20_000);
});
