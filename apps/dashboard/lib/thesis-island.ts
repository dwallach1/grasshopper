/**
 * Procedural miniature district. Authored geometry — no GLBs, no holograms.
 * Soil is stratified blocks. Labels are canvas on a physical sign.
 */
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Shape,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';

import type { ThesisDistrict, ThesisDistrictPlace } from './thesis-districts';
import { districtPlaceWord } from './thesis-districts';

export const ISLAND_CREAM = 0xefe6d4;
export const ISLAND_DPR_CAP = 1.5;

export const ISLAND_CAMERA = {
  x: 6.05,
  y: 5.15,
  z: 6.55,
  fov: 28,
  lookX: 0.05,
  lookY: 0.72,
  lookZ: 0.05,
} as const;

type Rng = () => number;

export type ThesisIsland = {
  group: Group;
  hits: Object3D[];
  turbines: Group[];
  dispose: () => void;
};

const EARTH = [0xd8c09a, 0xc4a574, 0xb08958, 0x9a7348, 0x86633c, 0x6f5130];
const GRASS = 0x9dbe6e;
const POND = 0x3d86b8;
const PATH = 0xc8bba4;
const TRACK = 0x9aa3ab;
const WHITE = 0xf3efe6;
const ORANGE = 0xd96a2c;
const TRUNK = 0x6a4e32;
const CANOPY = [0x8fbf62, 0x7eaf54, 0xa3c86f];
const HOUSE = [0xf2ebe0, 0xe7ddd0, 0xf7f2ea];
const ROOF = [0xc45ad0, 0xd96a2c, 0x6b7c9a];

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
    opts: { roughness?: number; metalness?: number; map?: Texture; name?: string } = {},
  ): MeshStandardMaterial {
    const key = `${hex}:${opts.roughness ?? 0.9}:${opts.metalness ?? 0}:${opts.map?.uuid ?? ''}:${opts.name ?? ''}`;
    const hit = this.mats.get(key);
    if (hit) return hit;
    const mat = new MeshStandardMaterial({
      color: new Color(hex),
      roughness: opts.roughness ?? 0.9,
      metalness: opts.metalness ?? 0,
      name: opts.name ?? `m-${hex.toString(16)}`,
    });
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

export function paintArchBadge(ctx: CanvasRenderingContext2D, word: string): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f7f4ee';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1f1b16';
  ctx.font = '800 54px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(word, w / 2, h / 2 + 2, w - 24);
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
  ctx.fillStyle = tint === 'cool' ? '#eef2f4' : '#f4efe6';
  ctx.fillRect(0, 0, w, h);
  const cols = 7;
  const rows = 9;
  const gw = 10;
  const gh = 7;
  const sx = (w - cols * 22) / 2;
  const sy = 18;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      ctx.fillStyle = (x + y) % 5 === 0 ? '#c45a4a' : '#6d7176';
      ctx.fillRect(sx + x * 22, sy + y * 16, gw, gh);
    }
  }
}

function paintGrass(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = '#9dbe6e';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 80; i += 1) {
    const x = (i * 47) % w;
    const y = (i * 31) % h;
    ctx.fillStyle = i % 3 === 0 ? '#8aaf5c' : i % 3 === 1 ? '#aad078' : '#7ea352';
    ctx.fillRect(x, y, 18 + (i % 7), 14 + (i % 5));
  }
}

