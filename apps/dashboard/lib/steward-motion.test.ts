import { describe, expect, test } from 'bun:test';

import {
  approachParam,
  stewardBlinkAmount,
  stewardBlinkCover,
  stewardBreathe,
  stewardGlanceX,
  stewardMotion,
  stewardPulse,
  stewardThinkAmount,
} from './steward-motion';

describe('steward motion curves', () => {
  test('blink stays at rest cover except during the close windows', () => {
    expect(stewardBlinkCover(0, 0, 0.5)).toBe(0.5);
    expect(stewardBlinkCover(3400 * 0.4, 0, 0.5)).toBe(0.5);
    expect(stewardBlinkCover(3400 * 0.765, 0, 0.5)).toBeGreaterThan(0.85);
    expect(stewardBlinkCover(3400 * 0.87, 0, 0.5)).toBeGreaterThan(0.85);
    expect(stewardBlinkAmount(0, 0)).toBe(0);
    expect(stewardBlinkAmount(3400 * 0.765, 0)).toBeGreaterThan(0.7);
  });

  test('breathe is bounded and faster when alive', () => {
    const idle = stewardBreathe(0, 0, false);
    const live = stewardBreathe(550, 0, true);
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(idle).toBeLessThanOrEqual(1);
    expect(live).not.toBe(stewardBreathe(550, 0, false));
  });

  test('glance parks at center and pulse only grows when alive', () => {
    expect(stewardGlanceX(0, 0)).toBe(0);
    expect(stewardGlanceX(7600 * 0.35, 0)).not.toBe(0);
    expect(stewardPulse(200, 0, false)).toBe(1);
    expect(stewardPulse(450, 0, true)).toBeGreaterThan(1);
  });

  test('think amount is a continuous lobe, not a binary clip', () => {
    expect(stewardThinkAmount(0, 0)).toBe(0);
    const mid = stewardThinkAmount(11000 * 0.7, 0);
    const later = stewardThinkAmount(11000 * 0.76, 0);
    expect(mid).toBeGreaterThan(0.4);
    expect(later).toBeGreaterThan(0);
    expect(Math.abs(mid - later)).toBeLessThan(0.6);
  });

  test('reduced motion freezes glance/blink and holds the desk pose', () => {
    const stillUp = stewardMotion({
      elapsedMs: 4000,
      delayMs: 0,
      mood: 'up',
      alive: true,
      reducedMotion: true,
      thinking: false,
    });
    expect(stillUp.blink).toBe(0);
    expect(stillUp.glanceX).toBe(0);
    expect(stillUp.up).toBe(1);
    expect(stillUp.breathe).toBe(0.5);
    expect(stillUp.pulse).toBe(1);

    const stillThink = stewardMotion({
      elapsedMs: 4000,
      delayMs: 0,
      mood: 'idle',
      alive: false,
      reducedMotion: true,
      thinking: true,
    });
    expect(stillThink.think).toBe(0.7);
    expect(stillThink.listen).toBe(0);
  });

  test('live idle listens; up/down win over listen', () => {
    const listen = stewardMotion({
      elapsedMs: 0,
      delayMs: 0,
      mood: 'idle',
      alive: true,
      reducedMotion: false,
      thinking: false,
    });
    expect(listen.listen).toBe(1);
    expect(listen.up).toBe(0);
    const up = stewardMotion({
      elapsedMs: 0,
      delayMs: 0,
      mood: 'up',
      alive: true,
      reducedMotion: false,
      thinking: false,
    });
    expect(up.up).toBe(1);
    expect(up.listen).toBe(0);
  });

  test('approach eases toward the target instead of snapping', () => {
    const stepped = approachParam(0, 1, 0.05, 0.16);
    expect(stepped).toBeGreaterThan(0);
    expect(stepped).toBeLessThan(0.5);
    expect(approachParam(0.4, 0.4, 0.1)).toBe(0.4);
  });
});
