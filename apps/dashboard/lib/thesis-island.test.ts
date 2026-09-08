import { describe, expect, test } from 'bun:test';
import { IcosahedronGeometry, LatheGeometry, Mesh } from 'three';

import { districtPlaceWord } from './thesis-districts';
import {
  buildThesisIsland,
  islandHitThesisId,
  islandPixelRatio,
  ISLAND_DPR_CAP,
  paintThesisSign,
  wrapSignLines,
} from './thesis-island';

function district(id: string, place: 'campus' | 'plant' | 'hangar' | 'lab' | 'yard', name = id) {
  return {
    id,
    name,
    place,
    buildings: [{
      id,
      name,
      summary: `${name} sentence`,
      falsifier: null,
      accent: '#22c55e',
      steward: 'quantanamo',
    }],
  };
}

function geos(group: ReturnType<typeof buildThesisIsland>['group']): string[] {
  const types: string[] = [];
  group.traverse((node) => {
    if (node instanceof Mesh) types.push(node.geometry.type);
  });
  return types;
}

describe('thesis island craft', () => {
  test('wraps a physical sign instead of one long overlay string', () => {
    expect(wrapSignLines('AI power bottleneck beneficiaries')).toEqual([
      'AI power',
      'bottleneck',
      'beneficiaries',
    ]);
    const painted: string[] = [];
    const ctx = {
      canvas: { width: 512, height: 220 },
      clearRect() {},
      fillRect() {},
      fillText(text: string) { painted.push(text); },
      fillStyle: '',
      font: '',
      textAlign: 'center',
      textBaseline: 'middle',
    } as unknown as CanvasRenderingContext2D;
    paintThesisSign(ctx, 'AI power bottleneck beneficiaries');
    expect(painted.join(' ')).toContain('AI POWER');
    expect(districtPlaceWord('plant')).toBe('POWER');
  });

  test('caps device pixel ratio like the Team card', () => {
    expect(islandPixelRatio(3)).toBe(ISLAND_DPR_CAP);
    expect(islandPixelRatio(1)).toBe(1);
  });

  test('soil is a stack of blocks, grass is extruded, trees are faceted', () => {
    const island = buildThesisIsland(district('neocloud_compute', 'campus', 'Neocloud basket'));
    const soil = island.group.getObjectByName('soil');
    expect(soil?.children.length).toBeGreaterThan(40);
    const grass = island.group.getObjectByName('grass');
    expect(grass).toBeInstanceOf(Mesh);
    expect((grass as Mesh).geometry.type).toBe('ExtrudeGeometry');
    expect(island.group.getObjectByName('pond')).toBeTruthy();
    expect(island.group.getObjectByName('path')).toBeTruthy();
    expect(island.group.getObjectByName('sign-face')).toBeTruthy();
    expect(island.group.getObjectByName('arch')).toBeTruthy();
    const kinds = geos(island.group);
    expect(kinds).toContain('IcosahedronGeometry');
    expect(kinds).not.toContain('ConeGeometry');
    expect(island.group.getObjectByName('hall-0')).toBeTruthy();
    expect(island.hits).toHaveLength(1);
    expect(islandHitThesisId(island.hits[0] ?? null)).toBe('neocloud_compute');
    island.dispose();
  });

  test('energy massing is a cooling tower plus a roofed hall', () => {
    const island = buildThesisIsland(
      district('ai_power_nuclear', 'plant', 'AI power bottleneck beneficiaries'),
      { id: 'neocloud_compute', place: 'campus' },
    );
    const tower = island.group.getObjectByName('cooling-tower');
    expect(tower).toBeInstanceOf(Mesh);
    expect((tower as Mesh).geometry).toBeInstanceOf(LatheGeometry);
    expect(island.group.getObjectByName('reactor-hall')).toBeTruthy();
    expect(island.group.getObjectByName('roof-slab')).toBeTruthy();
    expect(island.group.getObjectByName('distant')).toBeTruthy();
    const canopy = island.group.getObjectByName('canopy-0');
    expect(canopy).toBeInstanceOf(Mesh);
    expect((canopy as Mesh).geometry).toBeInstanceOf(IcosahedronGeometry);
    island.dispose();
  });

  test('lab uses a staggered tower cluster, not a single box', () => {
    const island = buildThesisIsland(district('quantum', 'lab', 'Quantum computing'));
    expect(island.group.getObjectByName('tower-0')).toBeTruthy();
    expect(island.group.getObjectByName('tower-1')).toBeTruthy();
    expect(island.group.getObjectByName('tower-2')).toBeTruthy();
    island.dispose();
  });
});
