'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { rowVenue } from '../../lib/desk-venue';
import type { FillLogRow } from '../../lib/ledger-types';
import { ledgerAmountFor } from '../../lib/money-units';
import {
  maxAbsNotional,
  replayFills,
  replayIntensity,
  replayProgress,
  TAPE_RIVE_PROGRESS_INPUT,
  TAPE_RIVE_SRC,
  TAPE_RIVE_STATE_MACHINE,
  TAPE_STEP_MS,
  tapeCaption,
  tapeIdentity,
} from '../../lib/trade-replay';
import { nyStamp, qty, toneForStatus } from './format';
import { VenueMark } from './venue-filter';

const DeskRive = dynamic(() => import('./desk-rive').then((mod) => mod.DeskRive), {
  ssr: false,
});

export function TradeReplay({ rows }: { rows: readonly FillLogRow[] }) {
  const tape = useMemo(() => replayFills(rows), [rows]);
  const tapeKey = useMemo(() => tapeIdentity(tape), [tape]);
  const peak = useMemo(() => maxAbsNotional(tape), [tape]);
  const last = Math.max(0, tape.length - 1);
  const [index, setIndex] = useState(last);
  const [playing, setPlaying] = useState(false);
  const [armed, setArmed] = useState(false);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    setIndex(Math.max(0, tape.length - 1));
    setPlaying(false);
  }, [tapeKey, tape.length]);

  useEffect(() => {
    if (!playing || tape.length === 0) return undefined;
    if (index >= tape.length - 1) {
      setPlaying(false);
      return undefined;
    }
    const id = window.setTimeout(() => {
      setIndex((current) => Math.min(tape.length - 1, current + 1));
    }, TAPE_STEP_MS);
    return () => window.clearTimeout(id);
  }, [index, playing, tape.length]);

  useEffect(() => {
    function onVis() {
      if (document.visibilityState === 'hidden') setPlaying(false);
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const current = tape[index];
  const progress = replayProgress(index, tape.length);
  const intensity = replayIntensity(current, peak);
  const numberInputs = useMemo(
    () => ({ [TAPE_RIVE_PROGRESS_INPUT]: Math.max(progress, intensity) }),
    [intensity, progress],
  );

  if (!tape.length) return null;

  function toggle() {
    if (playing) {
      setPlaying(false);
      return;
    }
    setArmed(true);
    setIndex((current) => (current >= last ? 0 : current));
    setPlaying(true);
  }

  return (
    <div className="term-tape" aria-label="Trade tape replay">
      <div className="term-tape-stage">
        {armed && !reduceMotion ? (
          <DeskRive
            src={TAPE_RIVE_SRC}
            stateMachine={TAPE_RIVE_STATE_MACHINE}
            playing={playing}
            numberInputs={numberInputs}
            className="term-tape-rive"
            aria-label="Tape motion chrome"
          />
        ) : (
          <div className="term-tape-rive is-idle" aria-hidden />
        )}
        {current ? <TapeFill row={current} /> : <p className="empty">{NOT_IN_LEDGER}</p>}
      </div>
      <div className="term-tape-controls">
        <button type="button" className={playing ? 'on' : ''} onClick={toggle}>
          {playing ? 'Pause' : index >= last && armed ? 'Replay' : 'Play'}
        </button>
        <button
          type="button"
          disabled={index <= 0}
          onClick={() => {
            setPlaying(false);
            setIndex((current) => Math.max(0, current - 1));
          }}
        >
          Prev
        </button>
        <button
          type="button"
          disabled={index >= last}
          onClick={() => {
            setPlaying(false);
            setIndex((current) => Math.min(last, current + 1));
          }}
        >
          Next
        </button>
        <label className="term-tape-scrub">
          <span className="sr-only">Scrub ledger fills</span>
          <input
            type="range"
            min={0}
            max={last}
            step={1}
            value={index}
            aria-valuetext={current ? `${current.symbol} ${current.side}` : NOT_IN_LEDGER}
            onChange={(event) => {
              setPlaying(false);
              setIndex(Number(event.target.value));
            }}
          />
        </label>
        <i>
          {index + 1}/{tape.length}
        </i>
      </div>
      <p className="term-prose dim">{tapeCaption(tape)} · marks stay venue-true</p>
    </div>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduce(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return reduce;
}

function TapeFill({ row }: { row: FillLogRow }) {
  return (
    <div className="term-line term-tape-fill">
      <b className="sym">
        {row.symbol || NOT_IN_LEDGER} <VenueMark venue={rowVenue(row)} />
      </b>
      <span>
        {row.side || NOT_IN_LEDGER} {qty(row.quantity)} ·{' '}
        {row.price === null ? (row.note || NOT_IN_LEDGER) : ledgerAmountFor(row, row.price)}
        {' / '}
        {ledgerAmountFor(row, row.notional)}
      </span>
      <i className={toneForStatus(row.status)}>{row.status}</i>
      <p>{nyStamp(row.at)}</p>
    </div>
  );
}
