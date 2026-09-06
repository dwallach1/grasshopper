'use client';

import { useId } from 'react';

import type { StewardBotKind } from '../../lib/desk-avatar';
import styles from './steward-avatar.module.css';

/**
 * One Grok Bot family: a soft colored pebble, two big eyes, one accessory.
 * No treads, arms, rivets, or chassis. Distinction is accent + a hat-pin /
 * mask slash / base shadow / tablet silhouette.
 */
export function StewardBot({ kind }: { kind: StewardBotKind }) {
  return (
    <svg className={styles.bot} viewBox="0 0 64 64" fill="none" aria-hidden="true" data-kind={kind}>
      <ellipse className={styles.ground} cx="32" cy="58.5" rx={kind === 'quantanamo' ? 17 : 14} ry="2.4" />
      <g className={styles.figure}>
        <BotBody kind={kind} />
        <BotAccessory kind={kind} />
        <BotFace kind={kind} />
      </g>
    </svg>
  );
}

function BotBody({ kind }: { kind: StewardBotKind }) {
  return (
    <g className={styles.body} data-part="body">
      {kind === 'grasshopper' ? (
        <rect className={styles.skin} x="15" y="11" width="34" height="42" rx="13" />
      ) : kind === 'quantanamo' ? (
        <ellipse className={styles.skin} cx="32" cy="34" rx="23" ry="18.5" />
      ) : (
        <ellipse className={styles.skin} cx="32" cy="34.5" rx="20" ry="19" />
      )}
      <ellipse
        className={styles.shine}
        cx={kind === 'grasshopper' ? 26 : 25}
        cy={kind === 'grasshopper' ? 22 : 24}
        rx={kind === 'grasshopper' ? 9 : 10}
        ry={kind === 'grasshopper' ? 5 : 6.5}
      />
    </g>
  );
}

function BotAccessory({ kind }: { kind: StewardBotKind }) {
  if (kind === 'quantanamo') {
    return (
      <ellipse className={styles.baseShadow} cx="32" cy="49.5" rx="16" ry="4.2" data-accessory="base-shadow" />
    );
  }
  if (kind === 'oddsborne') {
    return (
      <g className={styles.pin} data-accessory="hat-pin">
        <path className={styles.pinStem} d="M43.2 16.5 L45.6 10.2" />
        <circle className={styles.pinDish} cx="46.4" cy="8.4" r="3.6" />
        <circle className={styles.pinWell} cx="46.4" cy="8.4" r="1.7" />
      </g>
    );
  }
  if (kind === 'bandit') {
    return (
      <rect
        className={styles.mask}
        x="12"
        y="26.5"
        width="40"
        height="13"
        rx="6.5"
        transform="rotate(-8 32 33)"
        data-accessory="mask-slash"
      />
    );
  }
  if (kind === 'grasshopper') {
    return <rect className={styles.tabletBar} x="27" y="47.2" width="10" height="2.2" rx="1.1" data-accessory="tablet-bar" />;
  }
  return null;
}

function BotFace({ kind }: { kind: StewardBotKind }) {
  const layout = faceLayout(kind);
  return (
    <g className={styles.face}>
      <BotEye side="l" cx={layout.left} cy={layout.cy} rx={layout.rx} ry={layout.ry} />
      <BotEye side="r" cx={layout.right} cy={layout.cy} rx={layout.rx} ry={layout.ry} />
    </g>
  );
}

function faceLayout(kind: StewardBotKind) {
  if (kind === 'grasshopper') {
    return { left: 24, right: 40, cy: 29, rx: 7.4, ry: 8.2 };
  }
  if (kind === 'quantanamo') {
    return { left: 22.5, right: 41.5, cy: 31.5, rx: 7.6, ry: 8.4 };
  }
  if (kind === 'bandit') {
    return { left: 23.5, right: 40.5, cy: 32.2, rx: 7.2, ry: 7.8 };
  }
  return { left: 23.5, right: 40.5, cy: 32, rx: 7.4, ry: 8.1 };
}

function BotEye({
  side,
  cx,
  cy,
  rx,
  ry,
}: {
  side: 'l' | 'r';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}) {
  const reactId = useId().replace(/:/g, '');
  const clip = `steward-eye-${reactId}-${side}`;
  return (
    <g className={styles.eye} transform={`translate(${cx} ${cy})`} data-part="eye">
      <ellipse className={styles.lens} rx={rx} ry={ry} />
      <clipPath id={clip}>
        <ellipse rx={rx} ry={ry} />
      </clipPath>
      <g className={styles.gaze} clipPath={`url(#${clip})`}>
        <circle className={styles.iris} cy={1.1} r={rx * 0.58} />
        <circle className={styles.pupil} cy={1.3} r={rx * 0.38} />
        <circle className={styles.glint} cx={-rx * 0.22} cy={-ry * 0.18} r={rx * 0.16} />
      </g>
      <rect className={styles.lid} x={-rx} y={-ry} width={rx * 2} height={ry * 2} rx={rx * 0.55} />
    </g>
  );
}
