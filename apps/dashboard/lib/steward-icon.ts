/**
 * Flat 2D living icon: one filled circle + two negative-space pills.
 * Eyes carry blink, surprise, sphere-wrap, and pinch-then-stretch glyphs.
 */
import type { StewardSpecies } from './desk-avatar';
import { pinchThenForm, type StewardMotion } from './steward-motion';

export type StewardEyePose = {
  w: number;
  h: number;
  rot: number;
  ox: number;
  oy: number;
};

export type StewardPose = {
  bodyR: number;
  lookX: number;
  lookY: number;
  breathe: number;
  left: StewardEyePose;
  right: StewardEyePose;
};

export type StewardBodyMark = {
  part: 'body';
  cx: number;
  cy: number;
  r: number;
  fill: string;
};

export type StewardEyeMark = {
  part: 'eye';
  side: 'left' | 'right';
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
  radial: number;
  wrap: number;
  fill: string;
};

export type StewardDrawMark = StewardBodyMark | StewardEyeMark;

export type SphereWrap = {
  wrap: number;
  radial: number;
};

export type DiskPoint = {
  x: number;
  y: number;
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPose(from: StewardPose, to: StewardPose, t: number): StewardPose {
  const u = Math.min(1, Math.max(0, t));
  return {
    bodyR: lerp(from.bodyR, to.bodyR, u),
    lookX: lerp(from.lookX, to.lookX, u),
    lookY: lerp(from.lookY, to.lookY, u),
    breathe: lerp(from.breathe, to.breathe, u),
    left: {
      w: lerp(from.left.w, to.left.w, u),
      h: lerp(from.left.h, to.left.h, u),
      rot: lerp(from.left.rot, to.left.rot, u),
      ox: lerp(from.left.ox, to.left.ox, u),
      oy: lerp(from.left.oy, to.left.oy, u),
    },
    right: {
      w: lerp(from.right.w, to.right.w, u),
      h: lerp(from.right.h, to.right.h, u),
      rot: lerp(from.right.rot, to.right.rot, u),
      ox: lerp(from.right.ox, to.right.ox, u),
      oy: lerp(from.right.oy, to.right.oy, u),
    },
  };
}

/** Foreshorten a point on the disk so rim eyes fake a spherical surface. */
export function sphereWrap(dx: number, dy: number, radius: number): SphereWrap {
  const r = Math.hypot(dx, dy);
  const u = radius <= 0 ? 0 : Math.min(0.88, r / radius);
  return {
    wrap: Math.sqrt(Math.max(0, 1 - u * u)),
    radial: Math.atan2(dy, dx),
  };
}

export function composeStewardPose(species: StewardSpecies, motion: StewardMotion): StewardPose {
  const bang = pinchThenForm(motion.bang);
  const toggle = pinchThenForm(motion.toggle);
  const pinch = Math.max(bang.pinch, toggle.pinch);
  const blink = motion.blink;
  const surprise = motion.surprise;
  const breathe = motion.breathe;

  const lookX = motion.glanceX + motion.up * 0.22 - motion.listen * 0.02 + motion.down * -0.08;
  const lookY = motion.glanceY - motion.up * 0.28 + motion.down * 0.22 - motion.listen * 0.06;

  let leftW = species.restW;
  let leftH = species.restH;
  let rightW = species.restW;
  let rightH = species.restH;
  let leftRot = species.restTilt + species.leftBias;
  let rightRot = species.restTilt + species.rightBias;
  let leftOx = 0;
  let leftOy = 0;
  let rightOx = 0;
  let rightOy = 0;

  const listen = motion.listen;
  leftW = lerp(leftW, species.restW * 0.86, listen);
  leftH = lerp(leftH, species.restH * 1.18, listen);
  rightW = lerp(rightW, species.restW * 0.86, listen);
  rightH = lerp(rightH, species.restH * 1.18, listen);

  const grow = 1 + surprise * 0.42;
  leftW *= grow;
  leftH *= grow;
  rightW *= grow;
  rightH *= grow;

  leftH = lerp(leftH, species.restH * 0.42, motion.down);
  rightH = lerp(rightH, species.restH * 0.42, motion.down);
  leftW = lerp(leftW, species.restW * 1.28, motion.down);
  rightW = lerp(rightW, species.restW * 1.28, motion.down);

  const follow = lookX * 0.55 + lookY * 0.28;
  leftRot += follow;
  rightRot += follow;

  const dot = 0.038;
  leftW = lerp(leftW, dot, pinch);
  leftH = lerp(leftH, dot, pinch);
  rightW = lerp(rightW, dot, pinch);
  rightH = lerp(rightH, dot, pinch);

  leftW = lerp(leftW, 0.048, bang.form);
  leftH = lerp(leftH, 0.3, bang.form);
  rightW = lerp(rightW, 0.07, bang.form);
  rightH = lerp(rightH, 0.07, bang.form);
  leftRot = lerp(leftRot, 0, bang.form);
  rightRot = lerp(rightRot, 0, bang.form);
  leftOx = lerp(leftOx, -0.02, bang.form);
  leftOy = lerp(leftOy, -0.04, bang.form);
  rightOx = lerp(rightOx, 0.02, bang.form);
  rightOy = lerp(rightOy, 0.12, bang.form);

  leftW = lerp(leftW, 0.28, toggle.form);
  leftH = lerp(leftH, 0.072, toggle.form);
  rightW = lerp(rightW, 0.1, toggle.form);
  rightH = lerp(rightH, 0.1, toggle.form);
  leftRot = lerp(leftRot, 0, toggle.form);
  rightRot = lerp(rightRot, 0, toggle.form);
  leftOx = lerp(leftOx, -0.02, toggle.form);
  leftOy = lerp(leftOy, 0, toggle.form);
  rightOx = lerp(rightOx, 0.1, toggle.form);
  rightOy = lerp(rightOy, 0, toggle.form);

  const slit = 0.022;
  leftH = lerp(leftH, slit, blink);
  rightH = lerp(rightH, slit, blink);
  leftW = lerp(leftW, Math.max(leftW, species.restW * 1.45), blink);
  rightW = lerp(rightW, Math.max(rightW, species.restW * 1.45), blink);

  const bodyR = 0.42 * motion.pulse * (1 + (breathe - 0.5) * 0.03);

  return {
    bodyR,
    lookX,
    lookY,
    breathe,
    left: { w: leftW, h: leftH, rot: leftRot, ox: leftOx, oy: leftOy },
    right: { w: rightW, h: rightH, rot: rightRot, ox: rightOx, oy: rightOy },
  };
}

function clampOnDisk(dx: number, dy: number, limit: number): DiskPoint {
  const r = Math.hypot(dx, dy);
  if (r <= limit || r === 0) return { x: dx, y: dy };
  const s = limit / r;
  return { x: dx * s, y: dy * s };
}

export function stewardDrawMarks(species: StewardSpecies, pose: StewardPose, size: number): StewardDrawMark[] {
  const cx = size * 0.5;
  const cy = size * 0.5;
  const r = pose.bodyR * size;
  const face = r * 0.58;
  const gap = species.gap * size * 0.5;
  const lookX = pose.lookX * face;
  const lookY = pose.lookY * face;
  const baseY = species.eyeY * size;

  const leftLocal = clampOnDisk(lookX - gap + pose.left.ox * size, baseY + lookY + pose.left.oy * size, r * 0.72);
  const rightLocal = clampOnDisk(lookX + gap + pose.right.ox * size, baseY + lookY + pose.right.oy * size, r * 0.72);
  const leftWrap = sphereWrap(leftLocal.x, leftLocal.y, r);
  const rightWrap = sphereWrap(rightLocal.x, rightLocal.y, r);

  return [
    { part: 'body', cx, cy, r, fill: species.fill },
    {
      part: 'eye',
      side: 'left',
      cx: cx + leftLocal.x,
      cy: cy + leftLocal.y,
      w: pose.left.w * size,
      h: pose.left.h * size,
      rot: pose.left.rot,
      radial: leftWrap.radial,
      wrap: leftWrap.wrap,
      fill: species.eye,
    },
    {
      part: 'eye',
      side: 'right',
      cx: cx + rightLocal.x,
      cy: cy + rightLocal.y,
      w: pose.right.w * size,
      h: pose.right.h * size,
      rot: pose.right.rot,
      radial: rightWrap.radial,
      wrap: rightWrap.wrap,
      fill: species.eye,
    },
  ];
}

function fillPill(ctx: CanvasRenderingContext2D, mark: StewardEyeMark): void {
  ctx.save();
  ctx.translate(mark.cx, mark.cy);
  ctx.rotate(mark.radial);
  ctx.scale(Math.max(0.22, mark.wrap), 1);
  ctx.rotate(mark.rot - mark.radial);
  ctx.fillStyle = mark.fill;
  ctx.beginPath();
  ctx.roundRect(-mark.w / 2, -mark.h / 2, mark.w, mark.h, Math.min(mark.w, mark.h) / 2);
  ctx.fill();
  ctx.restore();
}

export function paintStewardIcon(ctx: CanvasRenderingContext2D, marks: StewardDrawMark[]): void {
  const body = marks[0];
  if (body?.part !== 'body') return;
  ctx.save();
  ctx.fillStyle = body.fill;
  ctx.beginPath();
  ctx.arc(body.cx, body.cy, body.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(body.cx, body.cy, body.r, 0, Math.PI * 2);
  ctx.clip();
  for (const mark of marks) {
    if (mark.part === 'eye') fillPill(ctx, mark);
  }
  ctx.restore();
}
