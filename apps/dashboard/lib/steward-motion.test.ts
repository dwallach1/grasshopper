import { describe, expect, test } from 'bun:test';

import {
  stewardBlinkCover,
  stewardBreathe,
  stewardGlanceX,
  stewardPulse,
} from './steward-motion';

describe('steward motion curves', () => {
  test('blink stays at rest cover except during the close windows', () => {
    expect(stewardBlinkCover(0, 0, 0.5)).toBe(0.5);
    expect(stewardBlinkCover(4600 * 0.4, 0, 0.5)).toBe(0.5);
    expect(stewardBlinkCover(4600 * 0.765, 0, 0.5)).toBeGreaterThan(0.85);
    expect(stewardBlinkCover(4600 * 0.87, 0, 0.5)).toBeGreaterThan(0.85);
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
    expect(stewardGlanceX(7200 * 0.4, 0)).not.toBe(0);
    expect(stewardPulse(200, 0, false)).toBe(1);
    expect(stewardPulse(450, 0, true)).toBeGreaterThan(1);
  });
});
