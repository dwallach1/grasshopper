import type { CSSProperties } from 'react';

import {
  stewardAvatarDataUri,
  stewardAvatarLabel,
  type StewardAvatarSize,
} from '../../lib/desk-avatar';
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
  const src = stewardAvatarDataUri({ slug, name, accent });
  const className = [
    styles.steward,
    size === 'board' ? styles.board : styles.team,
    alive ? styles.alive : '',
  ]
    .filter(Boolean)
    .join(' ');
  // SAFETY: CSS custom property --team-accent is not in CSSProperties.
  const accentStyle = { '--team-accent': accent } as CSSProperties;

  return (
    <span
      className={className}
      style={accentStyle}
      data-steward={slug}
    >
      <img className={styles.face} src={src} alt={label} width={88} height={88} />
      <span className={styles.ring} aria-hidden="true" />
    </span>
  );
}
