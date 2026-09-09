'use client';

import { useEffect, useState, type CSSProperties } from 'react';

import {
  stewardAvatarLabel,
  stewardBotKind,
  stewardBotPalette,
  stewardEmoteDelayMs,
  type StewardAvatarSize,
  type StewardMood,
} from '../../lib/desk-avatar';
import type { StewardExpression } from '../../lib/steward-motion';
import { StewardLivingIcon } from './steward-living';
import styles from './steward-avatar.module.css';

export function StewardAvatar({
  slug,
  name,
  size = 'team',
  accent,
  alive = false,
  mood = 'idle',
  thinking = false,
  attending = false,
  preview,
}: {
  slug: string;
  name: string;
  size?: StewardAvatarSize;
  accent?: string;
  alive?: boolean;
  mood?: StewardMood;
  thinking?: boolean;
  attending?: boolean;
  preview?: StewardExpression;
}) {
  const label = stewardAvatarLabel(name);
  const palette = stewardBotPalette({ slug, name, accent });
  const kind = stewardBotKind(slug, name);
  const delayMs = stewardEmoteDelayMs(slug, name);
  const reducedMotion = usePrefersReducedMotion();
  const className = [
    styles.steward,
    size === 'board' ? styles.board : size === 'card' ? styles.card : styles.team,
    alive ? styles.alive : '',
  ]
    .filter(Boolean)
    .join(' ');
  // SAFETY: CSS custom properties are not in CSSProperties.
  const accentStyle = {
    '--team-accent': palette.accent,
    '--emote-delay': `${delayMs}ms`,
  } as CSSProperties;

  return (
    <span
      className={className}
      style={accentStyle}
      data-steward={slug}
      data-kind={kind}
      data-mood={mood}
      data-thinking={thinking ? '1' : '0'}
      data-alive={alive ? '1' : '0'}
      data-attending={attending ? '1' : '0'}
      data-preview={preview ?? ''}
      data-runtime="icon"
      role="img"
      aria-label={label}
    >
      <StewardLivingIcon
        kind={kind}
        mood={mood}
        alive={alive}
        thinking={thinking}
        attending={attending}
        preview={preview}
        reducedMotion={reducedMotion}
        delayMs={delayMs}
      />
    </span>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return reduced;
}
