'use client';

import type { CSSProperties } from 'react';

import {
  stewardAvatarLabel,
  stewardBotKind,
  stewardBotPalette,
  stewardEmoteDelayMs,
  type StewardAvatarSize,
} from '../../lib/desk-avatar';
import { StewardBot } from './steward-bots';
import styles from './steward-avatar.module.css';

export function StewardAvatar({
  slug,
  name,
  size = 'team',
  accent,
  alive = false,
}: {
  slug: string;
  name: string;
  size?: StewardAvatarSize;
  accent?: string;
  alive?: boolean;
}) {
  const label = stewardAvatarLabel(name);
  const palette = stewardBotPalette({ slug, name, accent });
  const kind = stewardBotKind(slug, name);
  const className = [
    styles.steward,
    size === 'board' ? styles.board : styles.team,
    alive ? styles.alive : '',
  ]
    .filter(Boolean)
    .join(' ');
  // SAFETY: CSS custom properties are not in CSSProperties.
  const accentStyle = {
    '--team-accent': palette.accent,
    '--emote-delay': `${stewardEmoteDelayMs(slug, name)}ms`,
  } as CSSProperties;

  return (
    <span
      className={className}
      style={accentStyle}
      data-steward={slug}
      data-kind={kind}
      role="img"
      aria-label={label}
    >
      <StewardBot kind={kind} />
      <span className={styles.ring} aria-hidden="true" />
    </span>
  );
}
