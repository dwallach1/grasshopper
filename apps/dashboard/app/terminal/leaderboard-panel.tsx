'use client';

import { useMemo, useState, type CSSProperties, type MouseEvent } from 'react';

import {
  assembleLeaderboard,
  NOT_RANKED,
  type LeaderboardCompetitorId,
} from '../../lib/desk-leaderboard';
import {
  assembleLiveline,
  bookCurve,
  type LivelineBookId,
} from '../../lib/desk-liveline';
import type { DeskPayload } from '../../lib/ledger-types';
import { ledgerAmount } from '../../lib/money-units';
import { DeskLiveline } from './desk-liveline';
import { age, nyStamp, pct, pnlClass } from './format';
import { TeamAvatar } from './team-avatars';

type BoardFocus = 'all' | LivelineBookId;

const FOCI: Array<{ id: BoardFocus; label: string }> = [
  { id: 'all', label: 'ALL' },
  { id: 'quantanamo', label: 'QUANTANAMO' },
  { id: 'oddsborne', label: 'ODDSBORNE' },
  { id: 'bandit', label: 'BANDIT' },
];

export function LeaderboardPanel({
  desk,
  now,
  onOpenTeam,
}: {
  desk: DeskPayload;
  now: number | null;
  onOpenTeam?: () => void;
}) {
  const [focus, setFocus] = useState<BoardFocus>('all');
  const board = useMemo(() => assembleLeaderboard(desk), [desk]);
  const line = useMemo(() => assembleLiveline(desk), [desk]);
  const curve = focus === 'all' ? null : bookCurve(line, focus);
  const ranked = board.rows.filter((row) => row.ranked);
  const lead = ranked[0];

  return (
    <div className="line-stage">
      <header className="line-mast">
        <p className="line-kicker">the line</p>
        <h1>Board</h1>
        <p className="line-lede">
          One living % curve per book, native units. SOL is not dollars.
          Missing start is not ranked.
        </p>
      </header>

      <div className="line-foci" role="tablist" aria-label="Steward line">
        {FOCI.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={focus === item.id}
            className={focus === item.id ? 'on' : ''}
            onClick={() => setFocus(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section className="line-hero" aria-label="Desk sport line">
        {focus === 'all' ? (
          <DeskLiveline
            key="all"
            series={line.all_pct}
            unit="PCT"
            color="#e8edf2"
            emptyText="no ranked book in ledger"
            showValue={false}
          />
        ) : (
          <DeskLiveline
            key={focus}
            points={curve?.equity ?? []}
            value={curve?.now ?? null}
            unit={curve?.unit ?? 'USD'}
            color={curve?.color}
            emptyText={curve?.empty_text}
            returnPct={curve?.return_pct ?? null}
            degen
          />
        )}
      </section>

      <p className="line-caption">
        {focus === 'all'
          ? 'ALL is % vs each book’s own start — the only shared axis. No FX.'
          : curve?.source}
        {lead ? ` · lead ${lead.steward} ${pct(lead.return_pct, 2)}` : ''}
      </p>

      <ol className="line-standings">
        {board.rows.map((row) => (
          <li
            key={row.id}
            className={`line-row${row.ranked ? '' : ' is-empty'}${row.place === 1 ? ' is-lead' : ''}${focus === row.id ? ' is-on' : ''}`}
            // SAFETY: CSS custom property for the existing TeamAvatar accent token.
            style={{ '--team-accent': row.accent } as CSSProperties}
          >
            <button
              type="button"
              className="line-row-hit"
              onClick={() => setFocus(toFocus(row.id))}
            >
              <span className="line-place">{row.place ?? '—'}</span>
              <TeamAvatar
                shape={row.avatar_shape}
                accent={row.accent}
                label={row.steward}
                alive={false}
              />
              <span className="line-who">
                <b>{row.steward}</b>
                <i>{row.venue_label} · {row.unit ?? '—'}</i>
              </span>
              <span className={`line-pct ${row.ranked ? pnlClass(row.return_pct) : 'muted'}`}>
                {row.ranked ? pct(row.return_pct, 2) : NOT_RANKED}
              </span>
            </button>
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

function toFocus(id: LeaderboardCompetitorId): BoardFocus {
  if (id === 'quantanamo' || id === 'oddsborne' || id === 'bandit') return id;
  return 'all';
}

function onDeskClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  navigate();
}
