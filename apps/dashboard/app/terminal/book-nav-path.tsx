'use client';

import { useEffect, useRef, useState } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { NAV_WINDOWS, type NavPoint, type NavWindowId } from '../../lib/book-nav-path';
import { BookNavRibbon } from './book-nav-ribbon';
import { moneyPrecise } from './format';
import { chartLayout, yTicks } from './nav-chart-layout';

const COL = {
  bg: '#07080a',
  line: '#5b9fd4',
  up: '#3ddc84',
  down: '#ff5c33',
  grid: '#1c242e',
  ref: '#ffb000',
  text: '#8b98a8',
  label: '#5c6773',
};

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function prefersReduced(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function strokeForPnl(dayPnl: number | null): string {
  if (dayPnl === null) return COL.line;
  if (dayPnl > 0) return COL.up;
  if (dayPnl < 0) return COL.down;
  return COL.line;
}

function paintCanvas(
  ctx: CanvasRenderingContext2D,
  input: {
    points: readonly NavPoint[];
    displayValue: number | null;
    startingNav: number | null;
    dayPnl: number | null;
    width: number;
    height: number;
    dpr: number;
  },
) {
  const { width, height, dpr } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, width, height);

  const layout = chartLayout({
    points: input.points,
    displayValue: input.displayValue,
    startingNav: input.startingNav,
    width,
    height,
  });

  ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillStyle = COL.label;
  ctx.strokeStyle = COL.grid;
  ctx.lineWidth = 1;
  const ticks = yTicks(layout.yMin, layout.yMax);
  ticks.forEach((value, i) => {
    const y = layout.gridY[i];
    if (y === undefined) return;
    ctx.beginPath();
    ctx.moveTo(layout.pad.left, y);
    ctx.lineTo(width - layout.pad.right, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(moneyPrecise(value), layout.pad.left - 6, y);
  });

  if (layout.refY !== null) {
    ctx.strokeStyle = COL.ref;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(layout.pad.left, layout.refY);
    ctx.lineTo(width - layout.pad.right, layout.refY);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = COL.ref;
    ctx.textAlign = 'left';
    ctx.fillText('start', width - layout.pad.right + 4, layout.refY);
  }

  if (layout.coords.length >= 1) {
    ctx.strokeStyle = COL.line;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    layout.coords.forEach((pt, i) => {
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.stroke();
    const tip = layout.coords[layout.coords.length - 1]!;
    const glow = strokeForPnl(input.dayPnl);
    const grad = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 16);
    grad.addColorStop(0, `${glow}cc`);
    grad.addColorStop(1, `${glow}00`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = COL.label;
  ctx.textBaseline = 'top';
  if (layout.coords[0]) {
    ctx.textAlign = 'left';
    ctx.fillText(formatStamp(layout.tMin), layout.pad.left, height - 18);
  }
  if (layout.coords.length > 1) {
    ctx.textAlign = 'right';
    ctx.fillText(formatStamp(layout.tMax), width - layout.pad.right, height - 18);
  }
}

const stampFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatStamp(ms: number): string {
  return `${stampFmt.format(new Date(ms))} ET`;
}

export function BookNavPath({
  points,
  value,
  startingNav,
  dayPnl,
  windowId,
  onWindow,
}: {
  points: readonly NavPoint[];
  value: number | null;
  startingNav: number | null;
  dayPnl: number | null;
  windowId: NavWindowId;
  onWindow: (id: NavWindowId) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ width: 0, height: 220 });
  const [gl, setGl] = useState(false);
  const [reduced, setReduced] = useState(false);
  const shownRef = useRef(value);
  const pointsRef = useRef(points);
  const valueRef = useRef(value);
  const startRef = useRef(startingNav);
  const pnlRef = useRef(dayPnl);
  pointsRef.current = points;
  valueRef.current = value;
  startRef.current = startingNav;
  pnlRef.current = dayPnl;

  useEffect(() => {
    setGl(webglAvailable());
    setReduced(prefersReduced());
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      setSize({
        width: Math.max(0, host.clientWidth),
        height: Math.max(180, host.clientHeight),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (gl) return;
    const canvas = canvasRef.current;
    if (!canvas || size.width < 8) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    let frame = 0;
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      const target = valueRef.current;
      if (reduced || shownRef.current === null || target === null) {
        shownRef.current = target;
      } else {
        shownRef.current += (target - shownRef.current) * 0.08;
        if (Math.abs(shownRef.current - target) < 0.01) shownRef.current = target;
      }
      paintCanvas(ctx, {
        points: pointsRef.current,
        displayValue: shownRef.current,
        startingNav: startRef.current,
        dayPnl: pnlRef.current,
        width: size.width,
        height: size.height,
        dpr,
      });
      if (overlayRef.current) {
        overlayRef.current.textContent = shownRef.current === null
          ? NOT_IN_LEDGER
          : moneyPrecise(shownRef.current);
        overlayRef.current.className = `term-nav-value ${
          pnlRef.current === null ? 'muted' : (pnlRef.current > 0 ? 'up' : (pnlRef.current < 0 ? 'down' : 'muted'))
        }`;
      }
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [gl, reduced, size.height, size.width]);

  useEffect(() => {
    if (!gl) return;
    let frame = 0;
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      const target = valueRef.current;
      if (reduced || shownRef.current === null || target === null) {
        shownRef.current = target;
      } else {
        shownRef.current += (target - shownRef.current) * 0.08;
        if (Math.abs(shownRef.current - target) < 0.01) shownRef.current = target;
      }
      if (overlayRef.current) {
        overlayRef.current.textContent = shownRef.current === null
          ? NOT_IN_LEDGER
          : moneyPrecise(shownRef.current);
        overlayRef.current.className = `term-nav-value ${
          pnlRef.current === null ? 'muted' : (pnlRef.current > 0 ? 'up' : (pnlRef.current < 0 ? 'down' : 'muted'))
        }`;
      }
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [gl, reduced]);

  const empty = value === null && points.length === 0;

  return (
    <div className="term-nav-path">
      <header>
        <b>NAV PATH</b>
        <span>Agentic snapshots · lerp between ledger prints</span>
        <nav className="term-nav-windows" aria-label="NAV window">
          {NAV_WINDOWS.map((row) => (
            <button
              key={row.id}
              type="button"
              className={windowId === row.id ? 'on' : ''}
              onClick={() => onWindow(row.id)}
            >
              {row.label}
            </button>
          ))}
        </nav>
      </header>
      <div ref={hostRef} className="term-nav-body">
        {empty ? (
          <p className="empty">{NOT_IN_LEDGER}</p>
        ) : gl ? (
          <BookNavRibbon
            points={points}
            value={value}
            startingNav={startingNav}
            dayPnl={dayPnl}
            width={size.width}
            height={size.height}
            reducedMotion={reduced}
          />
        ) : (
          <canvas ref={canvasRef} className="term-nav-canvas" />
        )}
        {!empty && (
          <span ref={overlayRef} className="term-nav-value muted">
            {value === null ? NOT_IN_LEDGER : moneyPrecise(value)}
          </span>
        )}
      </div>
    </div>
  );
}
