import {
  holdingIconKind,
  holdingMonogram,
  holdingTilePaint,
} from '../../lib/holding-icon';
import type { DeskVenue } from '../../lib/desk-venue';

export function HoldingIcon({
  name,
  venue,
  seed,
}: {
  name: string;
  venue: DeskVenue;
  seed?: string;
}) {
  const kind = holdingIconKind(venue);
  const mark = holdingMonogram(name, venue);
  const paint = holdingTilePaint(seed ?? name, venue);
  const label = `${kind} ${mark}`;
  return (
    <svg
      className="holding-icon"
      viewBox="0 0 32 32"
      width="32"
      height="32"
      role="img"
      aria-label={label}
      data-kind={kind}
    >
      {kind === 'token' ? (
        <circle cx="16" cy="16" r="14" fill={paint.fill} stroke={paint.rule} strokeWidth="1" />
      ) : (
        <rect x="2" y="2" width="28" height="28" rx="8" fill={paint.fill} stroke={paint.rule} strokeWidth="1" />
      )}
      {kind === 'contract' ? (
        <g fill="none" stroke={paint.ink} strokeWidth="1.4" strokeLinecap="round">
          <path d="M10 11h12" />
          <path d="M10 16h9" />
          <path d="M10 21h7" />
          <path d="M20 20.5l2 2 4-4" />
        </g>
      ) : (
        <text
          x="16"
          y="17.2"
          textAnchor="middle"
          dominantBaseline="middle"
          fill={paint.ink}
          fontSize={mark.length > 3 ? 8 : 10}
          fontFamily="IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
          fontWeight="600"
          letterSpacing="-0.04em"
        >
          {mark}
        </text>
      )}
    </svg>
  );
}
