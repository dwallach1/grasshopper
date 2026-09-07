'use client';

import { useId } from 'react';

import {
  stewardFaceLayout,
  stewardFurTone,
  type StewardBotKind,
} from '../../lib/desk-avatar';
import styles from './steward-avatar.module.css';

/**
 * One fluff family: a wool-felt mound, sleepy half-lids, no limbs or mouth.
 * Original desk characters — not Oobi, not a goggle capsule, not a licensed mascot.
 */
export function StewardBot({ kind }: { kind: StewardBotKind }) {
  const reactId = useId().replace(/:/g, '');
  const tone = stewardFurTone(kind);
  const mound = moundPath(kind);
  const feltId = `steward-felt-${reactId}`;
  const napId = `steward-nap-${reactId}`;
  const hazeId = `steward-haze-${reactId}`;
  const volumeId = `steward-volume-${reactId}`;

  return (
    <svg className={styles.bot} viewBox="0 0 64 64" fill="none" aria-hidden="true" data-kind={kind}>
      <defs>
        <radialGradient id={volumeId} cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="var(--fur-lit)" />
          <stop offset="48%" stopColor="var(--fur)" />
          <stop offset="100%" stopColor="var(--fur-deep)" />
        </radialGradient>
        <filter id={feltId} x="-18%" y="-18%" width="136%" height="136%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.46"
            numOctaves="3"
            seed={tone.seed}
            result="n"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="n"
            scale="2.05"
            xChannelSelector="R"
            yChannelSelector="G"
            result="fuzz"
          />
          <feGaussianBlur in="fuzz" stdDeviation="0.18" />
        </filter>
        <filter id={napId} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.62"
            numOctaves="2"
            seed={tone.seed + 4}
            result="n"
          />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.93  0 0 0 0 0.93  0 0 0 0 0.96  0 0 0 0.38 0"
            result="grain"
          />
          <feComposite in="grain" in2="SourceGraphic" operator="in" />
        </filter>
        <filter id={hazeId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.15" />
        </filter>
      </defs>
      <ellipse className={styles.ground} cx="32" cy="60.2" rx={kind === 'quantanamo' ? 22 : kind === 'oddsborne' ? 15 : 17} ry="2" />
      <g className={styles.figure}>
        <BotBody kind={kind} d={mound} feltId={feltId} napId={napId} hazeId={hazeId} volumeId={volumeId} />
        <BotFace kind={kind} />
      </g>
    </svg>
  );
}

function BotBody({
  kind,
  d,
  feltId,
  napId,
  hazeId,
  volumeId,
}: {
  kind: StewardBotKind;
  d: string;
  feltId: string;
  napId: string;
  hazeId: string;
  volumeId: string;
}) {
  const shine = shineSpec(kind);
  return (
    <g className={styles.body} data-part="body">
      <path className={styles.halo} d={d} filter={`url(#${hazeId})`} />
      <path
        className={styles.skin}
        d={d}
        fill={`url(#${volumeId})`}
        filter={`url(#${feltId})`}
        data-part="mound"
      />
      <path className={styles.fur} d={d} filter={`url(#${napId})`} />
      <ellipse className={styles.shade} cx="34" cy="50" rx={kind === 'quantanamo' ? 16 : 12} ry="6.2" />
      <ellipse className={styles.shine} cx={shine.cx} cy={shine.cy} rx={shine.rx} ry={shine.ry} />
    </g>
  );
}

function BotFace({ kind }: { kind: StewardBotKind }) {
  const layout = stewardFaceLayout(kind);
  return (
    <g className={styles.face}>
      <BotEye
        side="l"
        cx={layout.left}
        cy={layout.cy}
        r={layout.r}
        tilt={layout.lidTiltL}
        cover={layout.lidCover}
      />
      <BotEye
        side="r"
        cx={layout.right}
        cy={layout.cy}
        r={layout.r}
        tilt={layout.lidTiltR}
        cover={layout.lidCover}
      />
    </g>
  );
}

function BotEye({
  side,
  cx,
  cy,
  r,
  tilt,
  cover,
}: {
  side: 'l' | 'r';
  cx: number;
  cy: number;
  r: number;
  tilt: number;
  cover: number;
}) {
  const reactId = useId().replace(/:/g, '');
  const clip = `steward-eye-${reactId}-${side}`;
  const lidY = -r + r * 2 * cover;
  return (
    <g className={styles.eye} transform={`translate(${cx} ${cy})`} data-part="eye">
      <circle className={styles.lens} r={r} />
      <clipPath id={clip}>
        <circle r={r} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <g className={styles.gaze}>
          <circle className={styles.pupil} cy={r * 0.22} r={r * 0.34} />
          <circle className={styles.glint} cx={-r * 0.16} cy={r * 0.02} r={r * 0.09} />
        </g>
        <g transform={`rotate(${tilt})`}>
          <path
            className={styles.lidRest}
            d={`M ${-r} ${-r} H ${r} V ${lidY} Q 0 ${lidY + r * 0.14} ${-r} ${lidY} Z`}
            data-part="lid"
          />
          <path className={styles.lidEdge} d={`M ${-r * 0.9} ${lidY} Q 0 ${lidY + r * 0.12} ${r * 0.9} ${lidY}`} />
        </g>
        <rect
          className={styles.lid}
          x={-r}
          y={-r}
          width={r * 2}
          height={r * 2}
          rx={r * 0.55}
        />
      </g>
    </g>
  );
}

function moundPath(kind: StewardBotKind): string {
  if (kind === 'quantanamo') {
    return 'M 3.6 50.4 C 2.8 41.2 7.2 26 14.4 18.4 C 18.6 13.6 24.8 14.8 28.4 17.6 C 32.2 12.2 38.6 11 44.8 16.2 C 52.8 23.2 58.8 34.6 59.4 45.2 C 59.8 52.6 53.6 58.4 42.8 60.2 C 32.4 61.6 12.8 59.8 3.6 50.4 Z';
  }
  if (kind === 'oddsborne') {
    return 'M 13.4 53.2 C 11.2 42 15.6 20.4 26.2 8.6 C 29.6 4.4 33.8 2.8 36.4 6.2 C 38.2 8.6 37.6 11.4 40.8 13.6 C 47.8 19.2 52.8 31.2 54.2 42.6 C 55.2 51.2 51.4 57.8 42.6 59.4 C 34.8 60.8 22.6 60.4 16.2 56.6 C 14 55.2 13.4 54.2 13.4 53.2 Z';
  }
  if (kind === 'bandit') {
    return 'M 10.2 53 C 9 41.2 14.2 22.6 24.4 14.4 C 30.2 9.4 36.6 10.2 40.4 15.2 C 44.2 20.2 45.4 28.4 53.6 36.2 C 59.4 42.2 59.8 51.6 50.6 57.2 C 41.2 61.4 22.4 60.6 13.4 56.2 C 11 54.8 10.2 53.8 10.2 53 Z';
  }
  if (kind === 'grasshopper') {
    return 'M 7.2 53 C 6.2 43.6 10.4 25.8 20.2 18.2 C 26.2 14.2 38.2 14.2 44.2 18.2 C 54 25.8 57.8 43.6 56.8 53 C 55.8 58.8 43.8 60.6 32 60.6 C 20.2 60.6 8.2 58.8 7.2 53 Z';
  }
  return 'M 13.2 51.8 C 12.2 41.6 16.4 25.8 25.8 18.2 C 30.2 15 36.4 15 40.4 18.8 C 48.2 26 51.8 39.8 50.8 50.8 C 50 56.8 40.2 59.4 32 59.4 C 22.4 59.4 14.2 56.6 13.2 51.8 Z';
}

function shineSpec(kind: StewardBotKind) {
  if (kind === 'quantanamo') return { cx: 22, cy: 22, rx: 10, ry: 5.4 };
  if (kind === 'oddsborne') return { cx: 26, cy: 16, rx: 7.2, ry: 4.2 };
  if (kind === 'bandit') return { cx: 24, cy: 20, rx: 8.2, ry: 4.6 };
  if (kind === 'grasshopper') return { cx: 23, cy: 22, rx: 9.2, ry: 4.8 };
  return { cx: 25, cy: 22, rx: 7.6, ry: 4.4 };
}
