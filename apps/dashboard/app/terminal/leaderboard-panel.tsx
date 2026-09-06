'use client';

import type { CSSProperties, MouseEvent } from 'react';

import {
  assembleLeaderboard,
  NOT_RANKED,
} from '../../lib/desk-leaderboard';
import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { DeskPayload } from '../../lib/ledger-types';
import { ledgerAmount } from '../../lib/money-units';
import { StewardAvatar } from './steward-avatar';
import { age, nyStamp, pct, pnlClass } from './format';

export function LeaderboardPanel({
  desk,
  now,
  onOpenTeam,
}: {
  desk: DeskPayload;
  now: number | null;
  onOpenTeam?: () => void;
}) {
  const board = assembleLeaderboard(desk);
  return (
    <div className="term-grid term-grid-team">
      <section className="term-panel term-panel-span">
        <header>
          <b>LEADERBOARD</b>
          <span>{board.subtitle}</span>
        </header>
        <p className="term-board-rules">{board.rules}</p>
        <div className="term-board-cards">
          {board.rows.map((row) => (
            <article
              key={row.id}
              className={`term-board-card${row.ranked ? '' : ' is-empty'}${row.place === 1 ? ' is-lead' : ''}`}
              style={{ '--team-accent': row.accent } as CSSProperties}
            >
              <div className="term-board-place" aria-label={row.place ? `place ${row.place}` : NOT_RANKED}>
                {row.place ?? '—'}
              </div>
              <StewardAvatar
                slug={row.slug}
                name={row.steward}
                size="board"
                accent={row.accent}
              />
              <div className="term-board-meta">
                <div className="term-team-name">
                  {onOpenTeam ? (
                    <a
                      href="/team"
                      className="term-board-name"
                      onClick={(event) => onDeskClick(event, onOpenTeam)}
                    >
                      {row.steward}
                    </a>
                  ) : (
                    <b>{row.steward}</b>
                  )}
                  <i className="term-team-chip is-primary" style={{ '--team-chip': row.accent } as CSSProperties}>
                    {row.venue_label}
                  </i>
                </div>
                <p className="term-team-role">{row.role_title}</p>
                <p className={`term-board-return ${row.ranked ? pnlClass(row.return_pct) : 'muted'}`}>
                  {row.ranked ? pct(row.return_pct, 2) : NOT_RANKED}
                </p>
                <p className="term-board-equity">
                  {row.unit
                    ? `${ledgerAmount(row.start, row.unit)} → ${ledgerAmount(row.now, row.unit)}`
                    : NOT_IN_LEDGER}
                </p>
                <p className="term-board-risk">{row.risk_note}</p>
                <p className="term-team-beat">
                  {row.last_marked
                    ? `last marked ${nyStamp(row.last_marked)} · ${age(row.last_marked, now)}`
                    : 'last marked not in ledger'}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function onDeskClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  navigate();
}
