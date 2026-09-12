'use client';

import { useEffect, useRef, useState } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { DeskPayload } from '../../lib/ledger-types';
import {
  assembleThesisRoster,
  thesisForId,
  type ThesisRosterRow,
} from '../../lib/thesis-roster';
import { HoldingIcon } from './holding-icon';
import { toneForStatus } from './format';

export function ThesesWorld({
  desk,
  reduceMotion = false,
  selectedId,
  onSelect,
}: {
  desk: DeskPayload;
  reduceMotion?: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const roster = assembleThesisRoster(desk).rows;
  const firstPaint = useRef(true);
  const [readingId, setReadingId] = useState<string | null>(null);
  const reading = readingId ? thesisForId(roster, readingId) ?? null : null;

  useEffect(() => {
    setReadingId((prev) => (prev && roster.some((row) => row.id === prev) ? prev : null));
  }, [roster]);

  useEffect(() => {
    if (!selectedId) return;
    const node = document.querySelector<HTMLElement>(`[data-thesis="${selectedId}"]`);
    if (!node) return;
    node.scrollIntoView({
      block: 'nearest',
      behavior: firstPaint.current || reduceMotion ? 'auto' : 'smooth',
    });
    firstPaint.current = false;
  }, [reduceMotion, selectedId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key === 'Escape') {
        setReadingId(null);
        return;
      }
      if (event.key !== 'Enter' || reading) return;
      const row = thesisForId(roster, selectedId ?? '') ?? roster[0];
      if (row) {
        event.preventDefault();
        onSelect?.(row.id);
        setReadingId(row.id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect, reading, roster, selectedId]);

  function openRow(row: ThesisRosterRow) {
    onSelect?.(row.id);
    setReadingId(row.id);
  }

  return (
    <div
      className="thesis-world"
      data-reduce-motion={reduceMotion ? '1' : '0'}
      data-reading={reading ? '1' : '0'}
    >
      <h1 className="visually-hidden">Theses</h1>
      <header className="thesis-mast">
        <p className="paper-title">Theses</p>
        <p className="thesis-lede">
          Claims on the ledger. Stance, status, and evidence — not book marks.
        </p>
      </header>
      {roster.length ? (
        <ul className="thesis-list" aria-label="Theses" aria-hidden={reading ? true : undefined}>
          {roster.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`thesis-card${selectedId === row.id ? ' is-on' : ''}${row.live ? '' : ' is-historic'}`}
                data-thesis={row.id}
                aria-current={selectedId === row.id ? 'true' : undefined}
                onClick={() => openRow(row)}
              >
                <HoldingIcon name={row.name} venue={row.venue} seed={row.id} />
                <span className="thesis-card-copy">
                  <b>{row.name}</b>
                  <i>{row.domain} · {row.steward_name}</i>
                </span>
                <span className="thesis-card-meta">
                  <span className="thesis-chip">{row.stance}</span>
                  <span className={`thesis-chip ${toneForStatus(row.status)}`}>{row.status}</span>
                  <span className="thesis-conf">{row.confidence}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty thesis-empty">{NOT_IN_LEDGER}</p>
      )}
      {reading && (
        <ThesisPage row={reading} onClose={() => setReadingId(null)} />
      )}
    </div>
  );
}

function ThesisPage({
  row,
  onClose,
}: {
  row: ThesisRosterRow;
  onClose: () => void;
}) {
  return (
    <article className="thesis-page" aria-label={row.name}>
      <button type="button" className="thesis-page-back" onClick={onClose}>
        Back to theses
      </button>
      <p className="thesis-page-kicker">
        {row.stance} · {row.status} · {row.confidence}
        {' · '}
        {row.domain} · {row.steward_name}
      </p>
      <h2>{row.name}</h2>
      <p>{row.summary}</p>
      {row.falsifier && (
        <p className="thesis-page-falsifier">{row.falsifier}</p>
      )}
      {row.evidence.length ? (
        <ul className="thesis-evidence">
          {row.evidence.map((note) => (
            <li key={note.id}>
              <b className={toneForStatus(note.direction)}>{note.direction}</b>
              <span>{note.evidence_type} · {note.confidence}</span>
              <p>{note.summary}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="thesis-page-empty">{NOT_IN_LEDGER}</p>
      )}
    </article>
  );
}
