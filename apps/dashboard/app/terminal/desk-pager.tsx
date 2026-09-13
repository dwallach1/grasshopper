'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { type DeskSwipeSurface } from '../../lib/desk-nav';
import {
  NESTED_SCROLL_ATTR,
  canBeginPull,
  paneScrollTop,
  pullPhase,
  pullProgress,
  pullTravel,
  shouldCommitPull,
} from '../../lib/desk-pull-refresh';
import {
  DESK_PAGER_SLOTS,
  compatMouseUntil,
  followPagerScroll,
  isCompatMouseSuppressed,
  isSwipeSurface,
  isSwipeWrap,
  lockSwipeAxis,
  pageSwipeConsumesTarget,
  pageSwipeFromDrag,
  pagerScrollToBehavior,
  pagerSlotKey,
  swipeHitFromEvent,
  swipeTabLabel,
  type SwipeAxisLock,
} from '../../lib/desk-swipe';

export function DeskPager({
  surface,
  reduceMotion,
  onSnap,
  onRefresh,
  children,
}: {
  surface: DeskSwipeSurface;
  reduceMotion: boolean;
  onSnap: (next: DeskSwipeSurface) => void;
  onRefresh: () => Promise<void>;
  children: Record<DeskSwipeSurface, ReactNode>;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const firstPaint = useRef(true);
  const surfaceRef = useRef(surface);
  const fromRef = useRef(surface);
  const holding = useRef(false);
  surfaceRef.current = surface;

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const pane = canonicalPane(root, surface);
    if (!pane) return;
    programmatic.current = true;
    const wrap = isSwipeWrap(fromRef.current, surface);
    fromRef.current = surface;
    const jump = firstPaint.current || wrap;
    const behavior = pagerScrollToBehavior(firstPaint.current, wrap, reduceMotion);
    firstPaint.current = false;
    if (jump) {
      root.style.scrollSnapType = 'none';
      root.scrollLeft = pane.offsetLeft;
      root.style.scrollSnapType = '';
    } else {
      root.scrollTo({ left: pane.offsetLeft, top: 0, behavior });
    }
    const id = window.setTimeout(() => {
      programmatic.current = false;
    }, reduceMotion || wrap ? 320 : 420);
    return () => window.clearTimeout(id);
  }, [reduceMotion, surface]);

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const panes = [...root.querySelectorAll<HTMLElement>('[data-desk-page]')];
    const io = new IntersectionObserver((entries) => {
      if (programmatic.current || holding.current) return;
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
    const mark = markRef.current;
    if (pager === null || mark === null) return undefined;
    return bindPagerSwipe(pager, mark, () => surfaceRef.current, onSnap, onRefresh, programmatic, holding);
  }, [onRefresh, onSnap]);

  return (
    <div className="desk-pager-shell">
      <div
        ref={markRef}
        className="desk-pull"
        data-state="idle"
        aria-hidden="true"
      >
        <i className="desk-pull-mark" />
      </div>
      <div
        ref={scrollerRef}
        className="desk-pager"
        data-circular="1"
        data-reduce-motion={reduceMotion ? '1' : '0'}
        aria-label="Desk surfaces"
      >
      {DESK_PAGER_SLOTS.map((slot) => (
        <section
          key={pagerSlotKey(slot.id, slot.clone)}
          className="desk-page"
          data-desk-page={slot.id}
          data-clone={slot.clone ? '1' : undefined}
          data-desk-pane-scroll={slot.clone ? undefined : '1'}
          aria-label={swipeTabLabel(slot.id)}
          aria-hidden={slot.clone || slot.id !== surface ? true : undefined}
        >
          {slot.clone ? null : children[slot.id]}
        </section>
      ))}
      </div>
    </div>
  );
}

function canonicalPane(root: HTMLElement, surface: DeskSwipeSurface): HTMLElement | null {
  return root.querySelector(`[data-desk-page="${surface}"]:not([data-clone])`);
}

function paneScrollRoot(pager: HTMLElement, surface: DeskSwipeSurface): HTMLElement {
  const pane = canonicalPane(pager, surface);
  if (!pane) return pager;
  const nodes = pane.querySelectorAll<HTMLElement>(`[${NESTED_SCROLL_ATTR}]`);
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node && !node.hidden) return node;
  }
  return pane;
}

function paintPull(pager: HTMLElement, mark: HTMLElement, travel: number, refreshing: boolean) {
  const progress = pullProgress(travel);
  const phase = pullPhase(travel, refreshing);
  mark.style.setProperty('--pull', String(progress));
  pager.dataset.pull = `${phase}:${Math.round(travel)}`;
  mark.dataset.state = phase;
}

