'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { applyStandingOrder, moveStanding, standingShiftFromDrag } from '../../lib/desk-board-order';
import { isMarkStale } from '../../lib/desk-freshness';
import {
  assembleLeaderboard,
  freshLead,
  NOT_RANKED,
} from '../../lib/desk-leaderboard';
import {
  assembleLiveline,
  boardHeroIdle,
  boardHeroLiveline,
} from '../../lib/desk-liveline';
import type { DeskPayload } from '../../lib/ledger-types';
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
  const hero = useMemo(() => boardHeroLiveline(line), [line]);
  const clock = now ?? Date.now();
  const lead = freshLead(board.rows, clock);
  const stale = boardHeroIdle(line, clock, isMarkStale);
  const [order, setOrder] = useState<string[]>(() => board.rows.map((row) => row.id));
  const drag = useRef<{ id: string; pointerId: number; startY: number; origin: string[] } | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;

  useEffect(() => {
    setOrder((prev) => applyStandingOrder(board.rows, prev).map((row) => row.id));
  }, [board.rows]);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      setOrder(moveStanding(active.origin, active.id, standingShiftFromDrag(event.clientY - active.startY)));
    }
    function onUp(event: PointerEvent) {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      drag.current = null;
    }
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const rows = useMemo(() => applyStandingOrder(board.rows, order), [board.rows, order]);

  function onPlaceDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // capture is optional; window listeners still drive the reorder
    }
    drag.current = { id, pointerId: event.pointerId, startY: event.clientY, origin: orderRef.current };
  }

  return (
    <div className="line-stage line-board">
      <h1 className="visually-hidden">Board</h1>
      <p className="paper-title">Board</p>

      <CrtTape desk={desk} now={now} />

      <section
        className={`line-hero line-art${stale ? ' is-idle' : ''}`}
        aria-label="Desk return lines"
      >
        <DeskLiveline
          series={hero.series}
          unit={hero.unit}
          parchment
          quiet
          idle={stale}
          showValue={hero.showValue}
          emptyText={hero.emptyText}
        />
        {hero.series.length > 1 ? (
          <ul className="line-key">
            {hero.series.map((row) => (
              <li key={row.id} style={{ color: row.color }}>
                <i aria-hidden="true" />
                {row.label}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <p className="line-caption">
        {hero.caption}
        {stale ? ' · idle' : ''}
      </p>

      <ol className="line-standings">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`line-row${row.ranked ? '' : ' is-empty'}${lead && row.id === lead.id ? ' is-lead' : ''}${row.ranked && isMarkStale(row.last_marked, clock) ? ' is-stale-marks' : ''}`}
            // SAFETY: CSS custom property for the shared steward accent token.
            style={{ '--team-accent': row.accent } as CSSProperties}
          >
            <div className="line-row-hit">
              <button
                type="button"
                className="line-place"
                data-card-dragger="1"
                aria-label={`Reorder ${row.steward}`}
                onPointerDown={(event) => onPlaceDown(event, row.id)}
              >
                {row.place ?? '—'}
              </button>
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
