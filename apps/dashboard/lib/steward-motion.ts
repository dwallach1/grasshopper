/**
 * Soft emote curves for GPU stewards. Times are milliseconds.
 * Double-blink + staggered glance so the desk does not pulse in lockstep.
 */

const BLINK_CYCLE_MS = 4600;
const BREATHE_CYCLE_MS = 4200;
const GLANCE_CYCLE_MS = 7200;
const PULSE_CYCLE_MS = 1800;

function saw(elapsedMs: number, delayMs: number, cycleMs: number): number {
  const t = (elapsedMs + delayMs) / cycleMs;
  return t - Math.floor(t);
}

function lobe(phase: number, start: number, end: number): number {
  if (phase <= start || phase >= end) return 0;
  return Math.sin(((phase - start) / (end - start)) * Math.PI);
}

export function stewardBreathe(elapsedMs: number, delayMs: number, alive: boolean): number {
  const cycle = alive ? 2200 : BREATHE_CYCLE_MS;
  return 0.5 + 0.5 * Math.sin(saw(elapsedMs, delayMs, cycle) * Math.PI * 2);
}

export function stewardBlinkCover(elapsedMs: number, delayMs: number, restCover: number): number {
  const phase = saw(elapsedMs, delayMs, BLINK_CYCLE_MS);
  const close = Math.max(lobe(phase, 0.72, 0.81), lobe(phase, 0.85, 0.89));
  return restCover + (1 - restCover) * close;
}

export function stewardGlanceX(elapsedMs: number, delayMs: number): number {
  const phase = saw(elapsedMs, delayMs, GLANCE_CYCLE_MS);
  if (phase > 0.28 && phase < 0.52) return 0.16 * Math.sin(((phase - 0.28) / 0.24) * Math.PI);
  if (phase > 0.52 && phase < 0.76) return -0.12 * Math.sin(((phase - 0.52) / 0.24) * Math.PI);
  return 0;
}

export function stewardPulse(elapsedMs: number, delayMs: number, alive: boolean): number {
  if (!alive) return 1;
  const wave = 0.5 + 0.5 * Math.sin(saw(elapsedMs, delayMs, PULSE_CYCLE_MS) * Math.PI * 2);
  return 1 + wave * 0.08;
}
