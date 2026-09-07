/**
 * Continuous living-icon parameters. Eyes carry the life: glance, blink,
 * pinch-then-stretch into symbols. Not a timeline clip or a CSS bounce.
 */
import type { StewardMood } from './desk-avatar';

const BLINK_CYCLE_MS = 2800;
const BREATHE_CYCLE_MS = 2400;
const GLANCE_CYCLE_MS = 5200;
const THINK_CYCLE_MS = 6400;
const BANG_CYCLE_MS = 7200;
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
  surprise: number;
  bang: number;
  toggle: number;
};

export type PinchForm = {
  pinch: number;
  form: number;
};

function saw(elapsedMs: number, delayMs: number, cycleMs: number): number {
  const t = (elapsedMs + delayMs) / cycleMs;
  return t - Math.floor(t);
}

function lobe(phase: number, start: number, end: number): number {
  if (phase <= start || phase >= end) return 0;
  return Math.sin(((phase - start) / (end - start)) * Math.PI);
}

export function easeOutCubic(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return 1 - (1 - u) ** 3;
}

/** Anticipation: shrink to a dense dot, then stretch into the glyph. */
export function pinchThenForm(amount: number): PinchForm {
  const a = Math.min(1, Math.max(0, amount));
  const pinch = a <= 0 || a >= 0.42 ? 0 : Math.sin((a / 0.42) * Math.PI);
  const form = a < 0.18 ? 0 : easeOutCubic((a - 0.18) / 0.82);
  return { pinch, form };
}

export function stewardBreathe(elapsedMs: number, delayMs: number, alive: boolean): number {
  const cycle = alive ? 1800 : BREATHE_CYCLE_MS;
  return 0.5 + 0.5 * Math.sin(saw(elapsedMs, delayMs, cycle) * Math.PI * 2);
}

export function stewardBlinkCover(elapsedMs: number, delayMs: number, restCover: number): number {
  const phase = saw(elapsedMs, delayMs, BLINK_CYCLE_MS);
  const close = Math.max(lobe(phase, 0.7, 0.82), lobe(phase, 0.86, 0.91));
  return restCover + (1 - restCover) * close;
}

export function stewardBlinkAmount(elapsedMs: number, delayMs: number): number {
  return stewardBlinkCover(elapsedMs, delayMs, 0);
}

export function stewardGlanceX(elapsedMs: number, delayMs: number): number {
  const phase = saw(elapsedMs, delayMs, GLANCE_CYCLE_MS);
  if (phase > 0.16 && phase < 0.44) return 0.38 * Math.sin(((phase - 0.16) / 0.28) * Math.PI);
  if (phase > 0.44 && phase < 0.78) return -0.3 * Math.sin(((phase - 0.44) / 0.34) * Math.PI);
  return 0;
}

export function stewardGlanceY(elapsedMs: number, delayMs: number): number {
  const phase = saw(elapsedMs, delayMs, GLANCE_CYCLE_MS);
  if (phase > 0.2 && phase < 0.42) return -0.16 * Math.sin(((phase - 0.2) / 0.22) * Math.PI);
  if (phase > 0.52 && phase < 0.72) return 0.12 * Math.sin(((phase - 0.52) / 0.2) * Math.PI);
  return 0;
}

export function stewardThinkAmount(elapsedMs: number, delayMs: number): number {
  const phase = saw(elapsedMs, delayMs, THINK_CYCLE_MS);
  return Math.max(lobe(phase, 0.28, 0.72), lobe(phase, 0.06, 0.14) * 0.4);
}

/** Up-day bang: rise, hold as !, fall back through a pinch. */
export function stewardBangAmount(elapsedMs: number, delayMs: number, mood: StewardMood): number {
  if (mood !== 'up') return 0;
  const phase = saw(elapsedMs, delayMs, BANG_CYCLE_MS);
  if (phase < 0.12 || phase > 0.52) return 0;
  if (phase < 0.22) return (phase - 0.12) / 0.1;
  if (phase < 0.4) return 1;
  return 1 - (phase - 0.4) / 0.12;
}

export function stewardToggleAmount(
  elapsedMs: number,
  delayMs: number,
  thinking: boolean,
  idle: boolean,
): number {
  if (!thinking && !idle) return 0;
  const wave = stewardThinkAmount(elapsedMs, delayMs + 380);
  if (thinking) return Math.min(1, 0.32 + wave * 0.68);
  return wave;
}

export function stewardPulse(elapsedMs: number, delayMs: number, alive: boolean): number {
  if (!alive) return 1;
  const wave = 0.5 + 0.5 * Math.sin(saw(elapsedMs, delayMs, PULSE_CYCLE_MS) * Math.PI * 2);
  return 1 + wave * 0.02;
}

export function stewardMotion(clock: StewardClock): StewardMotion {
  const up = clock.mood === 'up' ? 1 : 0;
  const down = clock.mood === 'down' ? 1 : 0;
  const listen = clock.alive && clock.mood === 'idle' ? 1 : 0;
  const idleFace = clock.mood === 'idle' && !clock.alive;
  if (clock.reducedMotion) {
    return {
      blink: 0,
      think: clock.thinking && idleFace ? 0.7 : 0,
      listen,
      up,
      down,
      glanceX: 0,
      glanceY: 0,
      breathe: 0.5,
      pulse: 1,
      surprise: up,
      bang: 0,
      toggle: clock.thinking && idleFace ? 0.85 : 0,
    };
  }

  const bang = stewardBangAmount(clock.elapsedMs, clock.delayMs, clock.mood);
  const toggle = stewardToggleAmount(clock.elapsedMs, clock.delayMs, clock.thinking, idleFace);
  const glyph = Math.max(bang, toggle);
  const blink = glyph > 0.18 ? 0 : stewardBlinkAmount(clock.elapsedMs, clock.delayMs);

  return {
    blink,
    think: toggle,
    listen,
    up,
    down,
    glanceX: stewardGlanceX(clock.elapsedMs, clock.delayMs) * (1 - glyph * 0.7),
    glanceY: stewardGlanceY(clock.elapsedMs, clock.delayMs) * (1 - glyph * 0.7),
    breathe: stewardBreathe(clock.elapsedMs, clock.delayMs, clock.alive),
    pulse: stewardPulse(clock.elapsedMs, clock.delayMs, clock.alive),
    surprise: up * (1 - blink) * (1 - glyph * 0.5),
    bang,
    toggle,
  };
}

/** Exponential ease so desk mood/listen morph instead of snapping. */
export function approachParam(current: number, target: number, dtSec: number, tauSec = 0.16): number {
  const k = 1 - Math.exp(-Math.max(0, dtSec) / tauSec);
  return current + (target - current) * k;
}
