/**
 * Compose and paint a living icon: one soft ellipse + two rounded eyes.
 * Pose is a lerpable parameter set. Eyes can become tick/dash marks
 * (thinking) while staying the same two primitives.
 */
import type { StewardSpecies } from './desk-avatar';
import type { StewardMotion } from './steward-motion';

export type StewardEyePose = {
  w: number;
  h: number;
  rot: number;
};

export type StewardPose = {
  bodyRx: number;
  bodyRy: number;
  leanX: number;
  leanY: number;
  lookX: number;
  lookY: number;
  left: StewardEyePose;
  right: StewardEyePose;
};

export type StewardBodyMark = {
  part: 'body';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  fill: string;
  glow: number;
};

export type StewardEyeMark = {
  part: 'eye';
  side: 'left' | 'right';
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
  fill: string;
};

export type StewardDrawMark = StewardBodyMark | StewardEyeMark;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPose(from: StewardPose, to: StewardPose, t: number): StewardPose {
  const u = Math.min(1, Math.max(0, t));
  return {
    bodyRx: lerp(from.bodyRx, to.bodyRx, u),
    bodyRy: lerp(from.bodyRy, to.bodyRy, u),
    leanX: lerp(from.leanX, to.leanX, u),
    leanY: lerp(from.leanY, to.leanY, u),
    lookX: lerp(from.lookX, to.lookX, u),
    lookY: lerp(from.lookY, to.lookY, u),
    left: {
      w: lerp(from.left.w, to.left.w, u),
      h: lerp(from.left.h, to.left.h, u),
      rot: lerp(from.left.rot, to.left.rot, u),
    },
    right: {
      w: lerp(from.right.w, to.right.w, u),
      h: lerp(from.right.h, to.right.h, u),
      rot: lerp(from.right.rot, to.right.rot, u),
    },
  };
}

export function composeStewardPose(species: StewardSpecies, motion: StewardMotion): StewardPose {
  const up = motion.up;
  const down = motion.down;
  const listen = motion.listen;
  const blink = motion.blink;
  const think = motion.think;
  const breathe = motion.breathe;
  const pulse = motion.pulse;

  const swell = 0.42 * pulse;
  const bodyRx = swell + (0.5 - breathe) * 0.006;
  const bodyRy = swell + (breathe - 0.5) * 0.006;

  const lookX = motion.glanceX * (1 - think * 0.35) + up * 0.16 - listen * 0.03 + down * -0.06;
  const lookY = motion.glanceY - up * 0.22 + down * 0.18 - listen * 0.07 + think * 0.05;
  const leanX = lookX * 0.045;
  const leanY = lookY * 0.03 + down * 0.018;

  let leftW = species.restW;
  let leftH = species.restH;
  let rightW = species.restW;
  let rightH = species.restH;
  let leftRot = species.restTilt + species.leftBias;
  let rightRot = species.restTilt + species.rightBias;

  leftW = lerp(leftW, species.restW * 0.88, listen);
  leftH = lerp(leftH, species.restH * 1.22, listen);
  rightW = lerp(rightW, species.restW * 0.88, listen);
  rightH = lerp(rightH, species.restH * 1.22, listen);

  leftH = lerp(leftH, leftH * 1.1, up);
  rightH = lerp(rightH, rightH * 1.1, up);
  const follow = lookX * 0.42 + lookY * 0.22;
  leftRot += follow;
  rightRot += follow;

  leftH = lerp(leftH, species.restH * 0.58, down);
  rightH = lerp(rightH, species.restH * 0.58, down);
  leftW = lerp(leftW, species.restW * 1.14, down);
  rightW = lerp(rightW, species.restW * 1.14, down);

  leftW = lerp(leftW, 0.052, think);
  leftH = lerp(leftH, 0.26, think);
  rightW = lerp(rightW, 0.22, think);
  rightH = lerp(rightH, 0.068, think);
  leftRot = lerp(leftRot, 0.06, think);
  rightRot = lerp(rightRot, 0.02, think);

  leftH = lerp(leftH, 0.026, blink);
  rightH = lerp(rightH, 0.026, blink);
  leftW = lerp(leftW, Math.max(leftW, 0.16), blink);
  rightW = lerp(rightW, Math.max(rightW, 0.16), blink);

  return {
    bodyRx,
    bodyRy,
    leanX,
    leanY,
    lookX,
    lookY,
    left: { w: leftW, h: leftH, rot: leftRot },
    right: { w: rightW, h: rightH, rot: rightRot },
  };
}

export function stewardDrawMarks(species: StewardSpecies, pose: StewardPose, size: number): StewardDrawMark[] {
  const cx = size * 0.5 + pose.leanX * size;
  const cy = size * 0.5 + pose.leanY * size;
  const rx = pose.bodyRx * size;
  const ry = pose.bodyRy * size;
  const gap = species.gap * size;
  const face = Math.min(rx, ry) * 0.52;
  const faceX = cx + pose.lookX * face;
  const faceY = cy + species.eyeY * size + pose.lookY * face;
  const glow = Math.max(0, (Math.max(pose.bodyRx, pose.bodyRy) / 0.42 - 1) * size * 1.8);

  return [
    { part: 'body', cx, cy, rx, ry, fill: species.fill, glow },
    {
      part: 'eye',
      side: 'left',
      cx: faceX - gap / 2,
      cy: faceY,
      w: pose.left.w * size,
      h: pose.left.h * size,
      rot: pose.left.rot,
      fill: species.eye,
    },
    {
      part: 'eye',
      side: 'right',
      cx: faceX + gap / 2,
      cy: faceY,
      w: pose.right.w * size,
      h: pose.right.h * size,
      rot: pose.right.rot,
      fill: species.eye,
    },
  ];
}

function fillCapsule(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rot: number,
  fill: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2);
  ctx.fill();
  ctx.restore();
}

export function paintStewardIcon(ctx: CanvasRenderingContext2D, marks: StewardDrawMark[]): void {
  for (const mark of marks) {
    if (mark.part === 'body') {
      ctx.save();
      if (mark.glow > 0) {
        ctx.shadowColor = mark.fill;
        ctx.shadowBlur = mark.glow;
      }
      ctx.fillStyle = mark.fill;
      ctx.beginPath();
      ctx.ellipse(mark.cx, mark.cy, mark.rx, mark.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      continue;
    }
    fillCapsule(ctx, mark.cx, mark.cy, mark.w, mark.h, mark.rot, mark.fill);
  }
}