function paintSolar(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = '#2f5fa0';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d7dee8';
  ctx.lineWidth = 3;
  for (let x = 0; x <= w; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
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
  const segs = 26;
  const layers = 6;
  const layerH = 0.22;
  const profile = islandOutline(rng, segs, radius);
  for (let layer = 0; layer < layers; layer += 1) {
    const y = layer * layerH + layerH / 2;
    const inset = 1 - layer * 0.018 + (layer % 2 === 0 ? 0.03 : -0.02);
    const hex = EARTH[layer] ?? EARTH[EARTH.length - 1]!;
    const fillR = radius * inset * 0.78;
    const fill = shelf.mesh(
      shelf.geo(new CylinderGeometry(fillR, fillR * 0.98, layerH * 0.98, 20)),
      shelf.mat(mixHex(hex, 0xb08958, 0.25)),
      `soil-fill-${layer}`,
    );
    fill.position.y = y;
    soil.add(fill);
    for (let i = 0; i < segs; i += 1) {
      const t = (i / segs) * Math.PI * 2;
      const r = profile[i]! * inset + (rng() - 0.5) * 0.16;
      const w = (2 * Math.PI * r) / segs + 0.06;
      const d = 0.38 + rng() * 0.28;
      const h = layerH * (0.92 + rng() * 0.28);
      const block = shelf.box(w, h, d, mixHex(hex, 0xe8d4b0, rng() * 0.18), `soil-${layer}-${i}`);
      block.position.set(Math.cos(t) * r, y + (h - layerH) * 0.2, Math.sin(t) * r);
      block.rotation.y = -t;
      soil.add(block);
    }
  }
  root.add(soil);
}

function addGrass(root: Group, shelf: Shelf, rng: Rng, radius: number, y: number): Mesh {
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
  const canvas = makeCanvas(256, 256);
  const ctx = context2d(canvas);
  if (ctx) paintGrass(ctx);
    const map = ctx && canvas ? shelf.tex(canvas) : undefined;
  const grass = shelf.mesh(
    shelf.geo(new ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: false, steps: 1 })),
    shelf.mat(GRASS, { map, roughness: 0.96 }),
    'grass',
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = y;
  root.add(grass);
  return grass;
}

function addPond(root: Group, shelf: Shelf, x: number, z: number, y: number, rng: Rng): void {
  const water = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.42, 0.42, 0.04, 20)),
    shelf.mat(POND, { roughness: 0.22, metalness: 0.08 }),
    'pond',
  );
  water.scale.set(1.35, 1, 0.82);
  water.position.set(x, y + 0.02, z);
  root.add(water);
  for (let i = 0; i < 10; i += 1) {
    const t = (i / 10) * Math.PI * 2;
    const stone = shelf.box(
      0.1 + rng() * 0.06,
      0.05,
      0.08 + rng() * 0.05,
      mixHex(0xc4b49a, 0x8a7a62, rng() * 0.4),
      `pond-stone-${i}`,
    );
    stone.position.set(x + Math.cos(t) * 0.58, y + 0.04, z + Math.sin(t) * 0.38);
    stone.rotation.y = t;
    root.add(stone);
  }
}

function addPath(root: Group, shelf: Shelf, y: number): void {
  const path = new Group();
  path.name = 'path';
  const pts = [
    [-0.9, 1.15],
    [-0.35, 0.7],
    [0.15, 0.15],
    [0.35, -0.35],
  ] as const;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const slab = shelf.box(0.28, 0.03, len + 0.04, PATH, `path-${i}`, { roughness: 0.95 });
    slab.position.set((ax + bx) / 2, y + 0.02, (az + bz) / 2);
    slab.rotation.y = Math.atan2(dx, dz);
    path.add(slab);
  }
  root.add(path);
}

function addTrack(root: Group, shelf: Shelf, radius: number, y: number): void {
  const rail = shelf.mesh(
    shelf.geo(new TorusGeometry(radius * 0.9, 0.035, 8, 48)),
    shelf.mat(TRACK, { roughness: 0.55, metalness: 0.12 }),
    'track',
  );
  rail.rotation.x = Math.PI / 2;
  rail.position.y = y + 0.12;
  root.add(rail);
  for (let i = 0; i < 10; i += 1) {
    const t = (i / 10) * Math.PI * 2;
    const post = shelf.box(0.045, 0.16, 0.045, 0x7d868e, `track-post-${i}`);
    post.position.set(Math.cos(t) * radius * 0.9, y + 0.06, Math.sin(t) * radius * 0.9);
    root.add(post);
  }
}

