'use client';

import { useEffect, useMemo, useState } from 'react';

import { assembleCrtTape, crtTapeScrollText } from '../../lib/desk-crt-tape';
import type { DeskPayload } from '../../lib/ledger-types';
import { age } from './format';

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

  return (
    <section className="crt-tape" aria-label="Desk fill tape">
      <header className="crt-tape-hud">
        <b>TAPE</b>
        <span>{lines.length}</span>
        {newest ? <i>{age(newest.at, now)}</i> : null}
      </header>
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
