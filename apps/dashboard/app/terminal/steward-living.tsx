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
import { presenceTempo, type StewardPresence } from '../../lib/steward-presence';
import styles from './steward-avatar.module.css';

export function StewardLivingIcon({
  kind,
  mood,
  alive,
  thinking,
  attending,
  presence,
  settle,
  preview,
  reducedMotion,
  delayMs,
}: {
  kind: StewardBotKind;
  mood: StewardMood;
  alive: boolean;
  thinking: boolean;
  attending: boolean;
  presence: StewardPresence;
  settle: number;
  preview?: StewardExpression;
  reducedMotion: boolean;
  delayMs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef({
    mood,
    alive,
    thinking,
    attending,
    presence,
    settle,
    preview,
    reducedMotion,
    delayMs,
  });

  useEffect(() => {
    liveRef.current = {
      mood,
      alive,
      thinking,
      attending,
      presence,
      settle,
      preview,
      reducedMotion,
      delayMs,
    };
  }, [alive, attending, delayMs, mood, presence, preview, reducedMotion, settle, thinking]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const species = stewardSpecies(kind);
    const eased = { up: 0, down: 0, listen: 0, surprise: 0, speak: 0, think: 0 };
    let frame = 0;
    let last = performance.now();
    let virtual = 0;
    let tempo = presenceTempo(liveRef.current.presence);
    let primed = false;

    const paint = (now: number) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const live = liveRef.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const targetTempo = presenceTempo(live.presence);
      tempo = primed ? approachParam(tempo, targetTempo, dt, 0.45) : targetTempo;
      virtual += dt * 1000 * (live.preview ? 1 : tempo);
      const clock = live.preview
        ? stewardExpressionPreview(live.preview)
        : stewardMotion({
            elapsedMs: virtual,
            delayMs: live.delayMs,
            mood: live.mood,
            alive: live.alive,
            reducedMotion: live.reducedMotion,
            thinking: live.thinking,
            attending: live.attending,
            presence: live.presence,
            settle: live.settle,
            integrated: true,
          });
      const tau = live.presence ? 0.55 : 0.16;
      if (!primed || live.reducedMotion || live.preview) {
        eased.up = clock.up;
        eased.down = clock.down;
        eased.listen = clock.listen;
        eased.surprise = clock.surprise;
        eased.speak = clock.speak;
        eased.think = clock.think;
        primed = true;
      } else {
        eased.up = approachParam(eased.up, clock.up, dt, tau);
        eased.down = approachParam(eased.down, clock.down, dt, tau);
        eased.listen = approachParam(eased.listen, clock.listen, dt, tau);
        eased.surprise = approachParam(eased.surprise, clock.surprise, dt, tau);
        eased.speak = approachParam(eased.speak, live.presence ? clock.speak : (live.alive ? 1 : 0), dt, tau);
        eased.think = approachParam(eased.think, clock.think, dt, tau);
      }
      const pose = composeStewardPose(species, {
        ...clock,
        up: eased.up,
        down: eased.down,
        listen: eased.listen,
        surprise: eased.surprise,
        speak: live.reducedMotion || live.presence ? eased.speak : clock.speak * eased.speak,
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
    if (liveRef.current.reducedMotion || liveRef.current.preview) return;

    const tick = (now: number) => {
      paint(now);
      if (liveRef.current.reducedMotion || liveRef.current.preview) return;
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [kind, preview, reducedMotion]);

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
