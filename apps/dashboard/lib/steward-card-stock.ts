/**
 * Trading-card stock: thin laminate, dark core, printed face.
 * Dimensions match a physical ID, not a chunky prop.
 */
import { stewardBotKind, stewardSpecies } from './desk-avatar';

export const STEWARD_CARD = {
  width: 2.1,
  height: 3.0,
  depth: 0.042,
  radius: 0.11,
  paper: 0.006,
  core: 0.028,
} as const;

export const STEWARD_CARD_DPR_CAP = 1.5;

export const STEWARD_CARD_TEX = {
  width: 768,
  height: 1097,
} as const;

export type StewardCardInk = {
  slug: string;
  name: string;
  domain: string;
  fill: string;
  paper: string;
  core: string;
  type: string;
};

export function stewardCardInk(slug: string, name: string): StewardCardInk {
  const kind = stewardBotKind(slug, name);
  const fill = stewardSpecies(kind).fill;
  return {
    slug,
    name,
    domain: '',
    fill,
    paper: mixHex(fill, '#141820', 0.42),
    core: '#07090c',
    type: '#efe6d6',
  };
}

export function cardPixelRatio(deviceRatio: number): number {
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) return 1;
  return Math.min(deviceRatio, STEWARD_CARD_DPR_CAP);
}

export function paintCardAlbedo(
  ctx: CanvasRenderingContext2D,
  ink: StewardCardInk,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  const wash = ctx.createLinearGradient(0, 0, w * 0.2, h);
  wash.addColorStop(0, mixHex(ink.fill, '#1a1e24', 0.38));
  wash.addColorStop(0.45, ink.paper);
  wash.addColorStop(1, mixHex(ink.fill, '#0b0d10', 0.22));
  ctx.fillStyle = wash;
  roundRect(ctx, 0, 0, w, h, w * 0.055);
  ctx.fill();

  ctx.fillStyle = mixHex(ink.fill, '#0c0f14', 0.18);
  ctx.fillRect(0, 0, w, h * 0.132);

  ctx.fillStyle = ink.type;
  ctx.globalAlpha = 0.72;
  ctx.font = `${Math.round(w * 0.028)}px "Special Elite", "Courier Prime", monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillText('GRASSHOPPER', w * 0.07, h * 0.068);
  ctx.textAlign = 'right';
  ctx.fillText('STEWARD', w * 0.93, h * 0.068);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;

  const tearY = h * 0.132;
  ctx.fillStyle = ink.core;
  for (let x = w * 0.04; x < w * 0.96; x += w * 0.038) {
    ctx.beginPath();
    ctx.arc(x, tearY, w * 0.011, 0, Math.PI * 2);
    ctx.fill();
  }

  const cx = w * 0.5;
  const cy = h * 0.42;
  const r = w * 0.2;
  const well = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  well.addColorStop(0, mixHex(ink.fill, '#0a0c10', 0.28));
  well.addColorStop(1, mixHex(ink.core, ink.fill, 0.2));
  ctx.fillStyle = well;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = mixHex(ink.fill, '#fff6e8', 0.35);
  ctx.lineWidth = w * 0.008;
  ctx.stroke();

  ctx.fillStyle = ink.type;
  ctx.textAlign = 'center';
  ctx.font = `${Math.round(w * 0.062)}px "Special Elite", "Courier Prime", monospace`;
  ctx.fillText(ink.name, cx, h * 0.7);
  ctx.fillStyle = mixHex(ink.fill, '#f3eee4', 0.55);
  ctx.font = `600 ${Math.round(w * 0.036)}px "IBM Plex Sans", sans-serif`;
  ctx.fillText(ink.domain.toUpperCase(), cx, h * 0.78);
  ctx.textAlign = 'left';
}

export function paintFoilMask(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, w, h);
  const edge = ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(0, '#f2f2f2');
  edge.addColorStop(0.14, '#bdbdbd');
  edge.addColorStop(0.2, '#2a2a2a');
  edge.addColorStop(0.62, '#2a2a2a');
  edge.addColorStop(0.68, '#d8d8d8');
  edge.addColorStop(0.84, '#8a8a8a');
  edge.addColorStop(1, '#f0f0f0');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h * 0.16);
  ctx.fillRect(0, h * 0.64, w, h * 0.22);
  ctx.fillStyle = '#efefef';
  ctx.fillRect(0, 0, w * 0.045, h);
  ctx.fillRect(w * 0.955, 0, w * 0.045, h);
  ctx.fillRect(0, h * 0.96, w, h * 0.04);
  const cx = w * 0.5;
  const cy = h * 0.42;
  const r = w * 0.2;
  ctx.strokeStyle = '#f7f7f7';
  ctx.lineWidth = w * 0.03;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

export function stampStewardFace(
  dest: CanvasRenderingContext2D,
  base: CanvasImageSource,
  icon: CanvasImageSource,
): void {
  const w = dest.canvas.width;
  const h = dest.canvas.height;
  dest.clearRect(0, 0, w, h);
  dest.drawImage(base, 0, 0, w, h);
  const d = w * 0.36;
  dest.save();
  dest.beginPath();
  dest.arc(w * 0.5, h * 0.42, w * 0.178, 0, Math.PI * 2);
  dest.clip();
  dest.drawImage(icon, w * 0.5 - d / 2, h * 0.42 - d / 2, d, d);
  dest.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function mixHex(a: string, b: string, t: number): string {
  const left = hexRgb(a);
  const right = hexRgb(b);
  const u = clamp01(t);
  return rgbHex(
    left[0] + (right[0] - left[0]) * u,
    left[1] + (right[1] - left[1]) * u,
    left[2] + (right[2] - left[2]) * u,
  );
}

function hexRgb(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  const full = raw.length === 3
    ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
    : raw;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((ch) => Math.round(clamp01(ch / 255) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
