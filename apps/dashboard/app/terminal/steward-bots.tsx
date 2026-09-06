import styles from './steward-avatar.module.css';
import type { StewardBotKind } from '../../lib/desk-avatar';

export function StewardBot({ slug, kind }: { slug: string; kind: StewardBotKind }) {
  switch (kind) {
    case 'quantanamo':
      return <QuantanamoBot slug={slug} />;
    case 'oddsborne':
      return <OddsborneBot slug={slug} />;
    case 'bandit':
      return <BanditBot slug={slug} />;
    case 'grasshopper':
      return <GrasshopperBot slug={slug} />;
    default:
      return <SparkBot slug={slug} />;
  }
}

function QuantanamoBot({ slug }: { slug: string }) {
  return (
    <svg className={styles.bot} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <ellipse className={styles.shadow} cx="32" cy="58" rx="18" ry="3" />
      <rect className={styles.tread} x="10" y="49" width="44" height="9" rx="3.5" />
      <circle className={styles.treadTooth} cx="16" cy="53.5" r="2.4" />
      <circle className={styles.treadTooth} cx="24" cy="53.5" r="2.4" />
      <circle className={styles.treadTooth} cx="32" cy="53.5" r="2.4" />
      <circle className={styles.treadTooth} cx="40" cy="53.5" r="2.4" />
      <circle className={styles.treadTooth} cx="48" cy="53.5" r="2.4" />
      <g className={styles.body}>
        <rect className={styles.shell} x="15" y="29" width="34" height="22" rx="4" />
        <rect className={styles.highlight} x="17" y="31" width="30" height="6" rx="2" />
        <rect className={styles.panel} x="19" y="38" width="26" height="8" rx="2" />
        <circle className={styles.rivet} cx="21" cy="33.5" r="1" />
        <circle className={styles.rivet} cx="43" cy="33.5" r="1" />
        <rect className={styles.accent} x="22" y="40" width="20" height="3" rx="1.5" />
        <rect className={styles.vent} x="24" y="45.5" width="16" height="2.6" rx="1" />
      </g>
      <rect className={styles.neck} x="28" y="24" width="8" height="7" rx="1.5" />
      <g className={styles.head}>
        <rect className={styles.shell} x="11" y="8" width="42" height="18" rx="9" />
        <rect className={styles.highlight} x="14" y="10" width="36" height="5" rx="2.5" />
        <rect className={styles.bridge} x="28.5" y="14" width="7" height="6" rx="1.5" />
        <BotEye slug={slug} side="l" cx={22} cy={17} r={7.6} />
        <BotEye slug={slug} side="r" cx={42} cy={17} r={7.6} />
      </g>
    </svg>
  );
}

function OddsborneBot({ slug }: { slug: string }) {
  return (
    <svg className={styles.bot} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <ellipse className={styles.shadow} cx="32" cy="58" rx="12" ry="2.6" />
      <rect className={styles.shellDark} x="23" y="50" width="18" height="6" rx="3" />
      <g className={styles.body}>
        <rect className={styles.shell} x="21" y="31" width="22" height="21" rx="6" />
        <rect className={styles.highlight} x="23" y="33" width="18" height="5" rx="2" />
        <rect className={styles.panel} x="25" y="40" width="14" height="6" rx="2" />
        <rect className={styles.accent} x="26" y="41.5" width="12" height="2.4" rx="1" />
        <rect className={styles.vent} x="27" y="47.5" width="10" height="2" rx="1" />
      </g>
      <ellipse className={styles.accent} cx="32" cy="7.5" rx="7" ry="2.6" />
      <rect className={styles.neck} x="30.2" y="9" width="3.6" height="6" rx="1" />
      <g className={styles.head}>
        <rect className={styles.shell} x="8" y="12" width="48" height="21" rx="10.5" />
        <rect className={styles.visor} x="11" y="15" width="42" height="15" rx="7.5" />
        <BotEye slug={slug} side="l" cx={22.5} cy={22.5} r={6.6} />
        <BotEye slug={slug} side="r" cx={41.5} cy={22.5} r={6.6} />
      </g>
    </svg>
  );
}

