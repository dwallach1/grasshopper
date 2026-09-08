'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import {
  DESK_SWIPE_SURFACES,
  type DeskSwipeSurface,
} from '../../lib/desk-nav';
import {
  followPagerScroll,
  isHorizontalLock,
  isSwipeSurface,
  isSwipeWrap,
  pageSwipeConsumesTarget,
  pagerScrollToBehavior,
  swipeAxis,
  swipeHitFromEvent,
  swipeTabLabel,
  wrapSwipeSurface,
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
  const fromRef = useRef(surface);
  surfaceRef.current = surface;

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const pane = root.querySelector<HTMLElement>(`[data-desk-page="${surface}"]`);
    if (!pane) return;
    programmatic.current = true;
    const wrap = isSwipeWrap(fromRef.current, surface);
    fromRef.current = surface;
    const behavior = pagerScrollToBehavior(firstPaint.current, wrap, reduceMotion);
    firstPaint.current = false;
    root.scrollTo({ left: pane.offsetLeft, top: 0, behavior });
    const id = window.setTimeout(() => {
      programmatic.current = false;
    }, reduceMotion || wrap ? 20 : 420);
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

  useEffect(() => {
    const pager = scrollerRef.current;
    if (pager === null) return undefined;
    return bindPagerSwipe(pager, () => surfaceRef.current, onSnap);
  }, [onSnap]);

  return (
    <div
      ref={scrollerRef}
      className="desk-pager"
      data-circular="1"
      data-reduce-motion={reduceMotion ? '1' : '0'}
      aria-label="Desk surfaces"
    >
      {DESK_SWIPE_SURFACES.map((id) => (
        <section
          key={id}
          className="desk-page"
          data-desk-page={id}
          data-desk-pane-scroll="1"
          aria-label={swipeTabLabel(id)}
          aria-hidden={id === surface ? undefined : true}
        >
          {children[id]}
        </section>
      ))}
    </div>
  );
}

function bindPagerSwipe(
  pager: HTMLDivElement,
  currentSurface: () => DeskSwipeSurface,
  onSnap: (next: DeskSwipeSurface) => void,
): () => void {
  const gesture = {
    armed: false,
    dragging: false,
    originX: 0,
    originY: 0,
    startLeft: 0,
  };

  function onDown(event: PointerEvent) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!pageSwipeConsumesTarget(swipeHitFromEvent(event.target))) return;
    gesture.armed = true;
    gesture.dragging = false;
    gesture.originX = event.clientX;
    gesture.originY = event.clientY;
    gesture.startLeft = pager.scrollLeft;
  }

  function onMove(event: PointerEvent) {
    if (!gesture.armed) return;
    const dx = event.clientX - gesture.originX;
    const dy = event.clientY - gesture.originY;
    if (!gesture.dragging) {
      if (!isHorizontalLock(dx, dy)) return;
      gesture.dragging = true;
    }
    const maxLeft = Math.max(0, pager.scrollWidth - pager.clientWidth);
    pager.scrollLeft = followPagerScroll(gesture.startLeft, dx, maxLeft);
  }

  function onUp(event: PointerEvent) {
    if (!gesture.armed) return;
    const dx = event.clientX - gesture.originX;
    const dy = event.clientY - gesture.originY;
    const dragged = gesture.dragging;
    gesture.armed = false;
    gesture.dragging = false;
    if (!pageSwipeConsumesTarget(swipeHitFromEvent(event.target)) && !dragged) return;
    const axis = swipeAxis(dx, dy);
    if (axis !== 0) {
      onSnap(wrapSwipeSurface(currentSurface(), axis));
      return;
    }
    const pane = pager.querySelector<HTMLElement>(`[data-desk-page="${currentSurface()}"]`);
    if (pane) pager.scrollTo({ left: pane.offsetLeft, top: 0, behavior: 'auto' });
  }

  pager.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  return () => {
    pager.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
}
