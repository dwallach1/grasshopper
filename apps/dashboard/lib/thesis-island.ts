/**
 * Procedural miniature district. Authored geometry — no GLBs, no holograms.
 * Soil is stratified blocks. Labels are canvas on a physical sign.
 */
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';

import type { ThesisDistrict, ThesisDistrictPlace } from './thesis-districts';
import { districtPlaceWord } from './thesis-districts';

export const ISLAND_CREAM = 0xf3ead8;
export const ISLAND_DPR_CAP = 1.5;
export const ISLAND_GRASS_Y = 1.52;
export const ISLAND_RADIUS = 3.15;

/** Pulled-back 3/4: full disk in a light studio void. */
export const ISLAND_CAMERA = {
  x: 16.6,
  y: 9.4,
  z: 18.2,
  fov: 40,
  lookX: 0.0,
  lookY: 0.72,
  lookZ: 0.08,
} as const;

export type ThesisIslandKit =
  | 'campus'
  | 'plant'
  | 'hangar'
  | 'lab-quantum'
  | 'lab-bio'
  | 'lab-fab'
  | 'lab-soft'
  | 'yard';

export const ISLAND_VOID: Record<ThesisDistrictPlace, number> = {
  campus: 0xcfd6e4,
  plant: 0xf3ead8,
  hangar: 0xe6e2d8,
  lab: 0xe4eaf0,
  yard: 0xf3ead8,
};

export function islandVoid(place: ThesisDistrictPlace): number {
  return ISLAND_VOID[place] ?? ISLAND_CREAM;
}

export function islandKit(
  place: ThesisDistrictPlace,
  id: string,
  name = '',
): ThesisIslandKit {
  if (place !== 'lab') return place;
  const hay = `${id} ${name}`.toLowerCase();
  if (/quantum/.test(hay)) return 'lab-quantum';
  if (/biotech|bio\b|royalty/.test(hay)) return 'lab-bio';
  if (/photonics|semis|semiconductor|fab/.test(hay)) return 'lab-fab';
  return 'lab-soft';
}

type Rng = () => number;

export type ThesisIsland = {
  group: Group;
  hits: Object3D[];
  turbines: Group[];
  dispose: () => void;
};