function bindPagerSwipe(
  pager: HTMLDivElement,
  mark: HTMLElement,
  currentSurface: () => DeskSwipeSurface,
  onSnap: (next: DeskSwipeSurface) => void,
  onRefresh: () => Promise<void>,
  programmatic: { current: boolean },
  holding: { current: boolean },
): () => void {
  const gesture = {
    armed: false,
    dragging: false,
    axis: null as SwipeAxisLock,
    from: currentSurface(),
    originX: 0,
    originY: 0,
    startLeft: 0,
    pointerId: -1,
    ignoreMouseUntil: 0,
    refreshing: false,
  };

  function snapTo(next: DeskSwipeSurface) {
    programmatic.current = true;
    onSnap(next);
  }

  function capturePointer(id: number) {
    if (id < 0) return;
    try {
      pager.setPointerCapture(id);
    } catch {
      // pointer already gone
    }
  }

  function releaseCapture() {
    if (gesture.pointerId < 0) return;
    try {
      if (pager.hasPointerCapture(gesture.pointerId)) pager.releasePointerCapture(gesture.pointerId);
    } catch {
      // already released
    }
    gesture.pointerId = -1;
  }

  function disarm() {
    gesture.armed = false;
    gesture.dragging = false;
    gesture.axis = null;
    holding.current = false;
    pager.dataset.axis = '';
    releaseCapture();
  }

  function startRefresh() {
    if (gesture.refreshing) return;
    gesture.refreshing = true;
    paintPull(pager, mark, pullTravel(200), true);
    void onRefresh().finally(() => {
      gesture.refreshing = false;
      paintPull(pager, mark, 0, false);
    });
  }

  function onDown(event: PointerEvent) {
    if (gesture.armed) return;
    if (gesture.refreshing) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isCompatMouseSuppressed(event.pointerType, performance.now(), gesture.ignoreMouseUntil)) return;
    if (!pageSwipeConsumesTarget(swipeHitFromEvent(event.target))) return;
    gesture.armed = true;
    gesture.dragging = false;
    gesture.axis = null;
    gesture.from = currentSurface();
    holding.current = true;
    gesture.originX = event.clientX;
    gesture.originY = event.clientY;
    gesture.startLeft = pager.scrollLeft;
    gesture.pointerId = event.pointerId;
    capturePointer(event.pointerId);
    pager.dataset.swipe = `down:${gesture.from}`;
  }

  function onMove(event: PointerEvent) {
    if (!gesture.armed) return;
    if (gesture.pointerId >= 0 && event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.originX;
    const dy = event.clientY - gesture.originY;
    if (gesture.axis === 'y') {
      event.preventDefault();
      const travel = pullTravel(dy);
      paintPull(pager, mark, travel, false);
      pager.dataset.swipe = `pull:${gesture.from}:${Math.round(travel)}`;
      return;
    }
    if (gesture.axis === 'x') {
      event.preventDefault();
      const next = pageSwipeFromDrag(gesture.from, dx, dy);
      pager.dataset.swipe = `move:${gesture.from}:${Math.round(dx)}:${next ?? 'none'}`;
      if (next && isSwipeWrap(gesture.from, next)) {
        const until = compatMouseUntil(event.pointerType, performance.now());
        if (until) gesture.ignoreMouseUntil = until;
        disarm();
        snapTo(next);
        return;
      }
      const maxLeft = Math.max(0, pager.scrollWidth - pager.clientWidth);
      pager.scrollLeft = followPagerScroll(gesture.startLeft, dx, maxLeft);
      return;
    }
    const locked = lockSwipeAxis(dx, dy);
    if (locked === 'y') {
      const root = paneScrollRoot(pager, gesture.from);
      if (canBeginPull(paneScrollTop(root.scrollTop), dx, dy)) {
        gesture.axis = 'y';
        pager.dataset.axis = 'y';
        event.preventDefault();
        const travel = pullTravel(dy);
        paintPull(pager, mark, travel, false);
        pager.dataset.swipe = `pull:${gesture.from}:${Math.round(travel)}`;
        return;
      }
      disarm();
      pager.dataset.swipe = `vertical:${gesture.from}`;
      return;
    }
    if (locked !== 'x') return;
    gesture.axis = 'x';
    gesture.dragging = true;
    pager.dataset.axis = 'x';
    event.preventDefault();
    const next = pageSwipeFromDrag(gesture.from, dx, dy);
    pager.dataset.swipe = `move:${gesture.from}:${Math.round(dx)}:${next ?? 'none'}`;
    if (next && isSwipeWrap(gesture.from, next)) {
      const until = compatMouseUntil(event.pointerType, performance.now());
      if (until) gesture.ignoreMouseUntil = until;
      disarm();
      snapTo(next);
      return;
    }
    const maxLeft = Math.max(0, pager.scrollWidth - pager.clientWidth);
    pager.scrollLeft = followPagerScroll(gesture.startLeft, dx, maxLeft);
  }

  function onUp(event: PointerEvent) {
    if (!gesture.armed) return;
    if (gesture.pointerId >= 0 && event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.originX;
    const dy = event.clientY - gesture.originY;
    const pulled = gesture.axis === 'y';
    const dragged = gesture.dragging && gesture.axis === 'x';
    const from = gesture.from;
    const until = compatMouseUntil(event.pointerType, performance.now());
    if (until) gesture.ignoreMouseUntil = until;
    disarm();
    if (pulled) {
      const travel = pullTravel(dy);
      if (shouldCommitPull(travel)) {
        startRefresh();
        return;
      }
      paintPull(pager, mark, 0, false);
      return;
    }
    if (!dragged) return;
    const next = pageSwipeFromDrag(from, dx, dy);
    if (next) {
      snapTo(next);
      return;
    }
    const pane = canonicalPane(pager, from);
    if (pane) pager.scrollTo({ left: pane.offsetLeft, top: 0, behavior: 'auto' });
  }

  function onScroll() {
    if (programmatic.current || holding.current) return;
    const width = pager.clientWidth;
    if (width <= 0) return;
    const slot = Math.round(pager.scrollLeft / width);
    const spec = DESK_PAGER_SLOTS[slot];
    if (spec && spec.id !== currentSurface()) snapTo(spec.id);
  }

  pager.addEventListener('pointerdown', onDown, true);
  pager.addEventListener('pointermove', onMove, { passive: false });
  pager.addEventListener('pointerup', onUp);
  pager.addEventListener('pointercancel', onUp);
  pager.addEventListener('lostpointercapture', onUp);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  pager.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    pager.removeEventListener('pointerdown', onDown, true);
    pager.removeEventListener('pointermove', onMove);
    pager.removeEventListener('pointerup', onUp);
    pager.removeEventListener('pointercancel', onUp);
    pager.removeEventListener('lostpointercapture', onUp);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    pager.removeEventListener('scroll', onScroll);
  };
}
