/**
 * Retina 2d fallback when WebGL is blocked. Crisp gradients, no SVG noise.
 * Phone desk uses the GPU path in steward-gl.ts.
 */
import {
  stewardFurTone,
  stewardMeshSpec,
  type StewardBotKind,
} from '../../lib/desk-avatar';
import {
  stewardBlinkCover,
  stewardBreathe,
  stewardGlanceX,
  stewardPulse,
} from '../../lib/steward-motion';

type FlatSlot = {
  canvas: HTMLCanvasElement;
  kind: StewardBotKind;
  alive: boolean;
  delayMs: number;
  visible: boolean;
};

const flats = new Set<FlatSlot>();
let raf = 0;
let originMs = 0;

export function attachFlatCanvas(
  canvas: HTMLCanvasElement,
  kind: StewardBotKind,
  alive: boolean,
  delayMs: number,
): () => void {
  const slot: FlatSlot = { canvas, kind, alive, delayMs, visible: true };
  flats.add(slot);
  canvas.dataset.runtime = 'canvas2d';
  const observer = new IntersectionObserver((entries) => {
    slot.visible = entries.some((entry) => entry.isIntersecting);
  }, { threshold: 0.05 });
  observer.observe(canvas);
  originMs = originMs || performance.now();
  paintFlat(slot, 0, reducedMotion());
  if (!raf && !reducedMotion()) {
    const tick = (now: number) => {
      raf = window.requestAnimationFrame(tick);
      for (const item of flats) {
        if (item.visible) paintFlat(item, now - originMs, false);
      }
    };
    raf = window.requestAnimationFrame(tick);
  }
  return () => {
    observer.disconnect();
    flats.delete(slot);
    if (flats.size === 0) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

export function paintFlat(slot: FlatSlot, elapsed: number, still: boolean) {
  const spec = stewardMeshSpec(slot.kind);
  const fur = stewardFurTone(slot.kind);
  const css = slot.canvas.clientWidth || slot.canvas.offsetWidth || 72;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.max(1, Math.round(css * dpr));
  if (slot.canvas.width !== px || slot.canvas.height !== px) {
    slot.canvas.width = px;
    slot.canvas.height = px;
  }
  const ctx = slot.canvas.getContext('2d');
  if (!ctx) return;
  const breathe = still ? 0.5 : stewardBreathe(elapsed, slot.delayMs, slot.alive);
  const blink = still ? spec.lidCover : stewardBlinkCover(elapsed, slot.delayMs, spec.lidCover);
  const glance = still ? 0 : stewardGlanceX(elapsed, slot.delayMs);
  const pulse = still ? 1 : stewardPulse(elapsed, slot.delayMs, slot.alive);
  ctx.setTransform(px / 64, 0, 0, px / 64, 0, 0);
  ctx.clearRect(0, 0, 64, 64);
  ctx.save();
  ctx.translate(32, 34 - breathe * 1.1);
  ctx.scale(1 - breathe * 0.012, 1 + breathe * 0.028);
  ctx.translate(-32, -34);
  drawMound(ctx, slot.kind, fur.base, fur.deep, fur.lit);
  drawEye(ctx, 32 - spec.eyeSpread * 28, 30 - spec.eyeY * 10, spec.eyeR * 18, blink, spec.lidTiltL, glance, pulse, fur.base, fur.deep);
  drawEye(ctx, 32 + spec.eyeSpread * 28, 30 - spec.eyeY * 10, spec.eyeR * 18, blink, spec.lidTiltR, glance, pulse, fur.base, fur.deep);
  ctx.restore();
}

function drawMound(
  ctx: CanvasRenderingContext2D,
  kind: StewardBotKind,
  base: string,
  deep: string,
  lit: string,
) {
  ctx.beginPath();
  ctx.ellipse(32, 59.6, kind === 'quantanamo' ? 20 : kind === 'oddsborne' ? 13 : 16, 1.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fill();
  ctx.beginPath();
  moundPath(ctx, kind);
  const fill = ctx.createRadialGradient(24, 20, 4, 32, 36, 28);
  fill.addColorStop(0, lit);
  fill.addColorStop(0.45, base);
  fill.addColorStop(1, deep);
  ctx.fillStyle = fill;
  ctx.fill();
}

function moundPath(ctx: CanvasRenderingContext2D, kind: StewardBotKind) {
  if (kind === 'quantanamo') {
    ctx.moveTo(4.2, 50.6);
    ctx.bezierCurveTo(3.2, 41, 8, 26, 16, 18.6);
    ctx.bezierCurveTo(20.4, 13.8, 26.8, 15, 30.2, 18);
    ctx.bezierCurveTo(34.2, 12.4, 40.8, 11.2, 46.6, 16.6);
    ctx.bezierCurveTo(54.4, 23.8, 59.2, 35.2, 59.4, 46);
    ctx.bezierCurveTo(59.6, 53.2, 53.2, 58.8, 42.4, 60.2);
    ctx.bezierCurveTo(31.8, 61.6, 12.4, 59.6, 4.2, 50.6);
    return;
  }
  if (kind === 'oddsborne') {
    ctx.moveTo(13.6, 53);
    ctx.bezierCurveTo(11.4, 41.8, 16, 20.2, 26.4, 8.8);
    ctx.bezierCurveTo(29.8, 4.6, 34, 3, 36.6, 6.4);
    ctx.bezierCurveTo(38.4, 8.8, 37.8, 11.6, 41, 13.8);
    ctx.bezierCurveTo(47.8, 19.4, 52.6, 31.4, 54, 42.8);
    ctx.bezierCurveTo(55, 51.4, 51, 57.8, 42.4, 59.4);
    ctx.bezierCurveTo(34.6, 60.8, 22.8, 60.4, 16.4, 56.6);
    ctx.bezierCurveTo(14.2, 55.2, 13.6, 54.2, 13.6, 53);
    return;
  }
  if (kind === 'bandit') {
    ctx.moveTo(10.4, 53);
    ctx.bezierCurveTo(9.2, 41.2, 14.4, 22.8, 24.6, 14.6);
    ctx.bezierCurveTo(30.4, 9.6, 36.8, 10.4, 40.6, 15.4);
    ctx.bezierCurveTo(44.4, 20.4, 45.6, 28.6, 53.6, 36.4);
    ctx.bezierCurveTo(59.2, 42.4, 59.6, 51.8, 50.6, 57.2);
    ctx.bezierCurveTo(41.4, 61.2, 22.6, 60.4, 13.6, 56.2);
    ctx.bezierCurveTo(11.2, 54.8, 10.4, 53.8, 10.4, 53);
    return;
  }
  if (kind === 'grasshopper') {
    ctx.moveTo(7.4, 53);
    ctx.bezierCurveTo(6.4, 43.6, 10.6, 26, 20.4, 18.4);
    ctx.bezierCurveTo(26.4, 14.4, 38.2, 14.4, 44.2, 18.4);
    ctx.bezierCurveTo(54, 26, 57.6, 43.6, 56.6, 53);
    ctx.bezierCurveTo(55.6, 58.6, 43.8, 60.4, 32, 60.4);
    ctx.bezierCurveTo(20.2, 60.4, 8.4, 58.6, 7.4, 53);
    return;
  }
  ctx.moveTo(13.4, 51.8);
  ctx.bezierCurveTo(12.4, 41.6, 16.6, 26, 26, 18.4);
  ctx.bezierCurveTo(30.4, 15.2, 36.6, 15.2, 40.6, 19);
  ctx.bezierCurveTo(48.2, 26.2, 51.6, 40, 50.6, 50.8);
  ctx.bezierCurveTo(49.8, 56.6, 40.2, 59.2, 32, 59.2);
  ctx.bezierCurveTo(22.6, 59.2, 14.4, 56.6, 13.4, 51.8);
}

function drawEye(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  lid: number,
  tilt: number,
  glance: number,
  pulse: number,
  fur: string,
  deep: string,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  const sclera = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.1, 0, 0, r);
  sclera.addColorStop(0, '#fffdf8');
  sclera.addColorStop(1, '#efe8dc');
  ctx.fillStyle = sclera;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(glance * r * 0.7, r * 0.18, r * 0.32 * pulse, 0, Math.PI * 2);
  ctx.fillStyle = '#16141c';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-r * 0.18, r * 0.02, r * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.rotate(tilt);
  ctx.beginPath();
  ctx.arc(0, 0, r + 0.2, Math.PI, 0, true);
  const lidY = -r + r * 2 * lid;
  ctx.lineTo(r, lidY);
  ctx.quadraticCurveTo(0, lidY + r * 0.16, -r, lidY);
  ctx.closePath();
  const lidFill = ctx.createLinearGradient(0, -r, 0, lidY);
  lidFill.addColorStop(0, fur);
  lidFill.addColorStop(1, deep);
  ctx.fillStyle = lidFill;
  ctx.fill();
  ctx.restore();
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
