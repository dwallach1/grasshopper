import { describe, expect, test } from 'bun:test';

import { stewardSpecies } from './desk-avatar';
import { composeStewardPose, lerpPose, stewardDrawMarks, type StewardPose } from './steward-icon';
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
    ...partial,
  };
}

function marksFor(partial: Partial<StewardMotion> = {}) {
  const species = stewardSpecies('quantanamo');
  return stewardDrawMarks(species, composeStewardPose(species, motion(partial)), 64);
}

describe('living steward icon', () => {
  test('every pose is one body ellipse and two eye marks', () => {
    for (const partial of [{}, { blink: 1 }, { think: 1 }, { up: 1 }, { down: 1 }, { listen: 1 }]) {
      const marks = marksFor(partial);
      expect(marks.map((mark) => mark.part)).toEqual(['body', 'eye', 'eye']);
      const body = marks[0];
      if (body?.part !== 'body') throw new Error('expected body');
      expect(body.rx).toBeGreaterThan(20);
      expect(body.ry).toBeGreaterThan(20);
      expect(Math.abs(body.rx - body.ry)).toBeLessThan(8);
    }
  });

  test('blink squashes both eyes; think makes them asymmetric tick + dash', () => {
    const idle = marksFor();
    const blink = marksFor({ blink: 1 });
    const think = marksFor({ think: 1 });
    const idleEyes = idle.filter((mark) => mark.part === 'eye');
    const blinkEyes = blink.filter((mark) => mark.part === 'eye');
    const thinkEyes = think.filter((mark) => mark.part === 'eye');
    expect(blinkEyes[0] && blinkEyes[0].part === 'eye' && blinkEyes[0].h).toBeLessThan(
      idleEyes[0] && idleEyes[0].part === 'eye' ? idleEyes[0].h : 99,
    );
    expect(blinkEyes[1] && blinkEyes[1].part === 'eye' && blinkEyes[1].h).toBeLessThan(4);
    const left = thinkEyes[0];
    const right = thinkEyes[1];
    if (left?.part !== 'eye' || right?.part !== 'eye') throw new Error('expected eyes');
    expect(left.h).toBeGreaterThan(left.w * 2);
    expect(right.w).toBeGreaterThan(right.h * 2);
  });

  test('up looks higher than down; listen sits nearer center', () => {
    const species = stewardSpecies('bandit');
    const up = composeStewardPose(species, motion({ up: 1 }));
    const down = composeStewardPose(species, motion({ down: 1 }));
    const listen = composeStewardPose(species, motion({ listen: 1 }));
    const idle = composeStewardPose(species, motion());
    expect(up.lookY).toBeLessThan(idle.lookY);
    expect(down.lookY).toBeGreaterThan(idle.lookY);
    expect(Math.abs(listen.lookX)).toBeLessThan(0.1);
    expect(Math.abs(up.bodyRx - up.bodyRy)).toBeLessThan(0.02);
    expect(Math.abs(down.bodyRx - down.bodyRy)).toBeLessThan(0.02);
  });

  test('lerpPose is a continuous blend between any two poses', () => {
    const species = stewardSpecies('oddsborne');
    const from = composeStewardPose(species, motion({ up: 1 }));
    const to = composeStewardPose(species, motion({ think: 1 }));
    const mid = lerpPose(from, to, 0.5);
    expect(mid.lookY).toBeCloseTo((from.lookY + to.lookY) / 2, 5);
    expect(mid.left.w).toBeCloseTo((from.left.w + to.left.w) / 2, 5);
    expect(mid.right.h).toBeCloseTo((from.right.h + to.right.h) / 2, 5);
    const still: StewardPose = lerpPose(from, from, 0.8);
    expect(still.lookX).toBe(from.lookX);
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
    const qEyes = q.filter((mark) => mark.part === 'eye');
    const oEyes = o.filter((mark) => mark.part === 'eye');
    if (qEyes[0]?.part !== 'eye' || qEyes[1]?.part !== 'eye') throw new Error('q eyes');
    if (oEyes[0]?.part !== 'eye' || oEyes[1]?.part !== 'eye') throw new Error('o eyes');
    const qGap = qEyes[1].cx - qEyes[0].cx;
    const oGap = oEyes[1].cx - oEyes[0].cx;
    expect(qGap).toBeGreaterThan(oGap + 4);
    expect(q[0]?.part === 'body' && q[0].fill).toBe(stewardSpecies('quantanamo').fill);
    expect(o[0]?.part === 'body' && o[0].fill).toBe(stewardSpecies('oddsborne').fill);
  });
});
