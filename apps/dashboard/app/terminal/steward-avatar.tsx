'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';

import {
  stewardAvatarLabel,
  stewardBotKind,
  stewardBotPalette,
  stewardEmoteDelayMs,
  stewardFurTone,
  type StewardAvatarSize,
  type StewardMood,
} from '../../lib/desk-avatar';
import { StewardBot } from './steward-bots';
import styles from './steward-avatar.module.css';

const StewardRiveFace = dynamic(
  () => import('./steward-rive').then((mod) => mod.StewardRiveFace),
  { ssr: false },
);

export function StewardAvatar({
  slug,
  name,
  size = 'team',
  accent,
  alive = false,
  mood = 'idle',
}: {
  slug: string;
  name: string;
  size?: StewardAvatarSize;
  accent?: string;
  alive?: boolean;
  mood?: StewardMood;
}) {
  const label = stewardAvatarLabel(name);
  const palette = stewardBotPalette({ slug, name, accent });
  const kind = stewardBotKind(slug, name);
  const fur = stewardFurTone(kind);
  const delayMs = stewardEmoteDelayMs(slug, name);
  const reducedMotion = usePrefersReducedMotion();
  const [runtime, setRuntime] = useState<'rive' | 'svg'>('rive');
  const onReady = useCallback(() => setRuntime('rive'), []);
  const onFailed = useCallback(() => setRuntime('svg'), []);
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
    '--emote-delay': `${delayMs}ms`,
    '--fur': fur.base,
    '--fur-deep': fur.deep,
    '--fur-lit': fur.lit,
    '--fur-pad': fur.pad,
  } as CSSProperties;

  return (
    <span
      className={className}
      style={accentStyle}
      data-steward={slug}
      data-kind={kind}
      data-mood={mood}
      data-runtime={runtime}
      role="img"
      aria-label={label}
    >
      {runtime === 'svg' ? (
        <StewardBot kind={kind} alive={alive} delayMs={delayMs} mood={mood} />
      ) : (
        <StewardRiveFace
          key={`${kind}-${mood}-${alive ? '1' : '0'}-${reducedMotion ? 'still' : 'motion'}`}
          kind={kind}
          mood={mood}
          alive={alive}
          reducedMotion={reducedMotion}
          delayMs={delayMs}
          onReady={onReady}
          onFailed={onFailed}
        />
      )}
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
