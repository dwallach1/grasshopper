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
      <ellipse className={styles.ground} cx="32" cy="59" rx={kind === 'quantanamo' ? 18 : 13.5} ry="2.2" />
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
        <rect className={styles.skin} x="16" y="10" width="32" height="42" rx="12" />
      ) : kind === 'quantanamo' ? (
        <ellipse className={styles.skin} cx="32" cy="33" rx="24" ry="17.5" />
      ) : (
        <ellipse className={styles.skin} cx="32" cy="34" rx="19.5" ry="18.5" />
      )}
      <ellipse
        className={styles.shine}
        cx={kind === 'grasshopper' ? 26 : 24}
        cy={kind === 'grasshopper' ? 20 : 23}
        rx={kind === 'grasshopper' ? 8 : 9}
        ry={kind === 'grasshopper' ? 4.5 : 5.5}
      />
    </g>
  );
}

function BotAccessory({ kind }: { kind: StewardBotKind }) {
  if (kind === 'quantanamo') {
    return (
      <ellipse className={styles.baseShadow} cx="32" cy="47.5" rx="17" ry="5" data-accessory="base-shadow" />
    );
  }
  if (kind === 'oddsborne') {
    return (
      <g className={styles.pin} data-accessory="hat-pin">
        <path className={styles.pinStem} d="M44.2 18.4 L40.6 22.2" />
        <circle className={styles.pinDish} cx="46" cy="16.2" r="4.1" />
        <circle className={styles.pinWell} cx="46" cy="16.2" r="1.8" />
      </g>
    );
  }
  if (kind === 'bandit') {
    return (
      <rect
        className={styles.mask}
        x="11"
        y="25"
        width="42"
        height="15"
        rx="7.5"
        transform="rotate(-9 32 32.5)"
        data-accessory="mask-slash"
      />
    );
  }
  if (kind === 'grasshopper') {
    return <circle className={styles.tabletNotch} cx="32" cy="14.4" r="1.35" data-accessory="tablet-bar" />;
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
    return { left: 24.2, right: 39.8, cy: 28.5, rx: 8, ry: 8.8 };
  }
  if (kind === 'quantanamo') {
    return { left: 22, right: 42, cy: 30.5, rx: 8.2, ry: 9 };
  }
  if (kind === 'bandit') {
    return { left: 23.4, right: 40.6, cy: 32, rx: 7.6, ry: 8.2 };
  }
  return { left: 23.6, right: 40.4, cy: 31.5, rx: 8, ry: 8.6 };
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
        <circle className={styles.iris} cy={1.15} r={rx * 0.56} />
        <circle className={styles.pupil} cy={1.35} r={rx * 0.36} />
        <circle className={styles.glint} cx={-rx * 0.22} cy={-ry * 0.16} r={rx * 0.15} />
      </g>
      <rect className={styles.lid} x={-rx} y={-ry} width={rx * 2} height={ry * 2} rx={rx * 0.55} />
    </g>
  );
}
