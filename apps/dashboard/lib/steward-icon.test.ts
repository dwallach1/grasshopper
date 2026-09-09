import { describe, expect, test } from 'bun:test';

import { stewardSpecies } from './desk-avatar';
import { composeStewardPose, lerpPose, sphereWrap, stewardDrawMarks, type StewardPose } from './steward-icon';
import type { StewardMotion } from './steward-motion';

function motion(partial: Partial<StewardMotion> = {}): StewardMotion {
  return {
    blink: 0,
    think: 0,
    listen: 0,
    up: 0,
    down: 0,
    glanceX: 0,
    glanceY: 0,
    breathe: 0.5,
    pulse: 1,
    surprise: 0,
    bang: 0,
    toggle: 0,
    speak: 0,
    ...partial,
  };
}

function marksFor(partial: Partial<StewardMotion> = {}) {
  const species = stewardSpecies('quantanamo');
  return stewardDrawMarks(species, composeStewardPose(species, motion(partial)), 64);
}

function eyesOf(marks: ReturnType<typeof marksFor>) {
  const left = marks.find((mark) => mark.part === 'eye' && mark.side === 'left');
  const right = marks.find((mark) => mark.part === 'eye' && mark.side === 'right');
  if (left?.part !== 'eye' || right?.part !== 'eye') throw new Error('expected two eyes');
  return { left, right };
}

describe('living steward icon', () => {
  test('every pose is one circle body and two pill eyes', () => {
    for (const partial of [{}, { blink: 1 }, { toggle: 1 }, { bang: 1 }, { up: 1 }, { down: 1 }]) {
      const marks = marksFor(partial);
      expect(marks.map((mark) => mark.part)).toEqual(['body', 'eye', 'eye']);
      const body = marks[0];
      if (body?.part !== 'body') throw new Error('expected body');
      expect(body.r).toBeGreaterThan(20);
    }
  });

  test('blink flattens both pills to slits; surprise expands them', () => {
    const idle = eyesOf(marksFor());
    const blink = eyesOf(marksFor({ blink: 1 }));
    const surprise = eyesOf(marksFor({ surprise: 1 }));
    expect(blink.left.h).toBeLessThan(idle.left.h * 0.35);
    expect(blink.right.h).toBeLessThan(4);
    expect(blink.left.w).toBeGreaterThan(idle.left.w);
    expect(surprise.left.h).toBeGreaterThan(idle.left.h);
    expect(surprise.right.w).toBeGreaterThan(idle.right.w);
  });

  test('bang is a stem plus a dot; toggle is a track plus a knob', () => {
    const bang = eyesOf(marksFor({ bang: 1 }));
    const toggle = eyesOf(marksFor({ toggle: 1 }));
    expect(bang.left.h).toBeGreaterThan(bang.left.w * 2.4);
    expect(Math.abs(bang.right.w - bang.right.h)).toBeLessThan(2);
    expect(toggle.left.w).toBeGreaterThan(toggle.left.h * 2);
    expect(Math.abs(toggle.right.w - toggle.right.h)).toBeLessThan(2);
  });

  test('up looks higher than down; rim gaze foreshortens more than center', () => {
    const species = stewardSpecies('bandit');
    const up = composeStewardPose(species, motion({ up: 1, surprise: 1, glanceX: 0.5, glanceY: -0.4 }));
    const down = composeStewardPose(species, motion({ down: 1 }));
    const idle = composeStewardPose(species, motion());
    expect(up.lookY).toBeLessThan(idle.lookY);
    expect(down.lookY).toBeGreaterThan(idle.lookY);
    const rim = stewardDrawMarks(species, up, 100);
    const center = stewardDrawMarks(species, idle, 100);
    const rimEye = rim.find((mark) => mark.part === 'eye' && mark.side === 'right');
    const centerEye = center.find((mark) => mark.part === 'eye' && mark.side === 'right');
    if (rimEye?.part !== 'eye' || centerEye?.part !== 'eye') throw new Error('eyes');
    expect(rimEye.wrap).toBeLessThan(centerEye.wrap);
  });

  test('sphere wrap compresses toward the rim and keeps a radial', () => {
    const center = sphereWrap(0, 0, 40);
    const rim = sphereWrap(32, 8, 40);
    expect(center.wrap).toBe(1);
    expect(rim.wrap).toBeLessThan(0.75);
    expect(rim.radial).not.toBe(0);
  });

  test('lerpPose is a continuous blend between any two poses', () => {
    const species = stewardSpecies('oddsborne');
    const from = composeStewardPose(species, motion({ surprise: 1, up: 1 }));
    const to = composeStewardPose(species, motion({ toggle: 1 }));
    const mid = lerpPose(from, to, 0.5);
    expect(mid.lookY).toBeCloseTo((from.lookY + to.lookY) / 2, 5);
    expect(mid.left.w).toBeCloseTo((from.left.w + to.left.w) / 2, 5);
    expect(mid.right.oy).toBeCloseTo((from.right.oy + to.right.oy) / 2, 5);
    const still: StewardPose = lerpPose(from, from, 0.8);
    expect(still.lookX).toBe(from.lookX);
  });

  test('listen, think, caution, and speak stay two pills on one disk', () => {
    const idle = composeStewardPose(stewardSpecies('quantanamo'), motion());
    const listen = composeStewardPose(stewardSpecies('quantanamo'), motion({ listen: 1 }));
    const think = composeStewardPose(stewardSpecies('oddsborne'), motion({ think: 1 }));
    const caution = composeStewardPose(stewardSpecies('bandit'), motion({ down: 1 }));
    const speak = composeStewardPose(stewardSpecies('cointanamo'), motion({ speak: 1 }));
    expect(listen.left.h).toBeGreaterThan(idle.left.h);
    expect(think.lookY).toBeLessThan(idle.lookY);
    expect(caution.left.h).toBeLessThan(idle.left.h);
    expect(caution.left.rot).toBeGreaterThan(idle.left.rot);
    expect(speak.bodyR).toBeLessThan(0.49);
    expect(speak.left.h).toBeGreaterThan(0);
  });

  test('species keep distinct eye gaps on the same circle body', () => {
    const q = stewardDrawMarks(
      stewardSpecies('quantanamo'),
      composeStewardPose(stewardSpecies('quantanamo'), motion()),
      100,
    );
    const o = stewardDrawMarks(
      stewardSpecies('oddsborne'),
      composeStewardPose(stewardSpecies('oddsborne'), motion()),
      100,
    );
    const qEyes = eyesOf(q);
    const oEyes = eyesOf(o);
    expect(qEyes.right.cx - qEyes.left.cx).toBeGreaterThan(oEyes.right.cx - oEyes.left.cx + 4);
    expect(q[0]?.part === 'body' && q[0].fill).toBe(stewardSpecies('quantanamo').fill);
    expect(o[0]?.part === 'body' && o[0].fill).toBe(stewardSpecies('oddsborne').fill);
    const c = stewardDrawMarks(
      stewardSpecies('cointanamo'),
      composeStewardPose(stewardSpecies('cointanamo'), motion()),
      100,
    );
    const cEyes = eyesOf(c);
    expect(cEyes.right.cx - cEyes.left.cx).not.toBe(qEyes.right.cx - qEyes.left.cx);
    expect(c[0]?.part === 'body' && c[0].fill).toBe(stewardSpecies('cointanamo').fill);
  });
});
