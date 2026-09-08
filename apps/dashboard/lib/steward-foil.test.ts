import { describe, expect, test } from 'bun:test';
import { MeshPhysicalMaterial } from 'three';

import { cardPixelRatio, STEWARD_CARD, STEWARD_CARD_DPR_CAP, stewardCardInk } from './steward-card-stock';
import { buildStewardCard } from './steward-card-mesh';
import {
  FOIL_COMMON,
  FOIL_MAP,
  FOIL_METAL,
  FOIL_ROUGH,
  isFoilToyShader,
  StewardFoilMaterial,
} from './steward-foil';

describe('steward foil laminate', () => {
  test('patches MeshPhysicalMaterial and keeps the physical lighting stack', () => {
    const mat = new StewardFoilMaterial('#9EC9C8');
    expect(mat).toBeInstanceOf(MeshPhysicalMaterial);
    expect(mat.clearcoat).toBeGreaterThan(0.8);
    expect(mat.iridescence).toBeGreaterThan(0);
    expect(mat.iridescence).toBeLessThan(0.5);
    expect(FOIL_COMMON).toContain('uTilt');
    expect(FOIL_COMMON).toContain('uFoilMap');
    expect(FOIL_MAP).toContain('uTilt');
    expect(FOIL_MAP).toContain('fres');
    expect(FOIL_ROUGH).toContain('roughnessFactor');
    expect(FOIL_METAL).toContain('metalnessFactor');
    const shader = {
      uniforms: {},
      vertexShader: '',
      fragmentShader: [
        '#include <common>',
        '#include <map_fragment>',
        '#include <roughnessmap_fragment>',
        '#include <metalnessmap_fragment>',
        '#include <normal_fragment_maps>',
      ].join('\n'),
    };
    // SAFETY: compile-hook fixture, not a live WebGL program.
    mat.onBeforeCompile(shader as Parameters<MeshPhysicalMaterial['onBeforeCompile']>[0]);
    expect(shader.fragmentShader.indexOf(FOIL_COMMON))
      .toBeGreaterThan(shader.fragmentShader.indexOf('#include <common>'));
    expect(shader.fragmentShader.indexOf(FOIL_MAP))
      .toBeGreaterThan(shader.fragmentShader.indexOf('#include <normal_fragment_maps>'));
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>\n' + FOIL_MAP);
  });

  test('rejects ektogamat hologram / scanline / glitch toys', () => {
    expect(isFoilToyShader(FOIL_COMMON + FOIL_MAP + FOIL_ROUGH + FOIL_METAL)).toBe(false);
    expect(isFoilToyShader('float scanline = sin(uv.y * 80.0);')).toBe(true);
    expect(isFoilToyShader('hologramOpacity')).toBe(true);
    expect(isFoilToyShader('glitchOffset')).toBe(true);
    expect(FOIL_MAP.toLowerCase()).not.toContain('scanline');
    expect(FOIL_MAP.toLowerCase()).not.toContain('hologram');
    expect(FOIL_MAP.toLowerCase()).not.toContain('glitch');
  });

  test('stock is thin paper, ink is the steward fill', () => {
    expect(STEWARD_CARD.depth).toBeLessThan(0.03);
    expect(STEWARD_CARD.height / STEWARD_CARD.width).toBeCloseTo(3 / 2.1, 5);
    const built = buildStewardCard('#9EC9C8');
    expect(built.group.getObjectByName('card-core')).toBeTruthy();
    expect(built.group.getObjectByName('card-print-front')).toBeTruthy();
    expect(built.foil).toBeInstanceOf(StewardFoilMaterial);
    const quant = stewardCardInk('quantanamo', 'QUANTANAMO');
    expect(quant.fill).toBe('#9EC9C8');
    expect(quant.core).toBe('#07090c');
    expect(cardPixelRatio(3)).toBe(STEWARD_CARD_DPR_CAP);
    expect(cardPixelRatio(1)).toBe(1);
    expect(STEWARD_CARD_DPR_CAP).toBeLessThanOrEqual(1.5);
  });
});
