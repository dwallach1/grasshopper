'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  paintCardAlbedo,
  STEWARD_CARD_TEX,
  stewardCardInk,
} from '../../lib/steward-card-stock';
import { isWebGL2Available } from '../../lib/steward-foil';
import type { StewardIdCard as StewardIdCardModel } from '../../lib/steward-id';
import { StewardAvatar } from './steward-avatar';
import { StewardHeroCard } from './steward-hero-card';

export function StewardIdCard({
  card,
  reduceMotion,
  live = false,
}: {
  card: StewardIdCardModel;
  reduceMotion: boolean;
  live?: boolean;
}) {
  const stampRef = useRef<HTMLDivElement>(null);
  const [webgl, setWebgl] = useState(true);
  const [iconHost, setIconHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!isWebGL2Available()) setWebgl(false);
    setIconHost(stampRef.current);
  }, [live]);

  const useHero = live && webgl;

  return (
    <article
      className={`id-card${useHero ? ' is-hero' : ' is-poster'}`}
      data-finish="ledger"
      data-steward={card.slug}
      data-live={useHero ? '1' : '0'}
      // SAFETY: steward accent dyes the laminate stock.
      style={{ '--card-ink': card.accent } as CSSProperties}
    >
      {useHero ? (
        <StewardHeroCard card={card} reduceMotion={reduceMotion} iconHost={iconHost} />
      ) : (
        <StewardCardPoster card={card} />
      )}
      <div
        ref={stampRef}
        className={useHero ? 'id-card-stamp' : 'id-card-mascot'}
        aria-hidden={useHero ? true : undefined}
      >
        <StewardAvatar
          slug={card.slug}
          name={card.display_name}
          size="card"
          accent={card.accent}
        />
      </div>
    </article>
  );
}

function StewardCardPoster({ card }: { card: StewardIdCardModel }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = STEWARD_CARD_TEX.width;
    canvas.height = STEWARD_CARD_TEX.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ink = stewardCardInk(card.slug, card.display_name);
    ink.domain = card.domain;
    paintCardAlbedo(ctx, ink);
  }, [card.display_name, card.domain, card.slug]);

  return (
    <canvas
      ref={canvasRef}
      className="id-card-poster"
      aria-hidden="true"
    />
  );
}
