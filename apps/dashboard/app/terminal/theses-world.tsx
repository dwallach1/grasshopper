'use client';

import { useEffect, useRef, useState } from 'react';

import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { DeskPayload } from '../../lib/ledger-types';
import { pagerScrollBehavior } from '../../lib/desk-swipe';
import {
  assembleThesisDistricts,
  districtForThesis,
  districtPlaceWord,
  type ThesisBuilding,
  type ThesisDistrict,
} from '../../lib/thesis-districts';
import { ThesisIslandPoster, ThesisIslandView } from './thesis-island-view';

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
  const districts = assembleThesisDistricts(desk);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const firstPaint = useRef(true);
  const roster = districts.map((row) => row.id).join('|');
  const [liveId, setLiveId] = useState(districts[0]?.id ?? '');
  const [reading, setReading] = useState<ThesisBuilding | null>(null);

  useEffect(() => {
    setLiveId(roster.split('|')[0] ?? '');
    setReading(null);
  }, [roster]);

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return undefined;
    const slots = [...root.querySelectorAll<HTMLElement>('[data-district]')];
    const io = new IntersectionObserver((entries) => {
      if (programmatic.current) return;
      const hit = entries
        .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.55)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const id = hit?.target.getAttribute('data-district');
      if (id) setLiveId(id);
    }, { root, threshold: [0.55, 0.9] });
    for (const slot of slots) io.observe(slot);
    return () => io.disconnect();
  }, [roster]);

  useEffect(() => {
    if (!selectedId) return;
    const next = districtForThesis(districts, selectedId);
    if (!next) return;
    const root = scrollerRef.current;
    const pane = root?.querySelector<HTMLElement>(`[data-district="${next.id}"]`);
    if (!pane || !root) return;
    programmatic.current = true;
    const behavior = firstPaint.current ? 'auto' : pagerScrollBehavior(reduceMotion);
    firstPaint.current = false;
    pane.scrollIntoView({ block: 'start', inline: 'nearest', behavior });
    setLiveId(next.id);
    const id = window.setTimeout(() => {
      programmatic.current = false;
    }, reduceMotion ? 20 : 420);
    return () => window.clearTimeout(id);
  }, [reduceMotion, roster, selectedId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key === 'Escape') {
        setReading(null);
        return;
      }
      if (event.key !== 'Enter' || reading) return;
      const district = districts.find((row) => row.id === liveId) ?? districts[0];
      const building = district?.buildings.find((row) => row.id === selectedId)
        ?? district?.buildings[0];
      if (building) {
        event.preventDefault();
        onSelect?.(building.id);
        setReading(building);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [districts, liveId, onSelect, reading, selectedId]);

  function openBuilding(building: ThesisBuilding) {
    onSelect?.(building.id);
    setReading(building);
  }

  return (
    <div
      className="thesis-world"
      data-reduce-motion={reduceMotion ? '1' : '0'}
      data-reading={reading ? '1' : '0'}
    >
      <h1 className="visually-hidden">Theses</h1>
      {districts.length ? (
        <div
          ref={scrollerRef}
          className="thesis-districts"
          data-axis="y"
          aria-label="Thesis districts"
          aria-hidden={reading ? true : undefined}
        >
          {districts.map((district, index) => (
            <DistrictPane
              key={district.id}
              district={district}
              peek={districts[(index + 1) % districts.length] ?? null}
              live={district.id === liveId && !reading}
              index={index}
              total={districts.length}
              onOpen={openBuilding}
              reduceMotion={reduceMotion}
            />
          ))}
        </div>
      ) : (
        <p className="empty thesis-empty">{NOT_IN_LEDGER}</p>
      )}
      {reading && (
        <ThesisPage building={reading} onClose={() => setReading(null)} />
      )}
    </div>
  );
}

function DistrictPane({
  district,
  peek,
  live,
  index,
  total,
  onOpen,
  reduceMotion,
}: {
  district: ThesisDistrict;
  peek: ThesisDistrict | null;
  live: boolean;
  index: number;
  total: number;
  onOpen: (building: ThesisBuilding) => void;
  reduceMotion: boolean;
}) {
  const word = districtPlaceWord(district.place);
  const mark = String(index + 1).padStart(2, '0');
  return (
    <section
      className="thesis-district"
      data-district={district.id}
      data-place={district.place}
      data-count={district.buildings.length}
      data-live={live ? '1' : '0'}
      aria-label={district.name}
    >
      {live ? (
        <ThesisIslandView
          district={district}
          peek={peek && peek.id !== district.id ? peek : null}
          reduceMotion={reduceMotion}
          onOpen={onOpen}
        />
      ) : (
        <ThesisIslandPoster district={district} />
      )}
      <ol className="thesis-dots" aria-hidden="true">
        {Array.from({ length: total }, (_, slot) => (
          <li key={slot} className={slot === index ? 'is-on' : undefined} />
        ))}
      </ol>
      <p className="thesis-place-index" aria-hidden="true">{mark} / {word}</p>
      {district.buildings.map((building) => (
        <button
          key={building.id}
          type="button"
          className="visually-hidden"
          onClick={() => onOpen(building)}
        >
          {building.name}
        </button>
      ))}
    </section>
  );
}

function ThesisPage({
  building,
  onClose,
}: {
  building: ThesisBuilding;
  onClose: () => void;
}) {
  return (
    <article
      className="thesis-page"
      aria-label={building.name}
    >
      <button type="button" className="thesis-page-back" onClick={onClose}>
        Back to the district
      </button>
      <h2>{building.name}</h2>
      <p>{building.summary}</p>
      {building.falsifier && (
        <p className="thesis-page-falsifier">{building.falsifier}</p>
      )}
    </article>
  );
}
