'use client';

import { useId } from 'react';

import type { StewardBotKind } from '../../lib/desk-avatar';
import styles from './steward-avatar.module.css';

/**
 * One capsule family: a soft bean, oversized goggles, one tiny accessory.
 * Original desk characters — not industrial pebbles, not a licensed mascot.
 */
export function StewardBot({ kind }: { kind: StewardBotKind }) {
  return (
    <svg className={styles.bot} viewBox="0 0 64 64" fill="none" aria-hidden="true" data-kind={kind}>
      <ellipse className={styles.ground} cx="32" cy="59.4" rx={kind === 'quantanamo' ? 20 : 14} ry="2.1" />
      <g className={styles.figure}>
        <BotBody kind={kind} />
        {kind === 'quantanamo' ? <BotAccessory kind={kind} /> : null}
        <BotStrap kind={kind} />
        <BotFace kind={kind} />
        <BotMouth kind={kind} />
        {kind === 'quantanamo' ? null : <BotAccessory kind={kind} />}
      </g>
    </svg>
  );
}

function BotBody({ kind }: { kind: StewardBotKind }) {
  return (
    <g className={styles.body} data-part="body">
      {kind === 'grasshopper' ? (
        <rect className={styles.skin} x="17.5" y="5.5" width="29" height="50.5" rx="14.5" />
      ) : kind === 'quantanamo' ? (
        <ellipse className={styles.skin} cx="32" cy="33.5" rx="24.5" ry="18.2" />
      ) : kind === 'spark' ? (
        <ellipse className={styles.skin} cx="32" cy="33.8" rx="18.2" ry="17.6" />
      ) : (
        <rect className={styles.skin} x="15.5" y="8" width="33" height="47" rx="16.5" />
      )}
      <ellipse
        className={styles.belly}
        cx="32"
        cy={kind === 'grasshopper' ? 43 : 42}
        rx={kind === 'quantanamo' ? 13 : 10}
        ry={kind === 'quantanamo' ? 7.5 : 8.2}
      />
      <ellipse
        className={styles.shine}
        cx={kind === 'quantanamo' ? 23 : 25}
        cy={kind === 'grasshopper' ? 15 : 18}
        rx={kind === 'quantanamo' ? 9 : 7.5}
        ry={kind === 'grasshopper' ? 4.2 : 5}
      />
    </g>
  );
}

function BotStrap({ kind }: { kind: StewardBotKind }) {
  if (kind === 'quantanamo') {
    return <rect className={styles.strap} x="8.2" y="23.6" width="47.6" height="8.2" rx="4.1" />;
  }
  if (kind === 'grasshopper') {
    return <rect className={styles.strap} x="17.5" y="21.4" width="29" height="7.4" rx="3.6" />;
  }
  if (kind === 'spark') {
    return <rect className={styles.strap} x="14.4" y="24.2" width="35.2" height="7.2" rx="3.6" />;
  }
  return (
    <rect
      className={kind === 'bandit' ? styles.maskStrap : styles.strap}
      x="15.5"
      y="22.8"
      width="33"
      height={kind === 'bandit' ? 8.4 : 7.4}
      rx="3.8"
    />
  );
}

function BotAccessory({ kind }: { kind: StewardBotKind }) {
  if (kind === 'quantanamo') {
    return (
      <ellipse className={styles.baseShadow} cx="32" cy="48.6" rx="17.5" ry="4.6" data-accessory="base-shadow" />
    );
  }
  if (kind === 'oddsborne') {
    return (
      <g className={styles.pin} data-accessory="hat-pin">
        <path className={styles.pinStem} d="M44.4 16.8 L41.2 20.4" />
        <circle className={styles.pinDish} cx="46.2" cy="14.8" r="4.2" />
        <circle className={styles.pinWell} cx="46.2" cy="14.8" r="1.7" />
      </g>
    );
  }
  if (kind === 'bandit') {
    return (
      <g data-accessory="mask-slash">
        <ellipse className={styles.mask} cx="13.6" cy="27.2" rx="5.4" ry="7.2" />
        <ellipse className={styles.mask} cx="50.4" cy="26.6" rx="5.4" ry="7.2" />
        <rect
          className={styles.maskSlash}
          x="17"
          y="25.4"
          width="30"
          height="3.6"
          rx="1.8"
          transform="rotate(-8 32 27.2)"
        />
      </g>
    );
  }
  if (kind === 'grasshopper') {
    return (
      <g data-accessory="tablet-bar">
        <path className={styles.nubStem} d="M26.2 8.2 L24.4 2.6" />
        <path className={styles.nubStem} d="M37.8 8.2 L39.6 2.6" />
        <circle className={styles.nub} cx="23.8" cy="2.2" r="1.55" />
        <circle className={styles.nub} cx="40.2" cy="2.2" r="1.55" />
      </g>
    );
  }
  return null;
}

function BotFace({ kind }: { kind: StewardBotKind }) {
  const layout = faceLayout(kind);
  return (
    <g className={styles.face}>
      <path
        className={styles.bridge}
        d={`M${layout.left + layout.rx - 1.2} ${layout.cy - 1.1} H${layout.right - layout.rx + 1.2}`}
        data-part="goggle"
      />
      <BotEye side="l" cx={layout.left} cy={layout.cy} rx={layout.rx} ry={layout.ry} />
      <BotEye side="r" cx={layout.right} cy={layout.cy} rx={layout.rx} ry={layout.ry} />
    </g>
  );
}

function BotMouth({ kind }: { kind: StewardBotKind }) {
  const y = kind === 'grasshopper' ? 42.4 : kind === 'quantanamo' ? 41.6 : 43.2;
  return (
    <path
      className={styles.mouth}
      d={`M27.2 ${y} Q32 ${y + 3.4} 36.8 ${y}`}
    />
  );
}

function faceLayout(kind: StewardBotKind) {
  if (kind === 'grasshopper') {
    return { left: 24.4, right: 39.6, cy: 25.2, rx: 8.4, ry: 8.8 };
  }
  if (kind === 'quantanamo') {
    return { left: 21.6, right: 42.4, cy: 27.8, rx: 9.1, ry: 9.4 };
  }
  if (kind === 'bandit') {
    return { left: 23.6, right: 40.4, cy: 26.8, rx: 8.1, ry: 8.5 };
  }
  if (kind === 'spark') {
    return { left: 24.2, right: 39.8, cy: 27.8, rx: 7.8, ry: 8.2 };
  }
  return { left: 23.8, right: 40.2, cy: 26.6, rx: 8.2, ry: 8.6 };
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
  const rim = Math.max(rx, ry) + 2.15;
  return (
    <g className={styles.eye} transform={`translate(${cx} ${cy})`} data-part="eye">
      <circle className={styles.rim} r={rim} />
      <ellipse className={styles.lens} rx={rx} ry={ry} />
      <clipPath id={clip}>
        <ellipse rx={rx} ry={ry} />
      </clipPath>
      <g className={styles.gaze} clipPath={`url(#${clip})`}>
        <circle className={styles.iris} cy={1.2} r={rx * 0.58} />
        <circle className={styles.pupil} cy={1.4} r={rx * 0.34} />
        <circle className={styles.glint} cx={-rx * 0.24} cy={-ry * 0.2} r={rx * 0.16} />
      </g>
      <rect className={styles.lid} x={-rx} y={-ry} width={rx * 2} height={ry * 2} rx={rx * 0.55} />
    </g>
  );
}
