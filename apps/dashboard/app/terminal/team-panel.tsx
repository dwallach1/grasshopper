'use client';

import { useEffect, useRef, useState } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { stewardIdCards } from '../../lib/steward-id';
import type { DeskPayload } from '../../lib/ledger-types';
import { StewardIdCard } from './steward-id-card';

export function TeamPanel({
  desk,
  reduceMotion = false,
}: {
  desk: DeskPayload;
  reduceMotion?: boolean;
}) {
  const cards = stewardIdCards(desk);
  const deckRef = useRef<HTMLDivElement>(null);
  const roster = cards.map((card) => card.slug).join('|');
  const [liveSlug, setLiveSlug] = useState(cards[0]?.slug ?? '');

  useEffect(() => {
    setLiveSlug(roster.split('|')[0] ?? '');
  }, [roster]);

  useEffect(() => {
    const root = deckRef.current;
    if (!root) return undefined;
    const slots = [...root.querySelectorAll<HTMLElement>('[data-card-slot]')];
    const io = new IntersectionObserver((entries) => {
      const hit = entries
        .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.55)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const slug = hit?.target.getAttribute('data-card-slot');
      if (slug) setLiveSlug(slug);
    }, { root, threshold: [0.55, 0.85] });
    for (const slot of slots) io.observe(slot);
    return () => io.disconnect();
  }, [roster]);

  return (
    <div className="steward-stage" data-roster="desk_agents">
      <h1 className="visually-hidden">Team</h1>
      {cards.length ? (
        <div ref={deckRef} className="steward-deck" aria-label="Steward cards">
          {cards.map((card) => (
            <div key={card.slug} className="steward-deck-slot" data-card-slot={card.slug}>
              <StewardIdCard
                card={card}
                reduceMotion={reduceMotion}
                live={card.slug === liveSlug}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="empty steward-empty">{NOT_IN_LEDGER}</p>
      )}
    </div>
  );
}