function addTree(root: Group, shelf: Shelf, rng: Rng, x: number, z: number, y: number, scale: number): void {
  const tree = new Group();
  tree.name = 'tree';
  const trunkH = 0.28 * scale;
  const trunk = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.035 * scale, 0.05 * scale, trunkH, 6)),
    shelf.mat(TRUNK, { roughness: 0.95 }),
    'trunk',
  );
  trunk.position.y = y + trunkH / 2;
  tree.add(trunk);
  const shade = CANOPY[Math.floor(rng() * CANOPY.length)]!;
  const blobs = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < blobs; i += 1) {
    const r = (0.16 + rng() * 0.08) * scale;
    const canopy = shelf.mesh(
      shelf.geo(new IcosahedronGeometry(r, 0)),
      shelf.mat(mixHex(shade, 0x5f8a3a, rng() * 0.25), { roughness: 0.92 }),
      `canopy-${i}`,
    );
    canopy.position.set(
      x + (rng() - 0.5) * 0.1 * scale,
      y + trunkH + r * 0.55 + i * 0.08 * scale,
      z + (rng() - 0.5) * 0.1 * scale,
    );
    canopy.scale.set(1, 0.82 + rng() * 0.12, 1);
    canopy.rotation.set(rng(), rng(), rng());
    tree.add(canopy);
  }
  trunk.position.x = x;
  trunk.position.z = z;
  root.add(tree);
}

function addHouse(root: Group, shelf: Shelf, rng: Rng, x: number, z: number, y: number): void {
  const w = 0.22 + rng() * 0.06;
  const d = 0.2 + rng() * 0.05;
  const h = 0.16 + rng() * 0.04;
  const body = shelf.box(w, h, d, HOUSE[Math.floor(rng() * HOUSE.length)]!, 'house-body');
  body.position.set(x, y + h / 2, z);
  body.rotation.y = rng() * 0.4 - 0.2;
  root.add(body);
  const shape = new Shape();
  shape.moveTo(-w * 0.62, 0);
  shape.lineTo(w * 0.62, 0);
  shape.lineTo(0, 0.12 + rng() * 0.03);
  const roof = shelf.mesh(
    shelf.geo(new ExtrudeGeometry(shape, { depth: d + 0.03, bevelEnabled: false })),
    shelf.mat(ROOF[Math.floor(rng() * ROOF.length)]!, { roughness: 0.88 }),
    'house-roof',
  );
  roof.position.set(x, y + h, z - (d + 0.03) / 2);
  roof.rotation.y = body.rotation.y;
  root.add(roof);
  const door = shelf.box(0.05, 0.07, 0.02, 0x4a3c30, 'house-door');
  door.position.set(x, y + 0.055, z + d / 2 + 0.01);
  root.add(door);
}

function addTurbine(root: Group, shelf: Shelf, x: number, z: number, y: number, turbines: Group[]): void {
  const mast = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.028, 0.04, 1.15, 8)),
    shelf.mat(WHITE, { roughness: 0.45 }),
    'turbine-mast',
  );
  mast.position.set(x, y + 0.58, z);
  root.add(mast);
  const nacelle = shelf.box(0.16, 0.07, 0.07, 0xe8e4dc, 'turbine-nacelle');
  nacelle.position.set(x + 0.04, y + 1.16, z);
  root.add(nacelle);
  const blades = new Group();
  blades.name = 'turbine-blades';
  blades.position.set(x + 0.12, y + 1.16, z);
  for (let i = 0; i < 3; i += 1) {
    const blade = shelf.box(0.045, 0.52, 0.012, 0xf4f1ea, `blade-${i}`);
    blade.position.y = 0.24;
    const arm = new Group();
    arm.rotation.z = (i * Math.PI * 2) / 3;
    arm.add(blade);
    blades.add(arm);
  }
  root.add(blades);
  turbines.push(blades);
}

function addMast(root: Group, shelf: Shelf, x: number, z: number, y: number): void {
  const h = 1.05;
  for (let i = 0; i < 6; i += 1) {
    const stripe = shelf.box(0.055, 0.16, 0.055, i % 2 === 0 ? 0xe8e0d4 : 0xc0453a, `mast-${i}`);
    stripe.position.set(x, y + 0.1 + i * 0.16, z);
    root.add(stripe);
  }
  for (let i = 0; i < 4; i += 1) {
    const brace = shelf.box(0.2, 0.018, 0.018, 0xc9c2b6, `mast-brace-${i}`);
    brace.position.set(x, y + 0.22 + i * 0.2, z);
    brace.rotation.z = i % 2 === 0 ? 0.7 : -0.7;
    root.add(brace);
  }
  const cap = shelf.box(0.12, 0.04, 0.12, 0xc0453a, 'mast-cap');
  cap.position.set(x, y + h, z);
  root.add(cap);
}

