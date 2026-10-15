'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { scrollTeamStageToSteward } from '../../lib/desk-team-scroll';
import { QUIET_STEWARD_FACE, stewardDeskFaces } from '../../lib/steward-face';
import { assembleTeamRoster } from '../../lib/steward-id';
import type { DeskPayload } from '../../lib/ledger-types';
import { assembleStewardScorecard } from '../../lib/steward-scorecard';
import { StewardAvatar } from './steward-avatar';
import { StewardScorecard } from './steward-scorecard';
import { age } from './format';

export function TeamPanel({
  desk,
  now = null,
  scrollTo = null,
}: {
  desk: DeskPayload;
  reduceMotion?: boolean;
  now?: number | null;
  /** Bump `seq` to pin that steward's row to the top of this page. */
  scrollTo?: { slug: string; seq: number } | null;
}) {
  const cards = assembleTeamRoster(desk);
  const faces = useMemo(() => stewardDeskFaces(desk, now ?? Date.now()), [desk, now]);
  const stageRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!scrollTo || !stage) return;
    scrollTeamStageToSteward(stage, scrollTo.slug);
  }, [scrollTo]);

  return (
    <div
      ref={stageRef}
      className="steward-stage"
      data-roster="desk_agents"
      data-desk-nested-scroll="1"
    >
      <h1 className="visually-hidden">Team</h1>
      <header className="team-mast">
        <p className="paper-title">Team</p>
        <p className="team-lede">Stewards on the ledger. Pulse is heartbeat age.</p>
      </header>
      {cards.length ? (
        <ul className="team-roster" aria-label="Stewards">
          {cards.map((card) => {
            const face = faces.get(card.slug) ?? QUIET_STEWARD_FACE;
            const score = assembleStewardScorecard(desk.scorecard, card.slug);
            return (
              <li key={card.slug} className="team-li">
                <article className="team-card" data-steward={card.slug}>
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
                    <span>pulse {card.heartbeat_at ? age(card.heartbeat_at, now) : 'no heartbeat'}</span>
                  </div>
                </article>
                {score && <StewardScorecard card={score} name={card.display_name} />}
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
