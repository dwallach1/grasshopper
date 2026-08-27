import type { NavPoint } from '../../lib/book-nav-path';

export type ChartPad = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export const NAV_CHART_PAD: ChartPad = {
  top: 36,
  right: 16,
  bottom: 28,
  left: 52,
};

export type ChartLayout = {
  coords: { x: number; y: number; time: number; value: number }[];
  gridY: number[];
  refY: number | null;
  yMin: number;
  yMax: number;
  tMin: number;
  tMax: number;
  pad: ChartPad;
  innerW: number;
  innerH: number;
};

function yAt(value: number, yMin: number, yMax: number, pad: ChartPad, height: number): number {
  const span = Math.max(1e-9, yMax - yMin);
  const innerH = height - pad.top - pad.bottom;
  return pad.top + (1 - (value - yMin) / span) * innerH;
}

/**
 * Pixel layout for the NAV polyline. Shared by the 2d canvas and the
 * fixed-camera three.js ribbon so axes stay honest.
 */
export function chartLayout(input: {
  points: readonly NavPoint[];
  displayValue: number | null;
  startingNav: number | null;
  width: number;
  height: number;
  pad?: ChartPad;
}): ChartLayout {
  const pad = input.pad ?? NAV_CHART_PAD;
  const innerW = Math.max(1, input.width - pad.left - pad.right);
  const innerH = Math.max(1, input.height - pad.top - pad.bottom);
  const values = input.points.map((row) => row.value);
  if (input.displayValue !== null) values.push(input.displayValue);
  if (input.startingNav !== null) values.push(input.startingNav);
  let yMin = values.length ? Math.min(...values) : 0;
  let yMax = values.length ? Math.max(...values) : 1;
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const padY = (yMax - yMin) * 0.08;
  yMin -= padY;
  yMax += padY;

  const times = input.points.map((row) => row.time);
  let tMin = times.length ? Math.min(...times) : 0;
  let tMax = times.length ? Math.max(...times) : 1;
  if (tMin === tMax) tMax = tMin + 1;

  const coords = input.points.map((row, index) => {
    const isLast = index === input.points.length - 1;
    const value = isLast && input.displayValue !== null ? input.displayValue : row.value;
    const x = pad.left + ((row.time - tMin) / (tMax - tMin)) * innerW;
    const y = yAt(value, yMin, yMax, pad, input.height);
    return { x, y, time: row.time, value };
  });

  if (coords.length === 0 && input.displayValue !== null) {
    coords.push({
      x: pad.left + innerW,
      y: yAt(input.displayValue, yMin, yMax, pad, input.height),
      time: tMax,
      value: input.displayValue,
    });
  }

  const gridY: number[] = [];
  for (let i = 0; i <= 4; i += 1) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    gridY.push(yAt(v, yMin, yMax, pad, input.height));
  }

  return {
    coords,
    gridY,
    refY: input.startingNav === null ? null : yAt(input.startingNav, yMin, yMax, pad, input.height),
    yMin,
    yMax,
    tMin,
    tMax,
    pad,
    innerW,
    innerH,
  };
}

export function yTicks(yMin: number, yMax: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 4; i += 1) out.push(yMin + ((yMax - yMin) * i) / 4);
  return out;
}
