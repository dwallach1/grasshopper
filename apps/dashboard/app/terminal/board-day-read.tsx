'use client';

import { useMemo } from 'react';

import { assembleBoardDayRead } from '../../lib/board-day-read';
import type { DeskPayload } from '../../lib/ledger-types';

/** Two-line Board read. Facts only; the standings and Liveline keep the numbers. */
export function BoardDayRead({
  desk,
  now,
}: {
  desk: DeskPayload;
  now: number | null;
}) {
  const read = useMemo(() => assembleBoardDayRead(desk, now), [desk, now]);
  if (!read.lead && !read.stamp) return null;
  return (
    <section className="day-read" aria-label="Day read" data-day-read="1">
      {read.lead ? <p className="day-read-lead">{read.lead}</p> : null}
      {read.stamp ? <p className="day-read-stamp">{read.stamp}</p> : null}
    </section>
  );
}