function addSolarRow(root: Group, shelf: Shelf, x: number, z: number, y: number): void {
  const canvas = makeCanvas(128, 80);
  const ctx = context2d(canvas);
  if (ctx) paintSolar(ctx);
    const map = ctx && canvas ? shelf.tex(canvas) : undefined;
  const mat = shelf.mat(0x2f5fa0, { map, roughness: 0.35, metalness: 0.15 });
  for (let i = 0; i < 4; i += 1) {
    const panel = shelf.mesh(shelf.geo(new BoxGeometry(0.34, 0.016, 0.22)), mat, `solar-${i}`);
    panel.position.set(x + (i % 2) * 0.38, y + 0.12, z + Math.floor(i / 2) * 0.26);
    panel.rotation.x = -0.45;
    root.add(panel);
    const stand = shelf.box(0.03, 0.1, 0.03, 0x8a9198, `solar-stand-${i}`);
    stand.position.set(panel.position.x, y + 0.05, panel.position.z + 0.04);
    root.add(stand);
  }
}

function addSign(
  root: Group,
  shelf: Shelf,
  title: string,
  x: number,
  z: number,
  y: number,
): void {
  const canvas = makeCanvas(512, 220);
  const ctx = context2d(canvas);
  if (ctx) paintThesisSign(ctx, title);
    const map = ctx && canvas ? shelf.tex(canvas) : undefined;
  const face = shelf.mesh(
    shelf.geo(new BoxGeometry(1.42, 0.58, 0.04)),
    shelf.mat(0xf7f4ee, { map, roughness: 0.82 }),
    'sign-face',
  );
  face.position.set(x, y + 0.72, z);
  face.rotation.y = 0.55;
  root.add(face);
  const frame = shelf.box(1.5, 0.66, 0.03, 0x2a2620, 'sign-frame');
  frame.position.copy(face.position);
  frame.position.z -= 0.03;
  frame.rotation.y = face.rotation.y;
  root.add(frame);
  for (const side of [-0.62, 0.62]) {
    const post = shelf.box(0.045, 0.78, 0.045, 0x2a2620, 'sign-post');
    post.position.set(x + side * Math.cos(0.55), y + 0.39, z + side * Math.sin(0.55));
    root.add(post);
  }
}

function addArch(root: Group, shelf: Shelf, word: string, y: number): void {
  const arch = shelf.mesh(
    shelf.geo(new TorusGeometry(1.85, 0.038, 10, 40, Math.PI * 1.08)),
    shelf.mat(ORANGE, { roughness: 0.42, metalness: 0.08 }),
    'arch',
  );
  arch.rotation.y = 0.7;
  arch.position.set(0.15, y + 0.02, -0.15);
  root.add(arch);
  const canvas = makeCanvas(256, 96);
  const ctx = context2d(canvas);
  if (ctx) paintArchBadge(ctx, word);
    const map = ctx && canvas ? shelf.tex(canvas) : undefined;
  const badge = shelf.mesh(
    shelf.geo(new BoxGeometry(0.72, 0.22, 0.04)),
    shelf.mat(0xf7f4ee, { map, roughness: 0.8 }),
    'arch-badge',
  );
  badge.position.set(0.15, y + 1.92, -0.15);
  badge.rotation.y = 0.7;
  root.add(badge);
}

function windowMat(shelf: Shelf, tint: 'warm' | 'cool'): MeshStandardMaterial {
  const canvas = makeCanvas(180, 220);
  const ctx = context2d(canvas);
  if (ctx) paintWindows(ctx, tint);
    const map = ctx && canvas ? shelf.tex(canvas) : undefined;
  return shelf.mat(WHITE, { map, roughness: 0.78, name: `win-${tint}` });
}

function addRoofSlab(root: Group, shelf: Shelf, x: number, y: number, z: number, w: number, d: number): void {
  const slab = shelf.box(w, 0.07, d, ORANGE, 'roof-slab', { roughness: 0.7 });
  slab.position.set(x, y, z);
  slab.rotation.y = 0.04;
  root.add(slab);
}

