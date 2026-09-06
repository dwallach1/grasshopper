'use client';

import type { CSSProperties } from 'react';

import { clipCharter, deskTeam, isHeartbeatFresh, teamCards } from '../../lib/desk-team';
import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { DeskPayload } from '../../lib/ledger-types';
import { StewardAvatar } from './steward-avatar';
import { age, toneForStatus } from './format';

export function TeamPanel({ desk, now }: { desk: DeskPayload; now: number | null }) {
  const team = deskTeam(desk);
  const cards = teamCards(team);
  const fromLedger = Boolean(desk.team?.agents.length);
  return (
    <div className="term-grid term-grid-team">
      <section className="term-panel term-panel-span">
        <header>
          <b>TEAM</b>
          <span>
            {fromLedger
              ? 'desk_agents · current stewards'
              : `desk_agents empty · ${NOT_IN_LEDGER} roster`}
          </span>
        </header>
        <div className="term-team-cards">
          {cards.map((card) => {
            const alive = isHeartbeatFresh(card.heartbeat_at, now ?? 0);
            return (
              <article
                key={card.slug}
                className={`term-team-card status-${card.status}${alive ? ' is-alive' : ''}`}
                style={{ '--team-accent': card.accent } as CSSProperties}
              >
                <StewardAvatar
                  slug={card.slug}
                  name={card.display_name}
                  size="team"
                  accent={card.accent}
                  alive={alive}
                />
                <div className="term-team-meta">
                  <div className="term-team-name">
                    <b>{card.display_name}</b>
                    <i className={`term-team-pill ${toneForStatus(card.status)}`}>{card.status}</i>
                  </div>
                  <p className="term-team-role">{card.role_title}</p>
                  <p className="term-team-charter">{clipCharter(card.charter)}</p>
                  <div className="term-team-chips">
                    {card.domains.map((domain) => (
                      <span
                        key={domain.slug}
                        className={`term-team-chip${domain.is_primary ? ' is-primary' : ''}`}
                        style={{ '--team-chip': domain.accent } as CSSProperties}
                        title={domain.accounts.map((account) => account.label).join(' · ') || domain.kind}
                      >
                        {domain.name}
                      </span>
                    ))}
                    {!card.domains.length && <span className="term-team-chip dim">unassigned</span>}
                  </div>
                  <p className="term-team-beat">
                    {card.heartbeat_at
                      ? `heartbeat ${age(card.heartbeat_at, now)}${alive ? ' · live' : ''}`
                      : 'heartbeat not in ledger'}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
