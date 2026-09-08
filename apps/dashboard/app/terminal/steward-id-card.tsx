'use client';

import { useEffect, useRef, type CSSProperties, type PointerEvent } from 'react';

import type { StewardIdCard as StewardIdCardModel } from '../../lib/steward-id';
import { StewardAvatar } from './steward-avatar';

export function StewardIdCard({
  card,
  reduceMotion,
}: {
  card: StewardIdCardModel;
  reduceMotion: boolean;
}) {
  const tiltRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = tiltRef.current;
    if (!node || reduceMotion) return;
    node.style.setProperty('--foil-x', '0deg');
    node.style.setProperty('--foil-y', '0deg');
  }, [reduceMotion]);

  function follow(event: PointerEvent<HTMLElement>) {
    if (reduceMotion) return;
    const node = tiltRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return;
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    node.style.setProperty('--foil-x', `${(-y * 5).toFixed(2)}deg`);
    node.style.setProperty('--foil-y', `${(x * 6).toFixed(2)}deg`);
  }

  function rest() {
    const node = tiltRef.current;
    if (!node) return;
    node.style.setProperty('--foil-x', '0deg');
    node.style.setProperty('--foil-y', '0deg');
  }

  return (
    <article
      ref={tiltRef}
      className="id-card"
      data-finish="ledger"
      data-steward={card.slug}
      // SAFETY: steward accent dyes the boarding-pass stock.
      style={{ '--card-ink': card.accent } as CSSProperties}
      onPointerMove={follow}
      onPointerLeave={rest}
    >
      <div className="id-card-stock">
        <header className="id-card-stub">
          <span>GRASSHOPPER</span>
          <span>STEWARD</span>
        </header>
        <div className="id-card-tear" aria-hidden="true" />
        <div className="id-card-face">
          <StewardAvatar
            slug={card.slug}
            name={card.display_name}
            size="card"
            accent={card.accent}
          />
          <b>{card.display_name}</b>
          <i>{card.domain}</i>
        </div>
        <div className="id-card-foil" aria-hidden="true" />
      </div>
    </article>
  );
}
