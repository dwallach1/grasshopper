'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import {
  DESK_SWIPE_SURFACES,
  type DeskSwipeSurface,
} from '../../lib/desk-nav';
import {
  isSwipeSurface,
  pagerScrollBehavior,
  swipeTabLabel,
} from '../../lib/desk-swipe';

export function DeskPager({
  surface,
  reduceMotion,
  onSnap,
  children,
}: {
  surface: DeskSwipeSurface;
  reduceMotion: boolean;
  onSnap: (next: DeskSwipeSurface) => void;
  children: Record<DeskSwipeSurface, ReactNode>;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const firstPaint = useRef(true);
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const pane = root.querySelector<HTMLElement>(`[data-desk-page="${surface}"]`);
    if (!pane) return;
    programmatic.current = true;
    const behavior = firstPaint.current ? 'auto' : pagerScrollBehavior(reduceMotion);
    firstPaint.current = false;
    pane.scrollIntoView({ inline: 'start', block: 'nearest', behavior });
    const id = window.setTimeout(() => {
      programmatic.current = false;
    }, reduceMotion ? 20 : 420);
    return () => window.clearTimeout(id);
  }, [reduceMotion, surface]);

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const panes = [...root.querySelectorAll<HTMLElement>('[data-desk-page]')];
    const io = new IntersectionObserver((entries) => {
      if (programmatic.current) return;
      const hit = entries
        .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.55)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const id = hit?.target.getAttribute('data-desk-page');
      if (id && isSwipeSurface(id) && id !== surfaceRef.current) onSnap(id);
    }, { root, threshold: [0.55, 0.9] });
    for (const pane of panes) io.observe(pane);
    return () => io.disconnect();
  }, [onSnap]);

  return (
    <div
      ref={scrollerRef}
      className="desk-pager"
      data-reduce-motion={reduceMotion ? '1' : '0'}
      aria-label="Desk surfaces"
    >
      {DESK_SWIPE_SURFACES.map((id) => (
        <section
          key={id}
          className="desk-page"
          data-desk-page={id}
          aria-label={swipeTabLabel(id)}
          aria-hidden={id === surface ? undefined : true}
        >
          {children[id]}
        </section>
      ))}
    </div>
  );
}
