'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alignment,
  Fit,
  Layout,
  RuntimeLoader,
  useRive,
} from '@rive-app/react-canvas';

import type { StewardBotKind, StewardMood } from '../../lib/desk-avatar';
import {
  RIVE_WASM_SRC,
  STEWARD_RIV_SRC,
  stewardRiveArtboard,
  stewardRivePlay,
} from '../../lib/steward-rive';
import styles from './steward-avatar.module.css';

RuntimeLoader.setWasmUrl(RIVE_WASM_SRC);
RuntimeLoader.setWasmFallbackUrl(null);

let rivBuffer: Promise<ArrayBuffer> | null = null;
let rivBytes: ArrayBuffer | null = null;

function loadStewardRivBuffer(): Promise<ArrayBuffer> {
  rivBuffer ??= fetch(STEWARD_RIV_SRC).then((response) => {
    if (!response.ok) throw new Error(`steward riv ${response.status}`);
    return response.arrayBuffer();
  }).then((bytes) => {
    rivBytes = bytes;
    return bytes;
  });
  return rivBuffer;
}

const FIT = new Layout({ fit: Fit.Contain, alignment: Alignment.Center });

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
  const artboard = stewardRiveArtboard(kind, play);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(rivBytes);

  useEffect(() => {
    let cancelled = false;
    void loadStewardRivBuffer()
      .then((bytes) => {
        if (!cancelled) setBuffer(bytes);
      })
      .catch(() => {
        if (!cancelled) onFailed();
      });
    return () => {
      cancelled = true;
    };
  }, [onFailed]);

  const riveParams = useMemo(
    () =>
      buffer
        ? {
            buffer,
            artboard,
            autoplay: !reducedMotion,
            layout: FIT,
            shouldDisableRiveListeners: true,
            onLoadError: () => onFailed(),
          }
        : null,
    [artboard, buffer, onFailed, reducedMotion],
  );

  const { rive, RiveComponent } = useRive(riveParams);

  useEffect(() => {
    if (!rive) return;
    rive.resizeDrawingSurfaceToCanvas();
    if (!reducedMotion) {
      rive.play();
      if (delayMs) rive.scrub(rive.animationNames, delayMs / 1000);
    }
    onReady();
  }, [delayMs, onReady, reducedMotion, rive]);

  if (!buffer) return <span className={styles.stage} data-runtime="rive-pending" />;

  return (
    <span className={styles.stage} data-runtime="rive" data-artboard={artboard} data-play={play}>
      <RiveComponent className={styles.riv} />
    </span>
  );
}
