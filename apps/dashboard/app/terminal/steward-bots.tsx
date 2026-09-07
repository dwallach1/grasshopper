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
        <filter id={feltId} x="-16%" y="-16%" width="132%" height="132%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.78"
            numOctaves="2"
            seed={tone.seed}
            result="n"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="n"
            scale="1.3"
            xChannelSelector="R"
            yChannelSelector="G"
            result="fuzz"
          />
          <feGaussianBlur in="fuzz" stdDeviation="0.22" />
        </filter>
        <filter id={napId} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="1.12"
            numOctaves="2"
            seed={tone.seed + 4}
            result="n"
          />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.96  0 0 0 0 0.96  0 0 0 0 0.98  0 0 0 0.2 0"
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
    return 'M 4.8 51.2 C 4.2 43 8.4 27.5 16.6 19.2 C 22.4 13.4 28.2 12 33.2 12.4 C 43.2 13.2 53.2 20.6 57.8 33.4 C 60.8 42.2 59.2 51.2 53.8 55.6 C 47.2 60.2 38.2 60.8 32 60.8 C 21.6 60.8 8.8 58.6 4.8 51.2 Z';
  }
  if (kind === 'oddsborne') {
    return 'M 12.2 52.8 C 10.6 41.4 14.4 21.2 23.6 10.6 C 27.4 6.2 32.2 4.4 36.8 7.6 C 43.8 13 51.2 25.6 53.6 39.6 C 55.4 48.8 52.8 55.8 44.8 58.4 C 37.6 60.6 24.2 60.6 16.4 56.8 C 13.2 55.2 12.2 54 12.2 52.8 Z';
  }
  if (kind === 'bandit') {
    return 'M 9.2 51.6 C 8 40.4 12.4 23.8 21.4 16 C 27.2 11.2 34.2 11.6 41.2 16.4 C 50.2 23.2 56.8 33.8 58.6 43.6 C 60 51 55.2 57 44.6 58.8 C 34.2 60.6 18.2 59.8 11.2 54.8 C 9.4 53.4 9.2 52.4 9.2 51.6 Z';
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
