'use client';

import { useEffect, useRef } from 'react';

import type { StewardBotKind, StewardMood } from '../../lib/desk-avatar';
import { stewardSpecies } from '../../lib/desk-avatar';
import { composeStewardPose, paintStewardIcon, stewardDrawMarks } from '../../lib/steward-icon';
import {
  approachParam,
  stewardExpressionPreview,
  stewardMotion,
  type StewardExpression,
} from '../../lib/steward-motion';
import styles from './steward-avatar.module.css';

export function StewardLivingIcon({
  kind,
  mood,
  alive,
  thinking,
  attending,
  preview,
  reducedMotion,
  delayMs,
}: {
  kind: StewardBotKind;
  mood: StewardMood;
  alive: boolean;
  thinking: boolean;
  attending: boolean;
  preview?: StewardExpression;
  reducedMotion: boolean;
  delayMs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const species = stewardSpecies(kind);
    const eased = { up: 0, down: 0, listen: 0, surprise: 0, speak: 0 };
    let frame = 0;
    const born = performance.now();
    let last = born;

    const paint = (now: number) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const clock = preview
        ? stewardExpressionPreview(preview)
        : stewardMotion({
            elapsedMs: now - born,
            delayMs,
            mood,
            alive,
            reducedMotion,
            thinking,
            attending,
          });
      if (reducedMotion || preview) {
        eased.up = clock.up;
        eased.down = clock.down;
        eased.listen = clock.listen;
        eased.surprise = clock.surprise;
        eased.speak = clock.speak;
      } else {
        eased.up = approachParam(eased.up, clock.up, dt);
        eased.down = approachParam(eased.down, clock.down, dt);
        eased.listen = approachParam(eased.listen, clock.listen, dt);
        eased.surprise = approachParam(eased.surprise, clock.surprise, dt);
        eased.speak = approachParam(eased.speak, alive ? 1 : 0, dt);
      }
      const pose = composeStewardPose(species, {
        ...clock,
        up: eased.up,
        down: eased.down,
        listen: eased.listen,
        surprise: eased.surprise,
        speak: reducedMotion ? clock.speak : clock.speak * eased.speak,
        think: reducedMotion ? clock.think : clock.think,
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
    if (reducedMotion || preview) return;

    const tick = (now: number) => {
      paint(now);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [alive, attending, delayMs, kind, mood, preview, reducedMotion, thinking]);

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
