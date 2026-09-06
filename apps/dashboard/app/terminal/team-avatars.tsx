import type { CSSProperties } from 'react';

import { type AvatarShape } from '../../lib/desk-team';

export function TeamAvatar({
  shape,
  accent,
  label,
  alive,
}: {
  shape: AvatarShape;
  accent: string;
  label: string;
  alive: boolean;
}) {
  return (
    <span
      className={`term-team-avatar term-team-avatar-${shape}${alive ? ' is-alive' : ''}`}
      style={{ '--team-accent': accent } as CSSProperties}
      data-shape={shape}
      aria-hidden
      title={label}
    >
      {shape === 'tablet' && <TabletMark />}
      {shape === 'blob' && <BlobMark />}
      {shape === 'wedge' && <WedgeMark />}
      {shape === 'pebble' && <PebbleMark />}
      {shape === 'spark' && <SparkMark />}
      <span className="term-team-avatar-ring" />
    </span>
  );
}

function TabletMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <rect className="term-team-token" x="18" y="10" width="28" height="44" rx="8" />
      <rect className="term-team-token-inset" x="22" y="16" width="20" height="32" rx="5" />
    </svg>
  );
}

function BlobMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <path
        className="term-team-token"
        d="M22 36c-5-9 1-18 13-18 6-9 20-6 22 6 9 1 12 12 5 18-1 11-14 14-23 9-8 5-19-1-17-15z"
      />
    </svg>
  );
}

function WedgeMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <path
        className="term-team-token"
        d="M16 14c-2 10-2 26 0 36 10-6 22-12 34-18C38 26 26 20 16 14z"
      />
    </svg>
  );
}

function PebbleMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <ellipse className="term-team-token" cx="32" cy="34" rx="20" ry="13" transform="rotate(-26 32 34)" />
    </svg>
  );
}

function SparkMark() {
  return (
    <svg className="term-team-svg" viewBox="0 0 64 64" fill="none">
      <path className="term-team-token" d="M32 10l5 17 17 5-17 5-5 17-5-17-17-5 17-5z" />
    </svg>
  );
}