function BanditBot({ slug }: { slug: string }) {
  return (
    <svg className={styles.bot} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <ellipse className={styles.shadow} cx="32" cy="58" rx="16" ry="2.8" />
      <ellipse className={styles.tread} cx="32" cy="54" rx="17" ry="4.2" />
      <g className={styles.body}>
        <ellipse className={styles.shell} cx="32" cy="40" rx="19" ry="13.5" />
        <ellipse className={styles.highlight} cx="32" cy="35" rx="14" ry="5" />
        <rect className={styles.accent} x="20" y="42" width="24" height="3.2" rx="1.6" />
        <rect className={styles.vent} x="25" y="47" width="14" height="2.4" rx="1.2" />
      </g>
      <g className={styles.head}>
        <circle className={styles.shell} cx="32" cy="20.5" r="13.5" />
        <ellipse className={styles.highlight} cx="32" cy="15.5" rx="9" ry="3.4" />
        <rect className={styles.mask} x="15" y="16" width="34" height="11" rx="5.5" />
        <BotEye slug={slug} side="l" cx={25.5} cy={21.5} r={6.2} />
        <BotEye slug={slug} side="r" cx={40} cy={21.5} r={4.4} />
      </g>
    </svg>
  );
}

function GrasshopperBot({ slug }: { slug: string }) {
  return (
    <svg className={styles.bot} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <ellipse className={styles.shadow} cx="32" cy="58" rx="11" ry="2.4" />
      <polygon className={styles.accent} points="32,4 38,13 26,13" />
      <g className={styles.body}>
        <rect className={styles.shell} x="17" y="12" width="30" height="42" rx="7" />
        <rect className={styles.highlight} x="20" y="15" width="24" height="7" rx="3" />
        <rect className={styles.panel} x="21" y="36" width="22" height="13" rx="3" />
        <circle className={styles.rivet} cx="22" cy="17.5" r="1" />
        <circle className={styles.rivet} cx="42" cy="17.5" r="1" />
        <rect className={styles.accent} x="24" y="39" width="16" height="2.2" rx="1" />
        <rect className={styles.vent} x="26" y="43.5" width="12" height="2.2" rx="1" />
      </g>
      <g className={styles.head}>
        <rect className={styles.bridge} x="28.5" y="19" width="7" height="6" rx="1.5" />
        <BotEye slug={slug} side="l" cx={24} cy={22} r={7} />
        <BotEye slug={slug} side="r" cx={40} cy={22} r={7} />
      </g>
    </svg>
  );
}

function SparkBot({ slug }: { slug: string }) {
  return (
    <svg className={styles.bot} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <ellipse className={styles.shadow} cx="32" cy="56" rx="13" ry="2.4" />
      <g className={styles.body}>
        <rect className={styles.shell} x="16" y="18" width="32" height="30" rx="8" />
        <rect className={styles.highlight} x="19" y="21" width="26" height="6" rx="3" />
        <rect className={styles.accent} x="23" y="40" width="18" height="3" rx="1.5" />
        <rect className={styles.vent} x="26" y="45" width="12" height="2" rx="1" />
      </g>
      <g className={styles.head}>
        <BotEye slug={slug} side="l" cx={25} cy={30} r={6.4} />
        <BotEye slug={slug} side="r" cx={39} cy={30} r={6.4} />
      </g>
    </svg>
  );
}

function BotEye({
  slug,
  side,
  cx,
  cy,
  r,
}: {
  slug: string;
  side: 'l' | 'r';
  cx: number;
  cy: number;
  r: number;
}) {
  const clip = `steward-eye-${slug}-${side}`;
  const white = r * 0.72;
  return (
    <g className={styles.eye} transform={`translate(${cx} ${cy})`} data-part="eye">
      <circle className={styles.eyeRim} r={r} />
      <circle className={styles.eyeRing} r={r * 0.86} />
      <circle className={styles.lens} r={white} />
      <clipPath id={clip}>
        <circle r={white} />
      </clipPath>
      <g className={styles.gaze} clipPath={`url(#${clip})`}>
        <circle className={styles.iris} r={r * 0.42} />
        <circle className={styles.pupil} r={r * 0.26} />
        <circle className={styles.glint} cx={-r * 0.16} cy={-r * 0.18} r={r * 0.11} />
      </g>
      <rect
        className={styles.lid}
        x={-r}
        y={-r}
        width={r * 2}
        height={r * 2}
        rx={r * 0.4}
      />
    </g>
  );
}
