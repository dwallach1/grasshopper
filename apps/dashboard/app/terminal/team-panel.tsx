'use client';

import { useMemo } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { QUIET_STEWARD_FACE, stewardDeskFaces } from '../../lib/steward-face';
import { assembleTeamRoster } from '../../lib/steward-id';
import type { DeskPayload } from '../../lib/ledger-types';
import { StewardAvatar } from './steward-avatar';
import { age } from './format';

export function TeamPanel({
  desk,
  now = null,
}: {
  desk: DeskPayload;
  reduceMotion?: boolean;
  now?: number | null;
}) {
  const cards = assembleTeamRoster(desk);
  const faces = useMemo(() => stewardDeskFaces(desk, now ?? Date.now()), [desk, now]);

  return (
    <div className="steward-stage" data-roster="desk_agents">
      <h1 className="visually-hidden">Team</h1>
      <header className="team-mast">
        <p className="paper-title">Team</p>
        <p className="team-lede">Stewards on the ledger. Pulse is heartbeat age.</p>
      </header>
      {cards.length ? (
        <ul className="team-roster" aria-label="Stewards">
          {cards.map((card) => {
            const face = faces.get(card.slug) ?? QUIET_STEWARD_FACE;
            return (
              <li key={card.slug} className="team-card" data-steward={card.slug}>
                <StewardAvatar
                  slug={card.slug}
                  name={card.display_name}
                  size="board"
                  accent={card.accent}
                  {...face}
                />
                <div className="team-card-copy">
                  <b>{card.display_name}</b>
                  <i>{card.domain}</i>
                  <span>pulse {age(card.heartbeat_at ?? undefined, now)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty steward-empty">{NOT_IN_LEDGER}</p>
      )}
    </div>
  );
}
