'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  assembleCrtTape,
  crtTapeGlyphStream,
  crtTapeScrollText,
  formatCrtTapeLine,
} from '../../lib/desk-crt-tape';
import type { DeskPayload, DeskRoutine } from '../../lib/ledger-types';
import { NO_RUN_RECORDED } from '../../lib/routines';
import { age, nyStamp } from './format';

export function CrtTape({
  desk,
  now,
}: {
  desk: DeskPayload;
  now: number | null;
}) {
  const lines = useMemo(() => assembleCrtTape(desk), [desk]);
  const reduced = usePrefersReducedMotion();
  const scroll = crtTapeScrollText(lines);
  const newest = lines[0];
  const glyphs = crtTapeGlyphStream(lines);

  return (
    <section className="crt-tape" aria-label="Desk fill tape">
      <header className="crt-tape-hud">
        <b>TAPE</b>
        <span>{lines.length}</span>
        {newest?.at ? <i>{age(newest.at, now)}</i> : null}
      </header>
      <p className="crt-tape-glyphs" aria-hidden="true">{glyphs}</p>
      {newest ? <p className="crt-tape-head">{formatCrtTapeLine(newest)}</p> : null}
      <RoutineList desk={desk} now={now} />
      <div className="crt-tape-viewport">
        {reduced ? (
          <p className="crt-tape-static">{scroll}</p>
        ) : (
          <p className="crt-tape-scroll">
            <span>{scroll}</span>
            <span aria-hidden="true">{scroll}</span>
          </p>
        )}
      </div>
      <ol className="visually-hidden">
        {lines.map((row) => (
          <li key={row.id}>{`${row.steward} ${row.label} ${row.status}`}</li>
        ))}
      </ol>
    </section>
  );
}

function routineWhen(routine: DeskRoutine, now: number | null): string {
  if (!routine.last_run_at) return NO_RUN_RECORDED;
  const when = now === null ? nyStamp(routine.last_run_at) : age(routine.last_run_at, now);
  return routine.last_outcome ? `${routine.last_outcome} · ${when}` : when;
}

function RoutineList({
  desk,
  now,
}: {
  desk: DeskPayload;
  now: number | null;
}) {
  const routines = desk.routines ?? [];
  if (routines.length === 0) return null;
  return (
    <ul className="crt-tape-routines" aria-label="Routines">
      {routines.map((routine) => (
        <li key={routine.id} data-routine={routine.id}>
          <b>{routine.name}</b>
          <span>{routineWhen(routine, now)}</span>
        </li>
      ))}
    </ul>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return reduced;
}
