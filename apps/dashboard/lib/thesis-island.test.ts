import { describe, expect, test } from 'bun:test';
import { IcosahedronGeometry, LatheGeometry, Mesh, PerspectiveCamera, Vector3 } from 'three';

import { districtPlaceWord } from './thesis-districts';
import {
  buildThesisIsland,
  islandHitThesisId,
  islandPixelRatio,
  HOOP_RADIUS,
  HOOP_X,
  HOOP_YAW,
  HOOP_Z,
  ISLAND_CAMERA,
  ISLAND_DPR_CAP,
  ISLAND_GRASS_Y,
  ISLAND_RADIUS,
  POND_R,
  POND_X,
  POND_Z,
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
    expect((pond as Mesh).geometry.type).toBe('CylinderGeometry');
    expect((pond as Mesh).rotation.x).toBeCloseTo(0, 5);
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

  test('pond sits on the grass and the hoop is centered on the hall', () => {
    const island = buildThesisIsland(district('quantum', 'lab', 'Quantum computing'));
    const pond = island.group.getObjectByName('pond') as Mesh;
    expect(pond.position.x).toBeCloseTo(POND_X, 5);
    expect(pond.position.z).toBeCloseTo(POND_Z, 5);
    expect(pond.position.y).toBeGreaterThan(ISLAND_GRASS_Y + 0.07);
    expect(POND_R).toBeGreaterThan(0.9);
    expect(POND_X).toBeGreaterThan(0.4);
    expect(POND_Z).toBeGreaterThan(0);
    expect(Math.hypot(POND_X, POND_Z) + POND_R).toBeLessThan(ISLAND_RADIUS - 0.35);
    const hoop = island.group.getObjectByName('hoop') as Mesh;
    expect(hoop).toBeInstanceOf(Mesh);
    expect(hoop.geometry.type).toBe('TorusGeometry');
    expect(hoop.position.x).toBeCloseTo(0.15, 5);
    expect(hoop.position.z).toBeCloseTo(-0.25, 5);
    expect(hoop.position.x).toBeCloseTo(HOOP_X, 5);
    expect(hoop.position.z).toBeCloseTo(HOOP_Z, 5);
    expect(hoop.rotation.x).toBeCloseTo(0, 5);
    expect(hoop.rotation.y).toBeCloseTo(HOOP_YAW, 5);
    expect(hoop.position.y).toBeGreaterThan(ISLAND_GRASS_Y + HOOP_RADIUS * 0.6);
    expect(hoop.position.y).toBeLessThan(ISLAND_GRASS_Y + HOOP_RADIUS + 0.4);
    const hall = island.group.getObjectByName('structure') as Mesh;
    expect(hall.position.x).toBeCloseTo(0, 5);
    expect(Math.hypot(hoop.position.x - 0.15, hoop.position.z + 0.25)).toBeLessThan(0.02);
    island.dispose();
  });

  test('the whole disk, pond, and peek sit in a 390px portrait frustum', () => {
    const island = buildThesisIsland(
      district('ai_power_nuclear', 'plant', 'AI power bottleneck beneficiaries'),
      { id: 'quantum', place: 'lab' },
    );
    const pond = island.group.getObjectByName('pond');
    const distant = island.group.getObjectByName('distant');
    expect(pond).toBeTruthy();
    expect(distant).toBeTruthy();
    const pondNdc = phoneNdc(pond!.getWorldPosition(new Vector3()));
    const camDirX = 16.6 / Math.hypot(16.6, 18.2);
    const camDirZ = 18.2 / Math.hypot(16.6, 18.2);
    const nearShore = phoneNdc(new Vector3(
      POND_X + camDirX * POND_R,
      ISLAND_GRASS_Y + 0.09,
      POND_Z + camDirZ * POND_R,
    ));
    const farShore = phoneNdc(new Vector3(
      POND_X - camDirX * POND_R,
      ISLAND_GRASS_Y + 0.09,
      POND_Z - camDirZ * POND_R,
    ));
    expect(nearShore.z).toBeGreaterThan(-1);
    expect(nearShore.z).toBeLessThan(1);
    expect(farShore.z).toBeGreaterThan(-1);
    expect(farShore.z).toBeLessThan(1);
    expect(Math.abs(nearShore.x)).toBeLessThan(0.9);
    expect(Math.abs(farShore.x)).toBeLessThan(0.9);
    expect(Math.abs(nearShore.y - farShore.y)).toBeGreaterThan(0.04);
    const farNdc = phoneNdc(distant!.getWorldPosition(new Vector3()));
    expect(Math.abs(pondNdc.x)).toBeLessThan(0.78);
    expect(Math.abs(pondNdc.y)).toBeLessThan(0.78);
    expect(pondNdc.z).toBeGreaterThan(-1);
    expect(pondNdc.z).toBeLessThan(1);
    expect(farNdc.x).toBeGreaterThan(0.05);
    expect(farNdc.x).toBeLessThan(0.92);
    expect(farNdc.y).toBeGreaterThan(0.08);
    expect(farNdc.y).toBeLessThan(0.88);
    for (const [x, z] of [
      [ISLAND_RADIUS, 0],
      [-ISLAND_RADIUS, 0],
      [0, ISLAND_RADIUS],
      [0, -ISLAND_RADIUS],
    ] as const) {
      const edge = phoneNdc(new Vector3(x, ISLAND_GRASS_Y, z));
      expect(Math.abs(edge.x)).toBeLessThan(0.82);
      expect(Math.abs(edge.y)).toBeLessThan(0.82);
    }
    island.dispose();
  });
});
