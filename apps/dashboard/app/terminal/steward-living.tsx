'use client';

import { useEffect, useRef } from 'react';

import type { StewardBotKind, StewardMood } from '../../lib/desk-avatar';
import { stewardSpecies } from '../../lib/desk-avatar';
import { composeStewardPose, paintStewardIcon, stewardDrawMarks } from '../../lib/steward-icon';
import { approachParam, stewardMotion } from '../../lib/steward-motion';
import styles from './steward-avatar.module.css';

export function StewardLivingIcon({
  kind,
  mood,
  alive,
  thinking,
  reducedMotion,
  delayMs,
}: {
  kind: StewardBotKind;
  mood: StewardMood;
  alive: boolean;
  thinking: boolean;
  reducedMotion: boolean;
  delayMs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const species = stewardSpecies(kind);
    const eased = { up: 0, down: 0, listen: 0, think: 0 };
    let frame = 0;
    const born = performance.now();
    let last = born;

    const paint = (now: number) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const clock = stewardMotion({
        elapsedMs: now - born,
        delayMs,
        mood,
        alive,
        reducedMotion,
        thinking,
      });
      if (reducedMotion) {
        eased.up = clock.up;
        eased.down = clock.down;
        eased.listen = clock.listen;
        eased.think = clock.think;
      } else {
        eased.up = approachParam(eased.up, clock.up, dt);
        eased.down = approachParam(eased.down, clock.down, dt);
        eased.listen = approachParam(eased.listen, clock.listen, dt);
        eased.think = approachParam(eased.think, clock.think, dt);
      }
      const pose = composeStewardPose(species, {
        ...clock,
        up: eased.up,
        down: eased.down,
        listen: eased.listen,
        think: eased.think,
      });
      const ratio = window.devicePixelRatio || 1;
      const css = canvas.clientWidth || 64;
      const pixel = Math.max(1, Math.round(css * ratio));
      if (canvas.width !== pixel || canvas.height !== pixel) {
        canvas.width = pixel;
        canvas.height = pixel;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pixel, pixel);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintStewardIcon(ctx, stewardDrawMarks(species, pose, css));
    };

    paint(performance.now());
    if (reducedMotion) return;

    const tick = (now: number) => {
      paint(now);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [alive, delayMs, kind, mood, reducedMotion, thinking]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.icon}
      data-runtime="icon"
      data-icon="circle-eyes"
      aria-hidden="true"
    />
  );
}
