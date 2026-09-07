'use client';

import { useId } from 'react';

import {
  stewardFaceLayout,
  stewardFurTone,
  stewardSilhouette,
  type StewardBotKind,
  type StewardMood,
} from '../../lib/desk-avatar';
import styles from './steward-avatar.module.css';

/**
 * Flat vector fluff family: sleepy mound, half-lids, no limbs or mouth.
 * SVG artboard with padding — not WebGL, not a bitmap, not a licensed mascot.
 */
export function StewardBot({
  kind,
  alive = false,
  delayMs = 0,
  mood = 'idle',
}: {
  kind: StewardBotKind;
  alive?: boolean;
  delayMs?: number;
  mood?: StewardMood;
}) {
  const uid = useId().replace(/:/g, '');
  const fur = stewardFurTone(kind);
  const face = stewardFaceLayout(kind);
  const body = stewardSilhouette(kind);
  const fillId = `fur-${kind}-${uid}`;

  return (
    <svg
      className={styles.bot}
      viewBox="0 0 80 80"
      overflow="visible"
      data-kind={kind}
      data-part="body"
      data-runtime="svg"
      data-mood={mood}
      data-alive={alive ? '1' : '0'}
      data-artboard="padded"
      data-eye="vector"
      data-lid-runtime="vector"
      data-mound="path"
      aria-hidden="true"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <defs>
        <linearGradient id={fillId} x1="22" y1="12" x2="48" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={fur.base} />
          <stop offset="1" stopColor={fur.deep} />
        </linearGradient>
      </defs>
      <rect
        className={styles.pad}
        x="3"
        y="3"
        width="74"
        height="74"
        rx="20"
        fill={fur.pad}
      />
      <g className={styles.figure} style={{ animationDelay: `${delayMs}ms` }}>
        <g transform="translate(8 7)">
          <ellipse className={styles.shadow} cx="32" cy="61.4" rx={kind === 'quantanamo' ? 20 : kind === 'oddsborne' ? 13 : 16} ry="2.2" />
          <path className={styles.body} d={body.path} fill={`url(#${fillId})`} />
          <StewardEye
            side="left"
            cx={face.left}
            cy={face.cy}
            r={face.r}
            tilt={face.lidTiltL}
            cover={face.lidCover}
            fur={fur.base}
            delayMs={delayMs}
          />
          <StewardEye
            side="right"
            cx={face.right}
            cy={face.cy}
            r={face.r}
            tilt={face.lidTiltR}
            cover={face.lidCover}
            fur={fur.base}
            delayMs={delayMs}
          />
        </g>
      </g>
    </svg>
  );
}

function StewardEye({
  side,
  cx,
  cy,
  r,
  tilt,
  cover,
  fur,
  delayMs,
}: {
  side: 'left' | 'right';
  cx: number;
  cy: number;
  r: number;
  tilt: number;
  cover: number;
  fur: string;
  delayMs: number;
}) {
  const lidH = r * 2 * cover;
  return (
    <g data-eye={side} transform={`translate(${cx} ${cy}) rotate(${tilt})`}>
      <ellipse className={styles.sclera} rx={r} ry={r * 0.94} />
      <circle
        className={styles.pupil}
        data-part="pupil"
        r={r * 0.28}
        cy={r * 0.16}
        style={{ animationDelay: `${delayMs}ms` }}
      />
      <rect
        className={styles.lid}
        data-lid={side}
        x={-r - 0.35}
        y={-r - 0.35}
        width={r * 2 + 0.7}
        height={lidH + 0.45}
        rx={r * 0.42}
        fill={fur}
        style={{ animationDelay: `${delayMs}ms` }}
      />
    </g>
  );
}
