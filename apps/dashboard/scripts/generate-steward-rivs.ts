/**
 * Generate loadable steward .riv binaries with @stevysmith/rive-generator@0.1.1.
 * Constraints from that tool: one Node under each artboard, no CubicVertex,
 * no cornerRadius, dummy shape first, gradient shapes last (we use solids).
 *
 * Animation names do not survive @rive-app/canvas, so each steward×play is
 * its own artboard with one default linear clip. The official runtime picks
 * the artboard by name and autoplays that clip.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hex, ObjectType, PropertyKey, RiveFile, rgba } from '@stevysmith/rive-generator';

import {
  stewardFaceLayout,
  stewardFurTone,
  stewardSilhouette,
  type StewardBotKind,
} from '../lib/desk-avatar';
import {
  STEWARD_RIVE_KINDS,
  STEWARD_RIVE_PLAYS,
  stewardRiveArtboard,
  type StewardRivePlay,
} from '../lib/steward-rive';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(here, '..');
const outRiv = join(dashboardRoot, 'public/stewards/stewards.riv');
const wasmSrc = join(dashboardRoot, 'node_modules/@rive-app/canvas/rive.wasm');
const wasmDest = join(dashboardRoot, 'public/rive/rive.wasm');

const ARTBOARD = 96;
const FIGURE_X = 48;
const FIGURE_Y = 78;

type Pt = { x: number; y: number };

type PlayMotion = {
  duration: number;
  bounceY: number;
  scaleX: number;
  scaleY: number;
  lidMul: number;
  loop: 'loop' | 'oneShot';
};

const PLAY_MOTION = {
  still: { duration: 2, bounceY: 0, scaleX: 1, scaleY: 1, lidMul: 1, loop: 'oneShot' },
  idle: { duration: 168, bounceY: -3.4, scaleX: 1.05, scaleY: 0.95, lidMul: 1, loop: 'loop' },
  up: { duration: 126, bounceY: -5.2, scaleX: 1.07, scaleY: 0.93, lidMul: 0.78, loop: 'loop' },
  down: { duration: 210, bounceY: -1.8, scaleX: 1.03, scaleY: 0.97, lidMul: 1.22, loop: 'loop' },
  alive: { duration: 120, bounceY: -4.6, scaleX: 1.06, scaleY: 0.94, lidMul: 0.9, loop: 'loop' },
} satisfies Record<StewardRivePlay, PlayMotion>;

function toFigure(pathPoint: Pt): Pt {
  // PR #28 SVG: viewBox 80, inner translate(8 7), path in 64-space.
  // Center that 80 tile inside the 96 artboard, then subtract the figure origin.
  return { x: pathPoint.x - 32, y: pathPoint.y - 63 };
}

function parseSilhouette(d: string): Pt[] {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g);
  if (!tokens) throw new Error(`empty path: ${d}`);
  const points: Pt[] = [];
  let i = 0;
  let cursor: Pt = { x: 0, y: 0 };
  while (i < tokens.length) {
    const cmd = tokens[i];
    if (cmd === 'M') {
      cursor = { x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) };
      points.push(cursor);
      i += 3;
      continue;
    }
    if (cmd === 'C') {
      const c1 = { x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) };
      const c2 = { x: Number(tokens[i + 3]), y: Number(tokens[i + 4]) };
      const end = { x: Number(tokens[i + 5]), y: Number(tokens[i + 6]) };
      for (let step = 1; step <= 6; step += 1) {
        points.push(cubic(cursor, c1, c2, end, step / 6));
      }
      cursor = end;
      i += 7;
      continue;
    }
    if (cmd === 'Z') {
      i += 1;
      continue;
    }
    throw new Error(`unsupported path token ${cmd}`);
  }
  return points.map(toFigure);
}

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function addArtboard(riv: RiveFile, name: string): number {
  return riv.addObject(
    ObjectType.Artboard,
    [
      { key: PropertyKey.name, value: name },
      { key: PropertyKey.width, value: ARTBOARD },
      { key: PropertyKey.height, value: ARTBOARD },
      { key: PropertyKey.clip, value: 0 },
    ],
  );
}

function addFilledEllipse(
  riv: RiveFile,
  parent: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
  rotation = 0,
): number {
  const drawable = riv.addObject(
    ObjectType['Shape'],
    [
      { key: PropertyKey.name, value: name },
      { key: PropertyKey.x, value: x },
      { key: PropertyKey.y, value: y },
      { key: PropertyKey.rotation, value: rotation },
    ],
    parent,
  );
  riv.addEllipse(drawable, { width, height });
  const fill = riv.addFill(drawable);
  riv.addSolidColor(fill, color);
  return drawable;
}

function addFilledPath(riv: RiveFile, parent: number, name: string, points: Pt[], color: number): number {
  const drawable = riv['addShape'](parent, { name });
  const path = riv.addPointsPath(drawable, { name: `${name}Path`, closed: true });
  for (const point of points) {
    riv.addVertex(path, point);
  }
  const fill = riv.addFill(drawable);
  riv.addSolidColor(fill, color);
  return drawable;
}

function addDummy(riv: RiveFile, parent: number): void {
  const dummy = riv['addShape'](parent, { name: 'Dummy', x: 0, y: 0 });
  riv.addRectangle(dummy, { width: 1, height: 1 });
  const fill = riv.addFill(dummy);
  riv.addSolidColor(fill, hex('#00000000'));
}

function pairFrame(frame: number, value: number): [number, number] {
  return [frame, value];
}

function keyDoubles(
  riv: RiveFile,
  animation: number,
  target: number,
  property: number,
  frames: Array<[number, number]>,
): void {
  const keyed = riv.addKeyedObject(animation, target);
  const prop = riv.addKeyedProperty(keyed, property);
  for (const [frame, value] of frames) {
    riv.addKeyFrameDouble(prop, { frame, value, interpolation: 'cubic' });
  }
}

function blinkWindows(duration: number): Array<[number, number]> {
  if (duration <= 2) return [[0, 0]];
  const close1 = Math.round(duration * 0.74);
  const open1 = Math.round(duration * 0.8);
  const close2 = Math.round(duration * 0.86);
  const open2 = Math.round(duration * 0.9);
  return [
    [0, 0],
    [close1 - 2, 0],
    [close1 + 2, 1],
    [open1, 0],
    [close2 - 1, 0],
    [close2 + 2, 1],
    [open2, 0],
    [duration, 0],
  ];
}

function glanceWindows(duration: number): Array<[number, number]> {
  if (duration <= 2) return [[0, 0]];
  return [
    [0, 0],
    [Math.round(duration * 0.28), 0],
    [Math.round(duration * 0.4), 2.1],
    [Math.round(duration * 0.52), 0],
    [Math.round(duration * 0.64), -1.6],
    [Math.round(duration * 0.76), 0],
    [duration, 0],
  ];
}

function buildArtboard(riv: RiveFile, kind: StewardBotKind, play: StewardRivePlay): void {
  const artboard = addArtboard(riv, stewardRiveArtboard(kind, play));
  const figure = riv.addNode(artboard, { name: 'Figure', x: FIGURE_X, y: FIGURE_Y });
  addDummy(riv, figure);

  const fur = stewardFurTone(kind);
  const face = stewardFaceLayout(kind);
  const body = stewardSilhouette(kind);
  const motion = PLAY_MOTION[play];
  const lidCover = Math.min(0.86, Math.max(0.36, face.lidCover * motion.lidMul));

  addFilledEllipse(
    riv,
    figure,
    'Shadow',
    0,
    2.4,
    kind === 'quantanamo' ? 40 : kind === 'oddsborne' ? 26 : 32,
    4.2,
    rgba(20, 18, 28, 46),
  );
  addFilledPath(riv, figure, 'Body', parseSilhouette(body.path), hex(fur.base));
  addFilledEllipse(
    riv,
    figure,
    'Belly',
    0,
    -18,
    kind === 'quantanamo' ? 26 : 20,
    kind === 'quantanamo' ? 14 : 16,
    hex(fur.lit),
  );
  addFilledEllipse(riv, figure, 'Shine', -8, -42, kind === 'quantanamo' ? 18 : 14, 8, rgba(255, 255, 255, 72));

  const lids: Array<{ id: number; y: number; travel: number }> = [];
  const pupils: Array<{ id: number; x: number }> = [];
  for (const side of ['L', 'R'] as const) {
    const cx = side === 'L' ? face.left : face.right;
    const origin = toFigure({ x: cx, y: face.cy });
    const tilt = ((side === 'L' ? face.lidTiltL : face.lidTiltR) * Math.PI) / 180;
    const r = face.r;
    addFilledEllipse(riv, figure, `Sclera${side}`, origin.x, origin.y, r * 2, r * 1.88, hex('#fffdf8'));
    pupils.push({
      id: addFilledEllipse(
        riv,
        figure,
        `Pupil${side}`,
        origin.x,
        origin.y + r * 0.16,
        r * 0.56,
        r * 0.56,
        hex('#16141c'),
      ),
      x: origin.x,
    });
    const lidH = r * 2 * lidCover;
    const lidY = origin.y - r + lidH / 2;
    lids.push({
      id: addFilledEllipse(riv, figure, `Lid${side}`, origin.x, lidY, r * 2.15, lidH, hex(fur.base), tilt),
      y: lidY,
      travel: r * (1.05 - lidCover),
    });
  }

  const anim = riv.addLinearAnimation(artboard, {
    name: play,
    fps: 60,
    duration: motion.duration,
    loop: motion.loop,
  });

  const mid = Math.max(1, Math.round(motion.duration / 2));
  keyDoubles(riv, anim, figure, PropertyKey.y, [
    [0, FIGURE_Y],
    [mid, FIGURE_Y + motion.bounceY],
    [motion.duration, FIGURE_Y],
  ]);
  keyDoubles(riv, anim, figure, PropertyKey.scaleX, [
    [0, 1],
    [mid, motion.scaleX],
    [motion.duration, 1],
  ]);
  keyDoubles(riv, anim, figure, PropertyKey.scaleY, [
    [0, 1],
    [mid, motion.scaleY],
    [motion.duration, 1],
  ]);

  const blink = blinkWindows(motion.duration);
  const glance = glanceWindows(motion.duration);
  for (const lid of lids) {
    keyDoubles(
      riv,
      anim,
      lid.id,
      PropertyKey.y,
      blink.map(([frame, amount]) => pairFrame(frame, lid.y + amount * lid.travel)),
    );
  }
  for (const pupil of pupils) {
    keyDoubles(
      riv,
      anim,
      pupil.id,
      PropertyKey.x,
      glance.map(([frame, dx]) => pairFrame(frame, pupil.x + dx)),
    );
  }
}

export function generateStewardRivBytes(): Uint8Array {
  const riv = new RiveFile();
  for (const kind of STEWARD_RIVE_KINDS) {
    for (const play of STEWARD_RIVE_PLAYS) {
      buildArtboard(riv, kind, play);
    }
  }
  return riv.export();
}

function syncWasm(): void {
  mkdirSync(dirname(wasmDest), { recursive: true });
  copyFileSync(wasmSrc, wasmDest);
}

if (import.meta.main) {
  mkdirSync(dirname(outRiv), { recursive: true });
  const bytes = generateStewardRivBytes();
  writeFileSync(outRiv, bytes);
  syncWasm();
  console.log(`wrote ${outRiv} (${bytes.byteLength} bytes)`);
  console.log(`copied wasm → ${wasmDest}`);
}
