import type { CSSProperties } from 'react';

const AVATAR_KEYS = new Set(['grasshopper', 'quant', 'odds']);

export function TeamAvatar({
  avatarKey,
  accent,
  label,
  alive,
}: {
  avatarKey: string;
  accent: string;
  label: string;
  alive: boolean;
}) {
  const key = AVATAR_KEYS.has(avatarKey) ? avatarKey : 'spark';
  return (
    <span
      className={`term-team-avatar term-team-avatar-${key}${alive ? ' is-alive' : ''}`}
      style={{ '--team-accent': accent } as CSSProperties}
      aria-hidden
      title={label}
    >
      {key === 'grasshopper' && <GrasshopperMark />}
      {key === 'quant' && <QuantMark />}
      {key === 'odds' && <OddsMark />}
      {key === 'spark' && <SparkMark />}
      <span className="term-team-avatar-ring" />
    </span>
  );
}

function GrasshopperMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <ellipse className="term-team-body" cx="30" cy="36" rx="16" ry="9" />
      <ellipse className="term-team-head" cx="44" cy="32" rx="7" ry="6" />
      <circle className="term-team-eye" cx="47" cy="31" r="1.4" />
      <path className="term-team-antenna term-team-antenna-a" d="M47 27c3-6 8-8 11-7" />
      <path className="term-team-antenna term-team-antenna-b" d="M45 26c1-6 5-9 9-9" />
      <path className="term-team-leg" d="M22 40c-8 2-12 10-10 14" />
      <path className="term-team-leg term-team-leg-hind" d="M18 36c-11-1-16 8-12 16" />
      <path className="term-team-wing" d="M20 32c6-10 18-12 24-6" />
    </svg>
  );
}

function QuantMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <ellipse className="term-team-body" cx="32" cy="38" rx="15" ry="11" />
      <circle className="term-team-head" cx="32" cy="22" r="8" />
      <circle className="term-team-eye" cx="29" cy="21" r="1.3" />
      <circle className="term-team-eye" cx="35" cy="21" r="1.3" />
      <path className="term-team-antenna term-team-antenna-a" d="M27 16c-3-6-8-8-12-6" />
      <path className="term-team-antenna term-team-antenna-b" d="M37 16c3-6 8-8 12-6" />
      <g className="term-team-chart">
        <path d="M22 44V36" />
        <path d="M28 44V32" />
        <path d="M34 44V38" />
        <path d="M40 44V30" />
        <path className="term-team-chart-line" d="M21 40h5l4-7 6 4 6-10" />
      </g>
    </svg>
  );
}

function OddsMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <g className="term-team-dice">
        <path className="term-team-crystal" d="M32 10l10 14H22z" />
        <rect className="term-team-body" x="18" y="26" width="28" height="28" rx="4" />
        <circle className="term-team-pip" cx="26" cy="34" r="2" />
        <circle className="term-team-pip" cx="38" cy="34" r="2" />
        <circle className="term-team-pip" cx="32" cy="40" r="2" />
        <circle className="term-team-pip" cx="26" cy="46" r="2" />
        <circle className="term-team-pip" cx="38" cy="46" r="2" />
      </g>
      <path className="term-team-sparkle" d="M50 18l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" />
    </svg>
  );
}

function SparkMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <path className="term-team-body" d="M32 10l4 16 16 4-16 4-4 16-4-16-16-4 16-4z" />
    </svg>
  );
}
