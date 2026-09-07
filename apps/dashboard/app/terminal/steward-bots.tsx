'use client';

import { useEffect, useRef } from 'react';

import type { StewardBotKind } from '../../lib/desk-avatar';
import { attachStewardCanvas } from './steward-gl';
import styles from './steward-avatar.module.css';

/**
 * GPU fluff family: wool-felt mound, sleepy half-lids, no limbs or mouth.
 * Shared WebGL runtime — not SVG noise, not a bitmap, not a licensed mascot.
 */
export function StewardBot({
  kind,
  alive = false,
  delayMs = 0,
}: {
  kind: StewardBotKind;
  alive?: boolean;
  delayMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return attachStewardCanvas(canvas, kind, alive, delayMs);
  }, [kind, alive, delayMs]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.bot}
      data-kind={kind}
      data-part="body"
      data-runtime="three"
      data-eye="shader"
      data-lid="shader"
      data-mound="mesh"
      aria-hidden="true"
    />
  );
}
