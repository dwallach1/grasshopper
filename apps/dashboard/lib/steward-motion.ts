/**
 * Continuous living-icon parameters. Every state is a blend of numbers,
 * not a timeline clip or a CSS bounce on a blob.
 */
import type { StewardMood } from './desk-avatar';

const BLINK_CYCLE_MS = 3400;
const BREATHE_CYCLE_MS = 2800;
const GLANCE_CYCLE_MS = 7600;
const THINK_CYCLE_MS = 11000;
const PULSE_CYCLE_MS = 1800;

export type StewardClock = {
  elapsedMs: number;
  delayMs: number;
  mood: StewardMood;
  alive: boolean;
  reducedMotion: boolean;
  thinking: boolean;
};

export type StewardMotion = {
  blink: number;
  think: number;
  listen: number;
  up: number;
  down: number;
  glanceX: number;
  glanceY: number;
  breathe: number;
  pulse: number;
};

function saw(elapsedMs: number, delayMs: number, cycleMs: number): number {
  const t = (elapsedMs + delayMs) / cycleMs;
  return t - Math.floor(t);
}

function lobe(phase: number, start: number, end: number): number {
  if (phase <= start || phase >= end) return 0;
  return Math.sin(((phase - start) / (end - start)) * Math.PI);
}

export function stewardBreathe(elapsedMs: number, delayMs: number, alive: boolean): number {
  const cycle = alive ? 2000 : BREATHE_CYCLE_MS;
  return 0.5 + 0.5 * Math.sin(saw(elapsedMs, delayMs, cycle) * Math.PI * 2);
}

export function stewardBlinkCover(elapsedMs: number, delayMs: number, restCover: number): number {
  const phase = saw(elapsedMs, delayMs, BLINK_CYCLE_MS);
  const close = Math.max(lobe(phase, 0.72, 0.81), lobe(phase, 0.85, 0.89));
  return restCover + (1 - restCover) * close;
}

export function stewardBlinkAmount(elapsedMs: number, delayMs: number): number {
  return stewardBlinkCover(elapsedMs, delayMs, 0);
}

export function stewardGlanceX(elapsedMs: number, delayMs: number): number {
  const phase = saw(elapsedMs, delayMs, GLANCE_CYCLE_MS);
  if (phase > 0.22 && phase < 0.48) return 0.22 * Math.sin(((phase - 0.22) / 0.26) * Math.PI);
  if (phase > 0.48 && phase < 0.74) return -0.16 * Math.sin(((phase - 0.48) / 0.26) * Math.PI);
  return 0;
}

export function stewardGlanceY(elapsedMs: number, delayMs: number): number {
  const phase = saw(elapsedMs, delayMs, GLANCE_CYCLE_MS);
  if (phase > 0.3 && phase < 0.5) return -0.08 * Math.sin(((phase - 0.3) / 0.2) * Math.PI);
  if (phase > 0.58 && phase < 0.72) return 0.06 * Math.sin(((phase - 0.58) / 0.14) * Math.PI);
  return 0;
}

export function stewardThinkAmount(elapsedMs: number, delayMs: number): number {
  const phase = saw(elapsedMs, delayMs, THINK_CYCLE_MS);
  return Math.max(lobe(phase, 0.58, 0.82), lobe(phase, 0.08, 0.16) * 0.45);
}

export function stewardPulse(elapsedMs: number, delayMs: number, alive: boolean): number {
  if (!alive) return 1;
  const wave = 0.5 + 0.5 * Math.sin(saw(elapsedMs, delayMs, PULSE_CYCLE_MS) * Math.PI * 2);
  return 1 + wave * 0.055;
}

export function stewardMotion(clock: StewardClock): StewardMotion {
  const up = clock.mood === 'up' ? 1 : 0;
  const down = clock.mood === 'down' ? 1 : 0;
  const listen = clock.alive && clock.mood === 'idle' ? 1 : 0;
  if (clock.reducedMotion) {
    return {
      blink: 0,
      think: clock.thinking && clock.mood === 'idle' && !clock.alive ? 0.7 : 0,
      listen,
      up,
      down,
      glanceX: 0,
      glanceY: 0,
      breathe: 0.5,
      pulse: 1,
    };
  }

  const thinkWave = stewardThinkAmount(clock.elapsedMs, clock.delayMs);
  const idleThink = clock.mood === 'idle' && !clock.alive;
  const think = clock.thinking && idleThink ? 0.55 + 0.45 * thinkWave : idleThink ? thinkWave : 0;

  return {
    blink: stewardBlinkAmount(clock.elapsedMs, clock.delayMs),
    think,
    listen,
    up,
    down,
    glanceX: stewardGlanceX(clock.elapsedMs, clock.delayMs),
    glanceY: stewardGlanceY(clock.elapsedMs, clock.delayMs),
    breathe: stewardBreathe(clock.elapsedMs, clock.delayMs, clock.alive),
    pulse: stewardPulse(clock.elapsedMs, clock.delayMs, clock.alive),
  };
}

/** Exponential ease so desk mood/listen/think morph instead of snapping. */
export function approachParam(current: number, target: number, dtSec: number, tauSec = 0.16): number {
  const k = 1 - Math.exp(-Math.max(0, dtSec) / tauSec);
  return current + (target - current) * k;
}
