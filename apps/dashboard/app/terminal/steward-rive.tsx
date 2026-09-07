'use client';

import { useEffect, useRef } from 'react';
import { RuntimeLoader } from '@rive-app/react-canvas';

import type { StewardBotKind, StewardMood } from '../../lib/desk-avatar';
import {
  RIVE_WASM_SRC,
  stewardRiveArtboard,
  stewardRivePlay,
  stewardRiveSrc,
} from '../../lib/steward-rive';
import styles from './steward-avatar.module.css';

RuntimeLoader.setWasmUrl(RIVE_WASM_SRC);
RuntimeLoader.setWasmFallbackUrl(null);

type RivBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type RivRenderer = {
  save(): void;
  restore(): void;
  clear(): void;
  align(fit: number, alignment: { x: number; y: number }, frame: RivBounds, content: RivBounds): void;
};

type RivArtboard = {
  delete(): void;
  advance(sec: number): boolean;
  draw(target: RivRenderer): void;
  bounds: RivBounds;
  animationCount(): number;
  animationByIndex(index: number): object;
};

type RivClip = {
  delete(): void;
  advance(sec: number): boolean;
  apply(mix: number): void;
};

const rivBuffers = new Map<string, Promise<ArrayBuffer>>();
const rivFiles = new Map<
  string,
  Promise<{
    runtime: Awaited<ReturnType<typeof RuntimeLoader.awaitInstance>>;
    file: Awaited<ReturnType<Awaited<ReturnType<typeof RuntimeLoader.awaitInstance>>['load']>>;
  }>
>();

function loadStewardRivBuffer(src: string): Promise<ArrayBuffer> {
  const cached = rivBuffers.get(src);
  if (cached) return cached;
  const pending = fetch(src).then((response) => {
    if (!response.ok) throw new Error(`steward riv ${response.status}`);
    return response.arrayBuffer();
  });
  rivBuffers.set(src, pending);
  return pending;
}

function loadRuntimeFile(src: string, buffer: ArrayBuffer) {
  const cached = rivFiles.get(src);
  if (cached) return cached;
  const pending = RuntimeLoader.awaitInstance().then(async (runtime) => {
    const file = await runtime.load(new Uint8Array(buffer));
    return { runtime, file };
  });
  rivFiles.set(src, pending);
  return pending;
}

export function StewardRiveFace({
  kind,
  mood,
  alive,
  reducedMotion,
  delayMs,
  onReady,
  onFailed,
}: {
  kind: StewardBotKind;
  mood: StewardMood;
  alive: boolean;
  reducedMotion: boolean;
  delayMs: number;
  onReady: () => void;
  onFailed: () => void;
}) {
  const play = stewardRivePlay(mood, alive, reducedMotion);
  const artboardName = stewardRiveArtboard(kind, play);
  const src = stewardRiveSrc(kind, play);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let frame = 0;
    let artboard: RivArtboard | null = null;
    let clip: RivClip | null = null;
    let renderer: RivRenderer | null = null;

    void loadStewardRivBuffer(src)
      .then((buffer) => loadRuntimeFile(src, buffer))
      .then(({ runtime, file }) => {
        if (cancelled || !canvas.isConnected) return;
        const nextArtboard = file.artboardByName(artboardName);
        if (!nextArtboard || nextArtboard.animationCount() < 1) {
          throw new Error(`missing artboard ${artboardName}`);
        }
        const nextClip = new runtime.LinearAnimationInstance(nextArtboard.animationByIndex(0), nextArtboard);
        nextClip.advance(delayMs / 1000);
        nextClip.apply(1);
        nextArtboard.advance(0);
        const nextRenderer = runtime.makeRenderer(canvas, true);
        artboard = nextArtboard;
        clip = nextClip;
        // SAFETY: makeRenderer returns the official canvas renderer with align/clear/draw.
        renderer = nextRenderer;

        const draw = (elapsed: number) => {
          if (cancelled || !artboard || !clip || !renderer) return;
          const ratio = window.devicePixelRatio || 1;
          const cssW = canvas.clientWidth || 64;
          const cssH = canvas.clientHeight || 64;
          const pixelW = Math.max(1, Math.round(cssW * ratio));
          const pixelH = Math.max(1, Math.round(cssH * ratio));
          if (canvas.width !== pixelW || canvas.height !== pixelH) {
            canvas.width = pixelW;
            canvas.height = pixelH;
          }
          if (!reducedMotion) {
            clip.advance(elapsed);
            clip.apply(1);
          }
          artboard.advance(elapsed);
          renderer.clear();
          renderer.save();
          renderer.align(
            runtime.Fit.contain,
            runtime.Alignment.center,
            { minX: 0, minY: 0, maxX: pixelW, maxY: pixelH },
            artboard.bounds,
          );
          artboard.draw(nextRenderer);
          renderer.restore();
        };

        let last = performance.now();
        const tick = (now: number) => {
          const elapsed = Math.min(0.05, (now - last) / 1000);
          last = now;
          draw(elapsed);
          frame = runtime.requestAnimationFrame(tick);
        };
        draw(0);
        frame = runtime.requestAnimationFrame(tick);
        onReady();
      })
      .catch(() => {
        if (!cancelled) onFailed();
      });

    return () => {
      cancelled = true;
      void RuntimeLoader.awaitInstance().then((runtime) => {
        runtime.cancelAnimationFrame(frame);
      });
      clip?.delete();
      artboard?.delete();
    };
  }, [artboardName, delayMs, onFailed, onReady, reducedMotion, src]);

  return (
    <span className={styles.stage} data-runtime="rive" data-artboard={artboardName} data-play={play} data-riv={src}>
      <canvas ref={canvasRef} className={styles.riv} aria-hidden="true" />
    </span>
  );
}
