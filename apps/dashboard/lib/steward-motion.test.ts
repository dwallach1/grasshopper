import { describe, expect, test } from 'bun:test';

import {
  approachParam,
  pinchThenForm,
  stewardBangAmount,
  stewardBlinkAmount,
  stewardBlinkCover,
  stewardBreathe,
  stewardGlanceX,
  stewardMotion,
  stewardPulse,
  stewardThinkAmount,
  stewardToggleAmount,
} from './steward-motion';

describe('steward motion curves', () => {
  test('blink stays at rest cover except during the close windows', () => {
    expect(stewardBlinkCover(0, 0, 0.5)).toBe(0.5);
    expect(stewardBlinkCover(2800 * 0.4, 0, 0.5)).toBe(0.5);
    expect(stewardBlinkCover(2800 * 0.76, 0, 0.5)).toBeGreaterThan(0.85);
    expect(stewardBlinkCover(2800 * 0.88, 0, 0.5)).toBeGreaterThan(0.7);
    expect(stewardBlinkAmount(0, 0)).toBe(0);
    expect(stewardBlinkAmount(2800 * 0.76, 0)).toBeGreaterThan(0.7);
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
    expect(stewardGlanceX(5200 * 0.3, 0)).not.toBe(0);
    expect(stewardPulse(200, 0, false)).toBe(1);
    expect(stewardPulse(450, 0, true)).toBeGreaterThan(1);
    expect(stewardPulse(450, 0, true)).toBeLessThan(1.04);
  });

  test('think amount is a continuous lobe, not a binary clip', () => {
    expect(stewardThinkAmount(0, 0)).toBe(0);
    const mid = stewardThinkAmount(6400 * 0.5, 0);
    const later = stewardThinkAmount(6400 * 0.62, 0);
    expect(mid).toBeGreaterThan(0.4);
    expect(later).toBeGreaterThan(0);
    expect(Math.abs(mid - later)).toBeLessThan(0.7);
  });

  test('pinch then form anticipates: dense dot before the glyph', () => {
    expect(pinchThenForm(0)).toEqual({ pinch: 0, form: 0 });
    const windup = pinchThenForm(0.2);
    expect(windup.pinch).toBeGreaterThan(0.7);
    expect(windup.form).toBeLessThan(0.2);
    const formed = pinchThenForm(1);
    expect(formed.pinch).toBe(0);
    expect(formed.form).toBe(1);
  });

  test('bang only on an up day; toggle dwells when watching', () => {
    expect(stewardBangAmount(7200 * 0.3, 0, 'idle')).toBe(0);
    expect(stewardBangAmount(7200 * 0.3, 0, 'up')).toBe(1);
    expect(stewardToggleAmount(0, 0, true, true)).toBeGreaterThan(0.3);
    expect(stewardToggleAmount(0, 0, false, false)).toBe(0);
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
    expect(stillUp.surprise).toBe(1);
    expect(stillUp.bang).toBe(0);
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
    expect(stillThink.toggle).toBe(0.85);
    expect(stillThink.listen).toBe(0);
  });

  test('live idle listens; up/down win over listen; glyphs mute blink', () => {
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
      elapsedMs: 7200 * 0.3,
      delayMs: 0,
      mood: 'up',
      alive: true,
      reducedMotion: false,
      thinking: false,
    });
    expect(up.up).toBe(1);
    expect(up.listen).toBe(0);
    expect(up.bang).toBe(1);
    expect(up.blink).toBe(0);
  });

  test('approach eases toward the target instead of snapping', () => {
    const stepped = approachParam(0, 1, 0.05, 0.16);
    expect(stepped).toBeGreaterThan(0);
    expect(stepped).toBeLessThan(0.5);
    expect(approachParam(0.4, 0.4, 0.1)).toBe(0.4);
  });
});
