'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import { clampDeckIndex, deckIndexFromThumb, deckThumbRatio, stepDeckIndex } from '../../lib/steward-deck';
import { stewardDeskFaces } from '../../lib/steward-face';
import { stewardIdCards } from '../../lib/steward-id';
import type { DeskPayload } from '../../lib/ledger-types';
import { StewardIdCard } from './steward-id-card';

export function TeamPanel({
  desk,
  reduceMotion = false,
  now = null,
}: {
  desk: DeskPayload;
  reduceMotion?: boolean;
  now?: number | null;
}) {
  const cards = stewardIdCards(desk);
  const faces = useMemo(() => stewardDeskFaces(desk, now ?? Date.now()), [desk, now]);
  const roster = cards.map((card) => card.slug).join('|');
  const [index, setIndex] = useState(0);
  const liveSlug = cards[clampDeckIndex(index, cards.length)]?.slug ?? '';

  useEffect(() => {
    setIndex(0);
  }, [roster]);

  function show(next: number) {
    setIndex(clampDeckIndex(next, cards.length));
  }

  return (
    <div className="steward-stage" data-roster="desk_agents">
      <h1 className="visually-hidden">Team</h1>
      {cards.length ? (
        <>
          <div className="steward-deck" aria-label="Steward cards">
            <div
              className="steward-deck-track"
              data-reduce-motion={reduceMotion ? '1' : '0'}
              style={{ transform: `translateX(${-clampDeckIndex(index, cards.length) * 100}%)` }}
            >
              {cards.map((card) => (
                <div key={card.slug} className="steward-deck-slot" data-card-slot={card.slug}>
                  <StewardIdCard
                    card={card}
                    reduceMotion={reduceMotion}
                    live={card.slug === liveSlug}
                    face={faces.get(card.slug)}
                  />
                </div>
              ))}
            </div>
          </div>
          <StewardCardDragger
            names={cards.map((card) => card.display_name)}
            index={clampDeckIndex(index, cards.length)}
            onIndex={show}
          />
        </>
      ) : (
        <p className="empty steward-empty">{NOT_IN_LEDGER}</p>
      )}
    </div>
  );
}

function StewardCardDragger({
  names,
  index,
  onIndex,
}: {
  names: readonly string[];
  index: number;
  onIndex: (next: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const count = names.length;
  const current = names[index] ?? '';
  const ratio = deckThumbRatio(index, count);

  function seek(clientX: number) {
    const rail = railRef.current;
    if (!rail) return;
    const box = rail.getBoundingClientRect();
    onIndex(deckIndexFromThumb(clientX - box.left, box.width, count));
  }

  function onRailDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    seek(event.clientX);
  }

  function onRailMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.stopPropagation();
    seek(event.clientX);
  }

  if (count === 0) return null;

  return (
    <nav
      className="steward-dragger"
      data-card-dragger="1"
      aria-label="Steward card control"
    >
      <button
        type="button"
        aria-label="Previous steward"
        disabled={index <= 0}
        onClick={() => onIndex(stepDeckIndex(index, -1, count))}
        onPointerDown={(event) => event.stopPropagation()}
      >
        ‹
      </button>
      <div
        ref={railRef}
        className="steward-dragger-rail"
        role="slider"
        aria-label="Steward card track"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={index + 1}
        aria-valuetext={current}
        onPointerDown={onRailDown}
        onPointerMove={onRailMove}
      >
        <i
          className="steward-dragger-thumb"
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
      <button
        type="button"
        aria-label="Next steward"
        disabled={index >= count - 1}
        onClick={() => onIndex(stepDeckIndex(index, 1, count))}
        onPointerDown={(event) => event.stopPropagation()}
      >
        ›
      </button>
      <div className="steward-dragger-dots">
        {names.map((name, slot) => (
          <button
            key={name}
            type="button"
            aria-label={name}
            aria-current={slot === index ? 'true' : undefined}
            onClick={() => onIndex(slot)}
            onPointerDown={(event) => event.stopPropagation()}
          />
        ))}
      </div>
    </nav>
  );
}