function addTowerCluster(
  root: Group,
  shelf: Shelf,
  origin: [number, number, number],
  thesisId: string,
  hits: Object3D[],
): void {
  const group = new Group();
  group.name = 'structure';
  group.userData.thesisId = thesisId;
  const glass = windowMat(shelf, 'warm');
  const towers = [
    { x: -0.28, z: 0.05, w: 0.42, d: 0.38, h: 1.05 },
    { x: 0.12, z: -0.02, w: 0.36, d: 0.34, h: 1.38 },
    { x: 0.42, z: 0.18, w: 0.3, d: 0.3, h: 0.82 },
  ];
  for (const [i, t] of towers.entries()) {
    const body = shelf.mesh(shelf.geo(new BoxGeometry(t.w, t.h, t.d)), glass, `tower-${i}`);
    body.position.set(origin[0] + t.x, origin[1] + t.h / 2, origin[2] + t.z);
    group.add(body);
    addRoofSlab(group, shelf, origin[0] + t.x, origin[1] + t.h + 0.04, origin[2] + t.z, t.w + 0.1, t.d + 0.1);
  }
  root.add(group);
  hits.push(group);
}

function addDataCampus(
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
  const halls = [
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
    }
  }
  const tank = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.16, 0.16, 0.38, 12)),
    shelf.mat(0xe8eef2, { roughness: 0.4, metalness: 0.12 }),
    'cooling-tank',
  );
  tank.position.set(origin[0] + 1.05, origin[1] + 0.2, origin[2] - 0.15);
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
  tower.position.set(origin[0] - 0.55, origin[1], origin[2] - 0.15);
  group.add(tower);
  const lip = shelf.mesh(
    shelf.geo(new CylinderGeometry(0.72, 0.72, 0.06, 20)),
    shelf.mat(0xd8d0c4, { roughness: 0.75 }),
    'cooling-lip',
  );
  lip.position.set(origin[0] - 0.55, origin[1] + 1.56, origin[2] - 0.15);
  group.add(lip);
  const glass = windowMat(shelf, 'warm');
  const hall = shelf.mesh(shelf.geo(new BoxGeometry(1.05, 0.72, 0.7)), glass, 'reactor-hall');
  hall.position.set(origin[0] + 0.55, origin[1] + 0.36, origin[2] + 0.12);
  group.add(hall);
  addRoofSlab(group, shelf, origin[0] + 0.55, origin[1] + 0.76, origin[2] + 0.12, 1.18, 0.82);
  for (const sx of [0.28, 0.58]) {
    const stack = shelf.mesh(
      shelf.geo(new CylinderGeometry(0.07, 0.09, 0.95, 10)),
      shelf.mat(0xd8d2c6, { roughness: 0.7 }),
      'stack',
    );
    stack.position.set(origin[0] + sx + 0.55, origin[1] + 1.15, origin[2] + 0.02);
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

function addStructure(
  root: Group,
  shelf: Shelf,
  place: ThesisDistrictPlace,
  thesisId: string,
  hits: Object3D[],
  y: number,
): void {
  const origin: [number, number, number] = [0.15, y, -0.25];
  if (place === 'campus') addDataCampus(root, shelf, origin, thesisId, hits);
  else if (place === 'plant') addPowerPlant(root, shelf, origin, thesisId, hits);
  else if (place === 'hangar') addHangar(root, shelf, origin, thesisId, hits);
  else if (place === 'lab') addTowerCluster(root, shelf, origin, thesisId, hits);
  else addCivicHall(root, shelf, origin, thesisId, hits);
}

function addDistantIsland(
  root: Group,
  shelf: Shelf,
  place: ThesisDistrictPlace,
  rng: Rng,
): void {
  const distant = new Group();
  distant.name = 'distant';
  distant.position.set(7.6, 1.55, -8.4);
  distant.scale.setScalar(0.42);
  addSoil(distant, shelf, rng, 2.6);
  addGrass(distant, shelf, rng, 2.55, 1.32);
  const block = shelf.box(0.9, 0.7, 0.55, WHITE, 'distant-hall');
  block.position.set(0.1, 1.7, 0);
  distant.add(block);
  addRoofSlab(distant, shelf, 0.1, 2.08, 0, 1.05, 0.68);
  addTree(distant, shelf, rng, -0.9, 0.6, 1.32, 1.1);
  addTree(distant, shelf, rng, 0.8, -0.5, 1.32, 0.9);
  if (place === 'plant') {
    const stub = shelf.mesh(
      shelf.geo(new CylinderGeometry(0.28, 0.36, 0.7, 10)),
      shelf.mat(0xe8e2d6),
      'distant-tower',
    );
    stub.position.set(-0.4, 1.7, -0.3);
    distant.add(stub);
  }
  root.add(distant);
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

export function buildThesisIsland(
  district: Pick<ThesisDistrict, 'id' | 'name' | 'place' | 'buildings'>,
  peek?: Pick<ThesisDistrict, 'id' | 'place'> | null,
): ThesisIsland {
  const shelf = new Shelf();
  const rng = rngFrom(district.id);
  const group = new Group();
  group.name = `island-${district.id}`;
  const radius = 3.15;
  const grassY = 1.32;
  const hits: Object3D[] = [];
  const turbines: Group[] = [];

  addSoil(group, shelf, rng, radius);
  addGrass(group, shelf, rngFrom(`${district.id}-grass`), radius, grassY);
  addPath(group, shelf, grassY);
  addPond(group, shelf, -1.15, 0.95, grassY, rng);
  addTrack(group, shelf, radius, grassY);

  const trees: Array<[number, number, number]> = [
    [-2.05, 0.35, 0.95],
    [-1.7, 1.55, 1.05],
    [1.85, 1.35, 1.15],
    [2.15, 0.15, 0.85],
    [1.55, -1.55, 1.0],
    [-1.85, -1.25, 1.1],
    [0.85, 1.85, 0.75],
    [-0.35, 2.05, 0.8],
  ];
  for (const [x, z, s] of trees) addTree(group, shelf, rng, x, z, grassY, s);

  const houses: Array<[number, number]> = [
    [1.15, 1.55],
    [1.45, 1.85],
    [0.85, 1.95],
    [-1.55, 1.75],
  ];
  for (const [x, z] of houses) addHouse(group, shelf, rng, x, z, grassY);

  addTurbine(group, shelf, 2.05, -0.85, grassY, turbines);
  addTurbine(group, shelf, 2.35, -0.35, grassY, turbines);
  addMast(group, shelf, -2.15, -0.55, grassY);
  if (district.place === 'campus') addSolarRow(group, shelf, -0.85, -1.35, grassY);
  else addSolarRow(group, shelf, 0.95, -1.45, grassY);

  const building = district.buildings[0];
  if (building) {
    addStructure(group, shelf, district.place, building.id, hits, grassY);
    addSign(group, shelf, building.name, -1.55, 1.55, grassY);
  }
  addArch(group, shelf, districtPlaceWord(district.place), grassY);

  if (peek) addDistantIsland(group, shelf, peek.place, rngFrom(peek.id));

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
  ctx.fillStyle = '#efe6d4';
  ctx.fillRect(0, 0, w, h);
  const cx = w * 0.48;
  const cy = h * 0.58;
  for (const [i, hex] of ['#6f5130', '#9a7348', '#c4a574', '#d8c09a'].entries()) {
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 18 - i * 10, 92 - i * 4, 36, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#9dbe6e';
  ctx.beginPath();
  ctx.ellipse(cx, cy - 18, 86, 32, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3d86b8';
  ctx.beginPath();
  ctx.ellipse(cx - 28, cy - 8, 16, 8, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f3efe6';
  ctx.fillRect(cx + 4, cy - 58, 22, 40);
  ctx.fillStyle = '#d96a2c';
  ctx.fillRect(cx, cy - 64, 30, 8);
  ctx.fillStyle = '#1f1b16';
  ctx.font = '700 18px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(districtPlaceWord(district.place), cx, h * 0.86);
}

export function islandPixelRatio(deviceRatio: number): number {
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) return 1;
  return Math.min(deviceRatio, ISLAND_DPR_CAP);
}