const EARTH = [0xe6d2b0, 0xd4b896, 0xc4a06a, 0xb08958, 0x9c7d52, 0x8a6a3e];
const CLIFF = [0xe8d5b0, 0xd7c094, 0xc9b07a, 0xb89a62, 0xa3b07a, 0x8f9a68];
const GRASS = 0xc4d4a6;
const WHITE = 0xf6f2ea;
const ORANGE = 0xe07a32;
const TRUNK = 0x4a3828;
const CANOPY = [0x7d9a5c, 0x6f8c52, 0x8aa86a];
const BERRY = [0xe07a32, 0xc0453a];

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFrom(id: string): Rng {
  let a = hashId(id) || 1;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

class Shelf {
  readonly geos: BufferGeometry[] = [];
  readonly textures: Texture[] = [];
  private readonly mats = new Map<string, MeshStandardMaterial>();

  geo<T extends BufferGeometry>(geometry: T): T {
    this.geos.push(geometry);
    return geometry;
  }

  mat(
    hex: number,
    opts: {
      roughness?: number;
      metalness?: number;
      map?: Texture;
      name?: string;
      emissive?: number;
      emissiveIntensity?: number;
    } = {},
  ): MeshStandardMaterial {
    const key = `${hex}:${opts.roughness ?? 0.9}:${opts.metalness ?? 0}:${opts.map?.uuid ?? ''}:${opts.emissive ?? 0}:${opts.name ?? ''}`;
    const hit = this.mats.get(key);
    if (hit) return hit;
    const mat = new MeshStandardMaterial({
      color: new Color(hex),
      roughness: opts.roughness ?? 0.9,
      metalness: opts.metalness ?? 0,
      name: opts.name ?? `m-${hex.toString(16)}`,
    });
    if (opts.emissive != null) {
      mat.emissive = new Color(opts.emissive);
      mat.emissiveIntensity = opts.emissiveIntensity ?? 0.35;
    }
    if (opts.map) {
      mat.map = opts.map;
      mat.color.set(0xffffff);
    }
    this.mats.set(key, mat);
    return mat;
  }

  tex(canvas: HTMLCanvasElement): CanvasTexture {
    const map = new CanvasTexture(canvas);
    map.colorSpace = SRGBColorSpace;
    map.needsUpdate = true;
    this.textures.push(map);
    return map;
  }

  mesh(geometry: BufferGeometry, material: Material, name: string): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  box(w: number, h: number, d: number, hex: number, name: string, opts?: { roughness?: number }): Mesh {
    return this.mesh(this.geo(new BoxGeometry(w, h, d)), this.mat(hex, opts), name);
  }

  dispose(): void {
    for (const geo of this.geos) geo.dispose();
    for (const tex of this.textures) tex.dispose();
    for (const mat of this.mats.values()) mat.dispose();
  }
}

export function wrapSignLines(title: string, maxChars = 15): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export function paintThesisSign(ctx: CanvasRenderingContext2D, title: string): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f7f4ee';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#2c2620';
  ctx.fillRect(0, 0, w, 10);
  ctx.fillRect(0, h - 10, w, 10);
  ctx.fillRect(0, 0, 10, h);
  ctx.fillRect(w - 10, 0, 10, h);
  const lines = wrapSignLines(title);
  const size = lines.length > 2 ? 42 : lines.length > 1 ? 50 : 58;
  ctx.fillStyle = '#1f1b16';
  ctx.font = `700 ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const step = size + 10;
  const top = h / 2 - ((lines.length - 1) * step) / 2;
  for (const [i, line] of lines.entries()) {
    ctx.fillText(line.toUpperCase(), w / 2, top + i * step, w - 48);
  }
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (!canvas.getContext) return null;
    return canvas;
  } catch {
    return null;
  }
}

function context2d(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  if (!canvas) return null;
  return canvas.getContext('2d');
}

function paintWindows(ctx: CanvasRenderingContext2D, tint: 'warm' | 'cool'): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = tint === 'cool' ? '#f2f4f6' : '#f6f2ea';
  ctx.fillRect(0, 0, w, h);
  const cols = 8;
  const rows = 11;
  const sx = 16;
  const sy = 14;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      ctx.fillStyle = (x + y) % 4 === 0 ? '#c0453a' : '#2c2a28';
      ctx.fillRect(sx + x * 18, sy + y * 16, 12, 3);
    }
  }
}

function paintGrass(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = '#b7c89a';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i += 1) {
    const x = (i * 47) % w;
    const y = (i * 31) % h;
    ctx.fillStyle = i % 3 === 0 ? '#a8bc88' : i % 3 === 1 ? '#c2d2a6' : '#9aaf7a';
    ctx.fillRect(x, y, 16 + (i % 7), 12 + (i % 5));
  }
}

function islandOutline(rng: Rng, count: number, radius: number): number[] {
  const raw = Array.from({ length: count }, () => radius * (0.86 + rng() * 0.2));
  return raw.map((r, i) => {
    const a = raw[(i + count - 1) % count]!;
    const b = raw[(i + 1) % count]!;
    return (a + r + b) / 3;
  });
}

function addSoil(root: Group, shelf: Shelf, rng: Rng, radius: number): void {
  const soil = new Group();
  soil.name = 'soil';
  const hullPts: Vector2[] = [];
  for (let i = 0; i <= 16; i += 1) {
    const t = i / 16;
    const y = t * 1.08;
    const r = radius * (0.2 + 0.8 * Math.sin(t * Math.PI * 0.74));
    hullPts.push(new Vector2(Math.max(0.22, r), y));
  }
  const hull = shelf.mesh(
    shelf.geo(new LatheGeometry(hullPts, 28)),
    shelf.mat(0x4e3628, { roughness: 0.94 }),
    'soil-hull',
  );
  soil.add(hull);
  const segs = 40;
  const profile = islandOutline(rng, segs, radius);
  for (let ring = 0; ring < 3; ring += 1) {
    for (let i = 0; i < segs; i += 1) {
      const t = (i / segs) * Math.PI * 2 + ring * 0.07;
      const r = profile[i]! * (0.99 - ring * 0.055) + (rng() - 0.5) * 0.08;
      const w = 0.24 + rng() * 0.14;
      const d = 0.18 + rng() * 0.1;
      const h = 0.42 + rng() * 0.52 + (i % 4 === 0 ? 0.22 : 0);
      const hex = CLIFF[(i + ring * 3) % CLIFF.length]!;
      const block = shelf.box(w, h, d, mixHex(hex, EARTH[ring] ?? hex, rng() * 0.22), `soil-${ring}-${i}`);
      block.position.set(Math.cos(t) * r, 0.78 + h / 2, Math.sin(t) * r);
      block.rotation.y = -t;
      soil.add(block);
    }
  }
  const contact = new Mesh(
    shelf.geo(new CircleGeometry(radius * 0.92, 28)),
    new MeshBasicMaterial({ color: 0xc9b89a, transparent: true, opacity: 0.22 }),
  );
  contact.name = 'soil-contact';
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.03;
  soil.add(contact);
  root.add(soil);
}

function addGrass(root: Group, shelf: Shelf, rng: Rng, radius: number, y: number, hex = GRASS): Mesh {
  const shape = new Shape();
  const segs = 28;
  const profile = islandOutline(rng, segs, radius * 0.96);
  for (let i = 0; i <= segs; i += 1) {
    const t = (i / segs) * Math.PI * 2;
    const r = profile[i % segs]!;
    const x = Math.cos(t) * r;
    const z = Math.sin(t) * r;
    if (i === 0) shape.moveTo(x, z);
    else shape.lineTo(x, z);
  }
  shape.closePath();
  const canvas = hex === GRASS ? makeCanvas(256, 256) : null;
  const ctx = context2d(canvas);
  if (ctx) paintGrass(ctx);
    const map = ctx && canvas ? shelf.tex(canvas) : undefined;
  const grass = shelf.mesh(
    shelf.geo(new ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: false, steps: 1 })),
    shelf.mat(hex, { map, roughness: 0.96 }),
    'grass',
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = y;
  root.add(grass);
  return grass;
}

function addTree(root: Group, shelf: Shelf, rng: Rng, x: number, z: number, y: number, scale: number): void {
  const tree = new Group();
  tree.name = 'tree';
  const trunkH = 0.34 * scale;
  const trunk = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.018 * scale, 0.028 * scale, trunkH, 5)),
    shelf.mat(TRUNK, { roughness: 0.96 }),
    'trunk',
  );
  trunk.position.set(x, y + trunkH / 2, z);
  tree.add(trunk);
  const shade = CANOPY[Math.floor(rng() * CANOPY.length)]!;
  for (let i = 0; i < 4; i += 1) {
    const r = (0.14 + rng() * 0.1) * scale;
    const canopy = shelf.mesh(
      shelf.geo(new IcosahedronGeometry(r, 0)),
      shelf.mat(mixHex(shade, 0x4f6a38, rng() * 0.22), { roughness: 0.93 }),
      `canopy-${i}`,
    );
    canopy.position.set(
      x + (rng() - 0.5) * 0.16 * scale,
      y + trunkH + r * 0.45 + i * 0.05 * scale,
      z + (rng() - 0.5) * 0.16 * scale,
    );
    canopy.scale.set(1.15, 0.72 + rng() * 0.18, 1.05);
    canopy.rotation.set(rng() * 1.2, rng() * 2, rng());
    tree.add(canopy);
  }
  if (rng() > 0.45) {
    const berry = shelf.mesh(
      shelf.geo(new SphereGeometry(0.035 * scale, 8, 6)),
      shelf.mat(BERRY[Math.floor(rng() * BERRY.length)]!, { roughness: 0.55 }),
      'berry',
    );
    berry.position.set(x + 0.08 * scale, y + trunkH + 0.12 * scale, z + 0.04 * scale);
    tree.add(berry);
  }
  root.add(tree);
}

function addSign(
  root: Group,
  shelf: Shelf,
  title: string,
  x: number,
  z: number,
  y: number,
): void {
  const canvas = makeCanvas(640, 240);
  const ctx = context2d(canvas);
  if (ctx) paintThesisSign(ctx, title);
  const map = ctx && canvas ? shelf.tex(canvas) : undefined;
  const yaw = 0.72;
  const face = shelf.mesh(
    shelf.geo(new BoxGeometry(2.28, 0.92, 0.045)),
    shelf.mat(0xf7f4ee, { map, roughness: 0.8 }),
    'sign-face',
  );
  face.position.set(x, y + 1.08, z);
  face.rotation.y = yaw;
  root.add(face);
  for (const side of [-0.86, 0.86]) {
    const post = shelf.mesh(
      shelf.geo(new CylinderGeometry(0.024, 0.024, 1.14, 8)),
      shelf.mat(0xf4efe6, { roughness: 0.5 }),
      'sign-post',
    );
    post.position.set(x + side * Math.cos(yaw), y + 0.57, z + side * Math.sin(yaw));
    root.add(post);
  }
}

function windowMat(shelf: Shelf, tint: 'warm' | 'cool', night = false): MeshStandardMaterial {
  const canvas = makeCanvas(180, 220);
  const ctx = context2d(canvas);
  if (ctx) paintWindows(ctx, tint);
    const map = ctx && canvas ? shelf.tex(canvas) : undefined;
  return shelf.mat(WHITE, {
    map,
    roughness: 0.78,
    name: `win-${tint}${night ? '-night' : ''}`,
    emissive: night ? 0xffc878 : undefined,
    emissiveIntensity: night ? 0.42 : undefined,
  });
}

function addRoofSlab(root: Group, shelf: Shelf, x: number, y: number, z: number, w: number, d: number): void {
  const slab = shelf.box(w, 0.07, d, ORANGE, 'roof-slab', { roughness: 0.7 });
  slab.position.set(x, y, z);
  slab.rotation.y = 0.04;
  root.add(slab);
}

function addDataCampus(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
  fans: Group[],
  compact = false,
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const glass = windowMat(shelf, 'cool', true);
  const halls = compact
    ? [{ x: 0, z: 0, w: 1.2, d: 0.48, h: 0.44 }]
    : [
        { x: -0.42, z: 0.05, w: 1.55, d: 0.52, h: 0.48 },
        { x: 0.38, z: 0.42, w: 1.15, d: 0.46, h: 0.4 },
      ];
  for (const [i, hall] of halls.entries()) {
    const body = shelf.mesh(shelf.geo(new BoxGeometry(hall.w, hall.h, hall.d)), glass, `hall-${i}`);
    body.position.set(origin[0] + hall.x, origin[1] + hall.h / 2, origin[2] + hall.z);
    group.add(body);
    const roof = shelf.box(hall.w + 0.06, 0.05, hall.d + 0.06, 0xdfe4ea, `hall-roof-${i}`);
    roof.position.set(origin[0] + hall.x, origin[1] + hall.h + 0.03, origin[2] + hall.z);
    group.add(roof);
    for (let u = 0; u < 3; u += 1) {
      const unit = shelf.box(0.16, 0.1, 0.14, WHITE, `cool-unit-${i}-${u}`);
      unit.position.set(
        origin[0] + hall.x - hall.w / 2 + 0.28 + u * 0.32,
        origin[1] + hall.h + 0.1,
        origin[2] + hall.z,
      );
      group.add(unit);
      const fan = new Group();
      fan.name = 'cool-fan';
      fan.position.copy(unit.position);
      const blade = shelf.box(0.12, 0.01, 0.03, 0xd8dee6, `cool-fan-${i}-${u}`);
      fan.add(blade);
      group.add(fan);
      fans.push(fan);
    }
  }
  const tank = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.16, 0.16, 0.38, 12)),
    shelf.mat(0xe8eef2, { roughness: 0.4, metalness: 0.12 }),
    'cooling-tank',
  );
  tank.position.set(origin[0] + (compact ? 0.72 : 1.05), origin[1] + 0.2, origin[2] - 0.15);
  group.add(tank);
  root.add(group);
  hits.push(group);
}

function addPowerPlant(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const pts: Vector2[] = [];
  for (let i = 0; i <= 20; i += 1) {
    const t = i / 20;
    const y = t * 1.55;
    const r = 0.58 + 0.62 * (t - 0.4) * (t - 0.4);
    pts.push(new Vector2(r, y));
  }
  const tower = shelf.mesh(
    shelf.geo(new LatheGeometry(pts, 24)),
    shelf.mat(0xe8e2d6, { roughness: 0.82 }),
    'cooling-tower',
  );
  tower.position.set(origin[0], origin[1], origin[2]);
  group.add(tower);
  const lip = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.72, 0.72, 0.06, 20)),
    shelf.mat(0xd8d0c4, { roughness: 0.75 }),
    'cooling-lip',
  );
  lip.position.set(origin[0], origin[1] + 1.56, origin[2]);
  group.add(lip);
  const glass = windowMat(shelf, 'warm');
  const hall = shelf.mesh(shelf.geo(new BoxGeometry(1.05, 0.72, 0.7)), glass, 'reactor-hall');
  hall.position.set(origin[0] + 0.9, origin[1] + 0.36, origin[2] - 0.7);
  group.add(hall);
  addRoofSlab(group, shelf, origin[0] + 0.9, origin[1] + 0.76, origin[2] - 0.7, 1.18, 0.82);
  for (const sx of [0.28, 0.58]) {
    const stack = shelf.mesh(
      shelf.geo(new CylinderGeometry(0.07, 0.09, 0.95, 10)),
      shelf.mat(0xd8d2c6, { roughness: 0.7 }),
      'stack',
    );
    stack.position.set(origin[0] + sx + 0.9, origin[1] + 1.15, origin[2] - 0.7);
    group.add(stack);
    const rim = shelf.mesh(
      shelf.geo(new CylinderGeometry(0.08, 0.08, 0.05, 10)),
      shelf.mat(0x4a4540),
      'stack-rim',
    );
    rim.position.set(stack.position.x, origin[1] + 1.62, stack.position.z);
    group.add(rim);
  }
  root.add(group);
  hits.push(group);
}

function addHangar(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const hall = shelf.box(1.9, 0.62, 1.05, WHITE, 'hangar-hall', { roughness: 0.84 });
  hall.position.set(origin[0], origin[1] + 0.31, origin[2]);
  group.add(hall);
  const door = shelf.box(0.95, 0.42, 0.04, 0x4d555c, 'hangar-door');
  door.position.set(origin[0], origin[1] + 0.24, origin[2] + 0.54);
  group.add(door);
  addRoofSlab(group, shelf, origin[0], origin[1] + 0.66, origin[2], 2.05, 1.18);
  const tower = shelf.mesh(
    shelf.geo(new BoxGeometry(0.28, 0.7, 0.28)),
    windowMat(shelf, 'cool'),
    'control-tower',
  );
  tower.position.set(origin[0] + 0.95, origin[1] + 0.55, origin[2] - 0.28);
  group.add(tower);
  addRoofSlab(group, shelf, origin[0] + 0.95, origin[1] + 0.94, origin[2] - 0.28, 0.36, 0.36);
  root.add(group);
  hits.push(group);
}

function addCivicHall(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const hall = shelf.mesh(
    shelf.geo(new BoxGeometry(0.95, 0.62, 0.7)),
    windowMat(shelf, 'warm'),
    'civic-hall',
  );
  hall.position.set(origin[0], origin[1] + 0.31, origin[2]);
  group.add(hall);
  addRoofSlab(group, shelf, origin[0], origin[1] + 0.66, origin[2], 1.1, 0.84);
  const wing = shelf.box(0.48, 0.4, 0.42, WHITE, 'civic-wing');
  wing.position.set(origin[0] + 0.62, origin[1] + 0.2, origin[2] + 0.12);
  group.add(wing);
  addRoofSlab(group, shelf, origin[0] + 0.62, origin[1] + 0.44, origin[2] + 0.12, 0.56, 0.5);
  root.add(group);
  hits.push(group);
}

const BUILDING_LOTS: Array<[number, number]> = [
  [0.15, -0.25],
  [1.15, 0.85],
  [-1.1, 0.55],
  [0.9, -1.2],
];

function addCables(root: Group, shelf: Shelf, y: number): void {
  const cables = new Group();
  cables.name = 'cables';
  for (const [i, [x1, z1, x2, z2]] of [
    [-1.6, -0.8, 1.7, -0.6],
    [-1.4, 0.2, 1.5, 0.55],
    [-0.8, -1.4, 0.9, 1.3],
  ].entries()) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const tray = shelf.box(len, 0.03, 0.08, 0x6a7380, `cable-${i}`);
    tray.position.set((x1 + x2) / 2, y + 0.04, (z1 + z2) / 2);
    tray.rotation.y = -Math.atan2(dz, dx);
    cables.add(tray);
  }
  root.add(cables);
}

function addPoles(root: Group, shelf: Shelf, y: number): void {
  for (const [i, [x, z]] of [[-2.05, -0.55], [2.05, -0.85], [1.85, 1.45]].entries()) {
    const pole = shelf.mesh(
      shelf.geo(new CylinderGeometry(0.03, 0.03, 0.85, 8)),
      shelf.mat(0x8a9198, { roughness: 0.55 }),
      `pole-${i}`,
    );
    pole.position.set(x, y + 0.42, z);
    root.add(pole);
    const lamp = shelf.mesh(
      shelf.geo(new SphereGeometry(0.07, 8, 6)),
      shelf.mat(0xffe6b0, { roughness: 0.35, emissive: 0xffc878, emissiveIntensity: 0.7 }),
      `lamp-${i}`,
    );
    lamp.position.set(x, y + 0.88, z);
    root.add(lamp);
  }
}

function addPipes(root: Group, shelf: Shelf, y: number): void {
  const pipes = new Group();
  pipes.name = 'pipes';
  for (const [i, [x, z, len, yaw]] of [
    [1.55, 0.15, 1.6, 0.2],
    [-1.45, 0.35, 1.35, -0.4],
    [0.35, 1.55, 1.2, 1.2],
  ].entries()) {
    const pipe = shelf.mesh(
      shelf.geo(new CylinderGeometry(0.05, 0.05, len, 10)),
      shelf.mat(0xb8a070, { roughness: 0.45, metalness: 0.18 }),
      `pipe-${i}`,
    );
    pipe.position.set(x, y + 0.12, z);
    pipe.rotation.z = Math.PI / 2;
    pipe.rotation.y = yaw;
    pipes.add(pipe);
  }
  const vat = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.28, 0.28, 0.55, 14)),
    shelf.mat(0xc8c2b4, { roughness: 0.5, metalness: 0.12 }),
    'plant-vat',
  );
  vat.position.set(-1.15, y + 0.28, -1.15);
  pipes.add(vat);
  root.add(pipes);
}

function addRunway(root: Group, shelf: Shelf, y: number): void {
  const strip = shelf.box(0.55, 0.02, 3.4, 0xc9c4b8, 'runway');
  strip.position.set(-1.35, y + 0.08, 0.1);
  root.add(strip);
  for (let i = 0; i < 6; i += 1) {
    const dash = shelf.box(0.08, 0.015, 0.28, 0xf4efe6, `runway-dash-${i}`);
    dash.position.set(-1.35, y + 0.1, -1.2 + i * 0.5);
    root.add(dash);
  }
}

function addQuantumLab(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const hall = shelf.mesh(
    shelf.geo(new BoxGeometry(0.95, 0.42, 0.7)),
    windowMat(shelf, 'cool'),
    'quantum-hall',
  );
  hall.position.set(origin[0], origin[1] + 0.21, origin[2]);
  group.add(hall);
  const dome = shelf.mesh(
    shelf.geo(new SphereGeometry(0.42, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)),
    shelf.mat(0xd8e4ee, { roughness: 0.28, metalness: 0.22 }),
    'quantum-dome',
  );
  dome.position.set(origin[0] + 0.85, origin[1], origin[2] + 0.15);
  group.add(dome);
  const cryo = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.16, 0.2, 0.7, 12)),
    shelf.mat(0xc5d0da, { roughness: 0.35, metalness: 0.2 }),
    'quantum-cryo',
  );
  cryo.position.set(origin[0] - 0.7, origin[1] + 0.35, origin[2] + 0.35);
  group.add(cryo);
  root.add(group);
  hits.push(group);
}

function addBioLab(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const house = shelf.mesh(
    shelf.geo(new BoxGeometry(1.15, 0.5, 0.72)),
    windowMat(shelf, 'warm'),
    'bio-hall',
  );
  house.position.set(origin[0], origin[1] + 0.25, origin[2]);
  group.add(house);
  const glass = shelf.mesh(
    shelf.geo(new BoxGeometry(0.7, 0.38, 0.55)),
    shelf.mat(0xb7d4c4, { roughness: 0.22, metalness: 0.08, emissive: 0x7fbf90, emissiveIntensity: 0.18 }),
    'bio-greenhouse',
  );
  glass.position.set(origin[0] + 0.95, origin[1] + 0.2, origin[2] + 0.2);
  group.add(glass);
  for (const [i, dx] of [-0.2, 0.15, 0.5].entries()) {
    const vat = shelf.mesh(
      shelf.geo(new CylinderGeometry(0.12, 0.12, 0.32, 10)),
      shelf.mat(0xd8c4a8, { roughness: 0.4 }),
      `bio-vat-${i}`,
    );
    vat.position.set(origin[0] - 0.85 + dx, origin[1] + 0.16, origin[2] + 0.55);
    group.add(vat);
  }
  root.add(group);
  hits.push(group);
}

function addFabLab(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const hall = shelf.mesh(
    shelf.geo(new BoxGeometry(1.85, 0.4, 0.62)),
    windowMat(shelf, 'cool'),
    'fab-hall',
  );
  hall.position.set(origin[0], origin[1] + 0.2, origin[2]);
  group.add(hall);
  const roof = shelf.box(1.95, 0.06, 0.7, 0xe8d27a, 'fab-roof');
  roof.position.set(origin[0], origin[1] + 0.43, origin[2]);
  group.add(roof);
  for (let i = 0; i < 4; i += 1) {
    const bay = shelf.box(0.28, 0.22, 0.28, 0xf2efe6, `fab-bay-${i}`);
    bay.position.set(origin[0] - 0.7 + i * 0.46, origin[1] + 0.54, origin[2]);
    group.add(bay);
  }
  root.add(group);
  hits.push(group);
}

function addSoftLab(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const glass = windowMat(shelf, 'cool');
  const mid = shelf.mesh(shelf.geo(new BoxGeometry(0.85, 0.95, 0.55)), glass, 'soft-tower');
  mid.position.set(origin[0], origin[1] + 0.48, origin[2]);
  group.add(mid);
  const wing = shelf.box(0.7, 0.38, 0.48, WHITE, 'soft-wing');
  wing.position.set(origin[0] + 0.7, origin[1] + 0.19, origin[2] + 0.15);
  group.add(wing);
  root.add(group);
  hits.push(group);
}

function addPlaceBuildings(
  root: Group,
  shelf: Shelf,
  kit: ThesisIslandKit,
  buildings: ReadonlyArray<{ id: string }>,
  hits: Object3D[],
  fans: Group[],
  y: number,
): void {
  for (const [index, building] of buildings.entries()) {
    const lot = BUILDING_LOTS[index] ?? BUILDING_LOTS[BUILDING_LOTS.length - 1]!;
    const origin: [number, number, number] = [lot[0], y, lot[1]];
    const extra = index > 0;
    if (kit === 'campus') addDataCampus(root, shelf, origin, building.id, hits, fans, extra);
    else if (kit === 'plant') {
      if (index === 0) addPowerPlant(root, shelf, origin, building.id, hits);
      else addCivicHall(root, shelf, origin, building.id, hits);
    } else if (kit === 'hangar') addHangar(root, shelf, origin, building.id, hits);
    else if (kit === 'lab-quantum') addQuantumLab(root, shelf, origin, building.id, hits);
    else if (kit === 'lab-bio') addBioLab(root, shelf, origin, building.id, hits);
    else if (kit === 'lab-fab') addFabLab(root, shelf, origin, building.id, hits);
    else if (kit === 'lab-soft') addSoftLab(root, shelf, origin, building.id, hits);
    else addCivicHall(root, shelf, origin, building.id, hits);
  }
}

export function islandHitThesisId(object: Object3D | null): string | null {
  let node: Object3D | null = object;
  while (node) {
    if (typeof node.userData.thesisId === 'string' && node.userData.thesisId) {
      return node.userData.thesisId;
    }
    node = node.parent;
  }
  return null;
}

function padHex(kit: ThesisIslandKit): number {
  if (kit === 'campus') return 0x9aa6b4;
  if (kit === 'plant') return 0xb9a57a;
  if (kit === 'hangar') return 0xc8c4ba;
  if (kit === 'lab-fab') return 0xd0d4c8;
  if (kit === 'lab-quantum') return 0xc5ced8;
  if (kit === 'lab-bio') return 0xb7c9a8;
  if (kit === 'lab-soft') return 0xc8d0d6;
  return GRASS;
}

export function buildThesisIsland(
  district: Pick<ThesisDistrict, 'id' | 'name' | 'place' | 'buildings'>,
  _peek?: Pick<ThesisDistrict, 'id' | 'place'> | null,
): ThesisIsland {
  const shelf = new Shelf();
  const rng = rngFrom(district.id);
  const group = new Group();
  group.name = `island-${district.id}`;
  const kit = islandKit(district.place, district.id, district.name);
  group.userData.kit = kit;
  const radius = ISLAND_RADIUS;
  const grassY = ISLAND_GRASS_Y;
  const hits: Object3D[] = [];
  const turbines: Group[] = [];

  addSoil(group, shelf, rng, radius);
  addGrass(group, shelf, rngFrom(`${district.id}-grass`), radius, grassY, padHex(kit));

  if (kit === 'campus') {
    addCables(group, shelf, grassY);
    addPoles(group, shelf, grassY);
  } else if (kit === 'plant') {
    addPipes(group, shelf, grassY);
  } else if (kit === 'hangar') {
    addRunway(group, shelf, grassY);
  } else if (kit === 'lab-bio' || kit === 'yard') {
    addTree(group, shelf, rng, -2.05, 1.35, grassY, 1.05);
    addTree(group, shelf, rng, 2.15, -1.25, grassY, 0.92);
    addTree(group, shelf, rng, -1.55, -1.55, grassY, 0.88);
  }

  addPlaceBuildings(group, shelf, kit, district.buildings, hits, turbines, grassY);
  const titled = district.buildings[0]?.name ?? district.name;
  addSign(group, shelf, titled, -1.75, 1.55, grassY);

  return {
    group,
    hits,
    turbines,
    dispose: () => {
      group.removeFromParent();
      shelf.dispose();
    },
  };
}

export function paintIslandPoster(
  ctx: CanvasRenderingContext2D,
  district: Pick<ThesisDistrict, 'name' | 'place'>,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const voidHex = islandVoid(district.place);
  ctx.fillStyle = `#${voidHex.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, w, h);
  const cx = w * 0.48;
  const cy = h * 0.58;
  const kit = islandKit(district.place, district.name, district.name);
  for (const [i, hex] of ['#6f5130', '#9a7348', '#c4a574', '#d8c09a'].entries()) {
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 18 - i * 10, 92 - i * 4, 36, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = kit === 'campus' ? '#8fa0b4' : kit === 'plant' ? '#c4a06a' : '#9dbe6e';
  ctx.beginPath();
  ctx.ellipse(cx, cy - 18, 86, 32, -0.4, 0, Math.PI * 2);
  ctx.fill();
  if (kit === 'campus') {
    ctx.fillStyle = '#dfe6ee';
    ctx.fillRect(cx - 28, cy - 48, 54, 22);
    ctx.fillRect(cx + 8, cy - 40, 40, 16);
    ctx.fillStyle = '#f0c878';
    ctx.fillRect(cx - 22, cy - 42, 8, 4);
  } else if (kit === 'plant') {
    ctx.fillStyle = '#e8e2d6';
    ctx.beginPath();
    ctx.ellipse(cx - 8, cy - 48, 18, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c0453a';
    ctx.fillRect(cx + 12, cy - 42, 28, 14);
  } else if (kit.startsWith('lab')) {
    ctx.fillStyle = '#f3efe6';
    ctx.fillRect(cx + 2, cy - 62, 18, 36);
    ctx.fillRect(cx + 22, cy - 50, 14, 24);
    ctx.fillStyle = '#d96a2c';
    ctx.fillRect(cx, cy - 66, 24, 6);
  } else {
    ctx.fillStyle = '#f3efe6';
    ctx.fillRect(cx - 10, cy - 50, 36, 24);
  }
  ctx.fillStyle = '#1f1b16';
  ctx.font = '700 18px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(districtPlaceWord(district.place), cx, h * 0.86);
}

export function islandPixelRatio(deviceRatio: number): number {
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) return 1;
  return Math.min(deviceRatio, ISLAND_DPR_CAP);
}

export function islandHostSize(
  host: { clientWidth: number; clientHeight: number },
  viewport: { width: number; height: number },
): { width: number; height: number } {
  const width = Math.max(host.clientWidth, 0);
  const height = Math.max(host.clientHeight, 0);
  if (width >= 8 && height >= 8) return { width, height };
  return {
    width: Math.max(8, Math.round(viewport.width || 390)),
    height: Math.max(8, Math.round(viewport.height || 640)),
  };
}

export function islandDrawingOk(width: number, height: number): boolean {
  return width >= 8 && height >= 8;
}

/** Bokeh / EffectComposer often presents a black frame on iOS WebGL2. */
export function islandAllowsComposer(input: {
  webgl2: boolean;
  userAgent: string;
  maxTouchPoints?: number;
}): boolean {
  if (!input.webgl2) return false;
  const ua = input.userAgent;
  if (/iP(hone|ad|od)/i.test(ua)) return false;
  if (/Macintosh/i.test(ua) && (input.maxTouchPoints ?? 0) > 1) return false;
  return true;
}
