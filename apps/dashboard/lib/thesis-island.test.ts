import { describe, expect, test } from 'bun:test';
import { IcosahedronGeometry, LatheGeometry, Mesh, PerspectiveCamera, Vector3 } from 'three';

import { districtPlaceWord } from './thesis-districts';
import {
  buildThesisIsland,
  islandHitThesisId,
  islandAllowsComposer,
  islandDrawingOk,
  islandHostSize,
  islandKit,
  islandPixelRatio,
  islandVoid,
  ISLAND_CAMERA,
  ISLAND_CREAM,
  ISLAND_DPR_CAP,
  ISLAND_GRASS_Y,
  ISLAND_RADIUS,
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

function district(
  id: string,
  place: 'campus' | 'plant' | 'hangar' | 'lab' | 'yard',
  name = id,
  extra: Array<{ id: string; name: string }> = [],
) {
  const head = {
    id,
    name,
    summary: `${name} sentence`,
    falsifier: null,
    accent: '#22c55e',
    steward: 'quantanamo',
  };
  return {
    id,
    name,
    place,
    buildings: [
      head,
      ...extra.map((row) => ({
        ...head,
        id: row.id,
        name: row.name,
        summary: `${row.name} sentence`,
      })),
    ],
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

  test('a 0px host still gets a phone-sized drawing box', () => {
    expect(islandHostSize({ clientWidth: 0, clientHeight: 0 }, { width: 390, height: 756 })).toEqual({
      width: 390,
      height: 756,
    });
    expect(islandHostSize({ clientWidth: 390, clientHeight: 640 }, { width: 390, height: 756 })).toEqual({
      width: 390,
      height: 640,
    });
    expect(islandDrawingOk(0, 640)).toBe(false);
    expect(islandDrawingOk(390, 640)).toBe(true);
  });

  test('iPhone WebGL2 does not get the bokeh composer', () => {
    expect(islandAllowsComposer({ webgl2: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe(false);
    expect(islandAllowsComposer({ webgl2: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(false);
    expect(islandAllowsComposer({ webgl2: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' })).toBe(true);
    expect(islandAllowsComposer({ webgl2: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' })).toBe(false);
  });

  test('kits pick a place thought, not one shared set', () => {
    expect(islandKit('campus', 'neocloud_compute', 'Neocloud')).toBe('campus');
    expect(islandKit('plant', 'ai_power_nuclear', 'AI power')).toBe('plant');
    expect(islandKit('lab', 'quantum', 'Quantum computing')).toBe('lab-quantum');
    expect(islandKit('lab', 'biotech_royalty', 'Biotech and royalty')).toBe('lab-bio');
    expect(islandKit('lab', 'semis_photonics', 'Semiconductors')).toBe('lab-fab');
    expect(islandVoid('campus')).not.toBe(islandVoid('plant'));
    expect(islandVoid('plant')).toBe(ISLAND_CREAM);
    expect(islandVoid('campus')).not.toBe(0x000000);
  });

  test('neocloud is a night campus with halls and cable, not a wind farm', () => {
    const island = buildThesisIsland(district('neocloud_compute', 'campus', 'Neocloud basket'));
    expect(island.group.userData.kit).toBe('campus');
    expect(island.group.getObjectByName('hall-0')).toBeTruthy();
    expect(island.group.getObjectByName('cables')).toBeTruthy();
    expect(island.group.getObjectByName('cooling-tank')).toBeTruthy();
    expect(island.group.getObjectByName('sign-face')).toBeTruthy();
    expect(island.group.getObjectByName('hoop')).toBeFalsy();
    expect(island.group.getObjectByName('pond')).toBeFalsy();
    expect(island.group.getObjectByName('turbine-mast')).toBeFalsy();
    expect(island.group.getObjectByName('arch')).toBeFalsy();
    expect(island.hits).toHaveLength(1);
    expect(islandHitThesisId(island.hits[0] ?? null)).toBe('neocloud_compute');
    const kinds = geos(island.group);
    expect(kinds).not.toContain('ConeGeometry');
    island.dispose();
  });

  test('energy is a plant with a tower and pipes, not the ring-and-pond kit', () => {
    const island = buildThesisIsland(
      district('ai_power_nuclear', 'plant', 'AI power bottleneck beneficiaries'),
    );
    const tower = island.group.getObjectByName('cooling-tower');
    expect(tower).toBeInstanceOf(Mesh);
    expect((tower as Mesh).geometry).toBeInstanceOf(LatheGeometry);
    expect(island.group.getObjectByName('reactor-hall')).toBeTruthy();
    expect(island.group.getObjectByName('pipes')).toBeTruthy();
    expect(island.group.getObjectByName('hoop')).toBeFalsy();
    expect(island.group.getObjectByName('pond')).toBeFalsy();
    expect(island.group.getObjectByName('turbine-mast')).toBeFalsy();
    expect(island.group.getObjectByName('cables')).toBeFalsy();
    island.dispose();
  });

  test('lab flavors are different buildings, not one tower cluster', () => {
    const quantum = buildThesisIsland(district('quantum', 'lab', 'Quantum computing'));
    const bio = buildThesisIsland(district('biotech_royalty', 'lab', 'Biotech and royalty economics'));
    expect(quantum.group.userData.kit).toBe('lab-quantum');
    expect(bio.group.userData.kit).toBe('lab-bio');
    expect(quantum.group.getObjectByName('quantum-dome')).toBeTruthy();
    expect(bio.group.getObjectByName('bio-greenhouse')).toBeTruthy();
    expect(quantum.group.getObjectByName('bio-greenhouse')).toBeFalsy();
    expect(bio.group.getObjectByName('quantum-dome')).toBeFalsy();
    expect(quantum.group.getObjectByName('hoop')).toBeFalsy();
    expect(bio.group.getObjectByName('hoop')).toBeFalsy();
    quantum.dispose();
    bio.dispose();
  });

  test('related theses in one district are separate hit buildings', () => {
    const island = buildThesisIsland(district(
      'neocloud_compute',
      'campus',
      'Neocloud and GPU compute',
      [{ id: 'neocloud_compute_burst', name: 'Burst basket' }],
    ));
    expect(island.hits).toHaveLength(2);
    expect(islandHitThesisId(island.hits[0] ?? null)).toBe('neocloud_compute');
    expect(islandHitThesisId(island.hits[1] ?? null)).toBe('neocloud_compute_burst');
    island.dispose();
  });

  test('yard keeps faceted trees and the disk sits in a 390px portrait frustum', () => {
    const island = buildThesisIsland(district('earnings_gap_structure', 'yard', 'Earnings gap'));
    const canopy = island.group.getObjectByName('canopy-0');
    expect(canopy).toBeInstanceOf(Mesh);
    expect((canopy as Mesh).geometry).toBeInstanceOf(IcosahedronGeometry);
    const civic = island.group.getObjectByName('civic-hall');
    expect(civic).toBeTruthy();
    const edge = phoneNdc(new Vector3(ISLAND_RADIUS, ISLAND_GRASS_Y, 0));
    expect(Math.abs(edge.x)).toBeLessThan(0.82);
    expect(Math.abs(edge.y)).toBeLessThan(0.82);
    island.dispose();
  });
});
