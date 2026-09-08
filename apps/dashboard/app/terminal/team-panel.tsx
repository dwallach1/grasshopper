'use client';

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
  return (
    <div className="steward-stage" data-roster="desk_agents">
      <h1 className="visually-hidden">Team</h1>
      {cards.length ? (
        <div className="steward-deck" aria-label="Steward cards">
          {cards.map((card) => (
            <div key={card.slug} className="steward-deck-slot">
              <StewardIdCard card={card} reduceMotion={reduceMotion} />
            </div>
          ))}
        </div>
      ) : (
        <p className="empty steward-empty">{NOT_IN_LEDGER}</p>
      )}
    </div>
  );
}
