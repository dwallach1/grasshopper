'use client';

import { useMemo, type CSSProperties, type MouseEvent } from 'react';

import {
  assembleLeaderboard,
  NOT_RANKED,
} from '../../lib/desk-leaderboard';
import { assembleLiveline } from '../../lib/desk-liveline';
import type { DeskPayload } from '../../lib/ledger-types';
import { ledgerAmount } from '../../lib/money-units';
import { CrtTape } from './crt-tape';
import { DeskLiveline } from './desk-liveline';
import { QUIET_STEWARD_FACE, stewardDeskFaces } from '../../lib/steward-face';
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
  const board = useMemo(() => assembleLeaderboard(desk), [desk]);
  const faces = useMemo(() => stewardDeskFaces(desk, now ?? Date.now()), [desk, now]);
  const line = useMemo(() => assembleLiveline(desk), [desk]);
  const ranked = board.rows.filter((row) => row.ranked);
  const lead = ranked[0];

  return (
    <div className="line-stage line-board">
      <h1 className="visually-hidden">Board</h1>

      <CrtTape desk={desk} now={now} />

      <section className="line-hero" aria-label="Desk sport line">
        <DeskLiveline
          key="all"
          series={line.all_pct}
          unit="PCT"
          color="#e8edf2"
          emptyText="no ranked book in ledger"
          showValue={false}
        />
      </section>

      <p className="line-caption">
        % vs each book’s own start — the only shared axis. No FX. Missing start is not ranked.
        {lead ? ` · lead ${lead.steward} ${pct(lead.return_pct, 2)}` : ''}
      </p>

      <ol className="line-standings">
        {board.rows.map((row) => (
          <li
            key={row.id}
            className={`line-row${row.ranked ? '' : ' is-empty'}${row.place === 1 ? ' is-lead' : ''}`}
            // SAFETY: CSS custom property for the shared steward accent token.
            style={{ '--team-accent': row.accent } as CSSProperties}
          >
            <div className="line-row-hit">
              <span className="line-place">{row.place ?? '—'}</span>
              <StewardAvatar
                slug={row.slug}
                name={row.steward}
                size="board"
                accent={row.accent}
                {...(faces.get(row.slug) ?? QUIET_STEWARD_FACE)}
              />
              <span className="line-who">
                <b>{row.steward}</b>
                <i>{row.venue_label} · {row.unit ?? '—'}</i>
              </span>
              <span className={`line-pct ${row.ranked ? pnlClass(row.return_pct) : 'muted'}`}>
                {row.ranked ? pct(row.return_pct, 2) : NOT_RANKED}
              </span>
            </div>
            <p className="line-meta">
              {row.unit
                ? `${ledgerAmount(row.start, row.unit)} → ${ledgerAmount(row.now, row.unit)}`
                : 'not in ledger'}
              {' · '}
              {row.risk_note}
              {onOpenTeam ? (
                <>
                  {' · '}
                  <a href="/team" onClick={(event) => onDeskClick(event, onOpenTeam)}>team</a>
                </>
              ) : null}
              {row.last_marked
                ? ` · ${nyStamp(row.last_marked)} · ${age(row.last_marked, now)}`
                : ''}
            </p>
          </li>
        ))}
      </ol>
      <p className="line-rules">{board.rules}</p>
    </div>
  );
}

function onDeskClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  navigate();
}
