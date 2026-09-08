import { describe, expect, test } from 'bun:test';
import { IcosahedronGeometry, LatheGeometry, Mesh, PerspectiveCamera, Vector3 } from 'three';

import { districtPlaceWord } from './thesis-districts';
import {
  buildThesisIsland,
  islandHitThesisId,
  islandPixelRatio,
  ISLAND_CAMERA,
  ISLAND_DPR_CAP,
  paintThesisSign,
  wrapSignLines,
} from './thesis-island';

function phoneNdc(world: Vector3): Vector3 {
  const camera = new PerspectiveCamera(ISLAND_CAMERA.fov, 390 / 756, 0.1, 60);
  camera.position.set(ISLAND_CAMERA.x, ISLAND_CAMERA.y, ISLAND_CAMERA.z);
  camera.lookAt(ISLAND_CAMERA.lookX, ISLAND_CAMERA.lookY, ISLAND_CAMERA.lookZ);
  camera.updateMatrixWorld();
  return world.clone().project(camera);
}

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

  test('soil is a hull plus palisade, grass is extruded, trees are faceted', () => {
    const island = buildThesisIsland(district('neocloud_compute', 'campus', 'Neocloud basket'));
    const soil = island.group.getObjectByName('soil');
    expect(soil?.children.length).toBeGreaterThan(40);
    const hull = island.group.getObjectByName('soil-hull');
    expect(hull).toBeInstanceOf(Mesh);
    expect((hull as Mesh).geometry).toBeInstanceOf(LatheGeometry);
    const grass = island.group.getObjectByName('grass');
    expect(grass).toBeInstanceOf(Mesh);
    expect((grass as Mesh).geometry.type).toBe('ExtrudeGeometry');
    const pond = island.group.getObjectByName('pond');
    expect(pond).toBeInstanceOf(Mesh);
    expect((pond as Mesh).scale.x).toBeGreaterThan(2);
    expect(island.group.getObjectByName('distant')).toBeTruthy();
    expect(island.group.getObjectByName('path')).toBeTruthy();
    expect(island.group.getObjectByName('sign-face')).toBeTruthy();
    expect(island.group.getObjectByName('arch')).toBeTruthy();
    expect(island.turbines.length).toBeGreaterThanOrEqual(4);
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

  test('pond and distant island sit inside a 390px portrait frustum', () => {
    const island = buildThesisIsland(
      district('ai_power_nuclear', 'plant', 'AI power bottleneck beneficiaries'),
      { id: 'quantum', place: 'lab' },
    );
    const pond = island.group.getObjectByName('pond');
    const distant = island.group.getObjectByName('distant');
    expect(pond).toBeTruthy();
    expect(distant).toBeTruthy();
    const pondNdc = phoneNdc(pond!.getWorldPosition(new Vector3()));
    const farNdc = phoneNdc(distant!.getWorldPosition(new Vector3()));
    expect(Math.abs(pondNdc.x)).toBeLessThan(0.92);
    expect(Math.abs(pondNdc.y)).toBeLessThan(0.92);
    expect(pondNdc.z).toBeGreaterThan(-1);
    expect(pondNdc.z).toBeLessThan(1);
    expect(farNdc.x).toBeGreaterThan(0.05);
    expect(farNdc.x).toBeLessThan(0.95);
    expect(farNdc.y).toBeGreaterThan(0.05);
    expect(farNdc.y).toBeLessThan(0.92);
    island.dispose();
  });
});
