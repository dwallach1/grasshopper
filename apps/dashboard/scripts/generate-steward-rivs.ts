/**
 * Generate loadable steward .riv binaries with @stevysmith/rive-generator@0.1.1.
 * Constraints from that tool: one Node under each artboard, no CubicVertex,
 * no cornerRadius, dummy shape first, gradient shapes last (we use solids).
 *
 * Animation names do not survive @rive-app/canvas, so each steward×play is
 * its own artboard with one default linear clip. KeyedObject.objectId must
 * be artboard-relative (`targetId - artboardId`); file-absolute IDs load
 * but never apply in the official runtime.
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
  riveKeyedObjectId,
  stewardRiveArtboard,
  type StewardRivePlay,
} from '../lib/steward-rive';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(here, '..');
const outDir = join(dashboardRoot, 'public/stewards');
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
  idle: { duration: 90, bounceY: -14, scaleX: 1.2, scaleY: 0.8, lidMul: 1, loop: 'loop' },
  up: { duration: 72, bounceY: -18, scaleX: 1.26, scaleY: 0.74, lidMul: 0.78, loop: 'loop' },
  down: { duration: 120, bounceY: -8, scaleX: 1.12, scaleY: 0.9, lidMul: 1.22, loop: 'loop' },
  alive: { duration: 66, bounceY: -16, scaleX: 1.22, scaleY: 0.78, lidMul: 0.9, loop: 'loop' },
} satisfies Record<StewardRivePlay, PlayMotion>;

function toFigure(pathPoint: Pt): Pt {
  // PR #28 SVG: viewBox 80, inner translate(8 7), path in 64-space.
  // Center that 80 tile inside the 96 artboard, then subtract the figure origin.
  return { x: pathPoint.x - 32, y: pathPoint.y - 63 };
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
  artboard: number,
  target: number,
  property: number,
  frames: Array<[number, number]>,
): void {
  const keyed = riv.addKeyedObject(animation, riveKeyedObjectId(artboard, target));
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
    [Math.round(duration * 0.4), 3.6],
    [Math.round(duration * 0.52), 0],
    [Math.round(duration * 0.64), -2.8],
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
  const mound = stewardSilhouette(kind);
  const motion = PLAY_MOTION[play];
  const lidCover = Math.min(0.72, Math.max(0.34, face.lidCover * motion.lidMul * 0.88));
  const bodyW = 36 * mound.girth;
  const bodyH = 34 * mound.peak + 6;

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
  addFilledEllipse(riv, figure, 'Body', 0, -bodyH * 0.42, bodyW, bodyH, hex(fur.base));
  if (kind === 'bandit') {
    addFilledEllipse(riv, figure, 'PuffL', -11, -bodyH * 0.78, 14, 12, hex(fur.base));
    addFilledEllipse(riv, figure, 'PuffC', 0, -bodyH * 0.86, 15, 13, hex(fur.base));
    addFilledEllipse(riv, figure, 'PuffR', 11, -bodyH * 0.76, 14, 12, hex(fur.base));
  }
  addFilledEllipse(riv, figure, 'Belly', 0, -bodyH * 0.22, bodyW * 0.46, bodyH * 0.34, hex(fur.lit));
  addFilledEllipse(riv, figure, 'Shine', -bodyW * 0.16, -bodyH * 0.72, bodyW * 0.28, 8, rgba(255, 255, 255, 80));

  const lids: Array<{ id: number; y: number; travel: number }> = [];
  const pupils: Array<{ id: number; x: number }> = [];
  const eyeR = face.r * 1.28;
  for (const side of ['L', 'R'] as const) {
    const cx = side === 'L' ? face.left : face.right;
    const origin = toFigure({ x: cx, y: face.cy });
    const tilt = ((side === 'L' ? face.lidTiltL : face.lidTiltR) * Math.PI) / 180;
    addFilledEllipse(riv, figure, `Sclera${side}`, origin.x, origin.y, eyeR * 2, eyeR * 1.86, hex('#fffdf8'));
    pupils.push({
      id: addFilledEllipse(
        riv,
        figure,
        `Pupil${side}`,
        origin.x,
        origin.y + eyeR * 0.18,
        eyeR * 0.7,
        eyeR * 0.7,
        hex('#16141c'),
      ),
      x: origin.x,
    });
    const lidH = eyeR * 2 * lidCover;
    const lidY = origin.y - eyeR + lidH / 2;
    lids.push({
      id: addFilledEllipse(riv, figure, `Lid${side}`, origin.x, lidY, eyeR * 2.2, lidH, hex(fur.base), tilt),
      y: lidY,
      travel: eyeR * (1.08 - lidCover),
    });
  }

  const anim = riv.addLinearAnimation(artboard, {
    name: play,
    fps: 60,
    duration: motion.duration,
    loop: motion.loop,
  });

  const mid = Math.max(1, Math.round(motion.duration / 2));
  keyDoubles(riv, anim, artboard, figure, PropertyKey.y, [
    [0, FIGURE_Y],
    [mid, FIGURE_Y + motion.bounceY],
    [motion.duration, FIGURE_Y],
  ]);
  keyDoubles(riv, anim, artboard, figure, PropertyKey.scaleX, [
    [0, 1],
    [mid, motion.scaleX],
    [motion.duration, 1],
  ]);
  keyDoubles(riv, anim, artboard, figure, PropertyKey.scaleY, [
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
      artboard,
      lid.id,
      PropertyKey.y,
      blink.map(([frame, amount]) => pairFrame(frame, lid.y + amount * lid.travel)),
    );
  }
  for (const pupil of pupils) {
    keyDoubles(
      riv,
      anim,
      artboard,
      pupil.id,
      PropertyKey.x,
      glance.map(([frame, dx]) => pairFrame(frame, pupil.x + dx)),
    );
  }
}

export function generateStewardRiv(kind: StewardBotKind, play: StewardRivePlay): Uint8Array {
  const riv = new RiveFile();
  buildArtboard(riv, kind, play);
  return riv.export();
}

function rivFileName(kind: StewardBotKind, play: StewardRivePlay): string {
  return `${kind}_${play}.riv`;
}

function syncWasm(): void {
  mkdirSync(dirname(wasmDest), { recursive: true });
  copyFileSync(wasmSrc, wasmDest);
}

if (import.meta.main) {
  mkdirSync(outDir, { recursive: true });
  let total = 0;
  for (const kind of STEWARD_RIVE_KINDS) {
    for (const play of STEWARD_RIVE_PLAYS) {
      const bytes = generateStewardRiv(kind, play);
      const path = join(outDir, rivFileName(kind, play));
      writeFileSync(path, bytes);
      total += bytes.byteLength;
      console.log(`wrote ${path} (${bytes.byteLength} bytes)`);
    }
  }
  syncWasm();
  console.log(`copied wasm → ${wasmDest} (${total} bytes of rivs)`);
}
