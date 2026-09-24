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
  horizontalPageSwipeSuppressed,
  isCompatMouseSuppressed,
  isSwipeSurface,
  isSwipeWrap,
  lockSwipeAxis,
  PAGER_PIN_SETTLE_MS,
  pageSwipeConsumesTarget,
  pageSwipeFromDrag,
  pagerScrollToBehavior,
  pagerSlotKey,
  shouldCapturePagerPointer,
  swipeHitFromEvent,
  swipeTabLabel,
  teamGestureKind,
  touchBlocksNativePan,
  type SwipeAxisLock,
  type TeamGestureKind,
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
    captured: false,
    axis: null as SwipeAxisLock,
    suppressHorizontal: false,
    cardHold: false,
    // SAFETY: kind starts as a page swipe and is only assigned from teamGestureKind.
    nativeKind: 'page' as TeamGestureKind,
    pinUntil: 0,
    from: currentSurface(),
    originX: 0,
    originY: 0,
    startLeft: 0,
    pointerId: -1,
    ignoreMouseUntil: 0,
    refreshing: false,
  };
  let pinning = false;

  function snapTo(next: DeskSwipeSurface) {
    programmatic.current = true;
    onSnap(next);
  }

  function capturePointer(id: number) {
    if (id < 0) return;
    try {
      pager.setPointerCapture(id);
      gesture.captured = true;
    } catch {
      // pointer already gone
    }
  }

  function captureIfLocked(pulling: boolean) {
    if (gesture.captured) return;
    if (!shouldCapturePagerPointer(gesture.axis, pulling)) return;
    capturePointer(gesture.pointerId);
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
    gesture.captured = false;
    gesture.axis = null;
    gesture.suppressHorizontal = false;
    holding.current = false;
    pager.dataset.axis = '';
    releaseCapture();
  }

  function pinPager() {
    if (pinning) return;
    const pane = canonicalPane(pager, gesture.from);
    if (!pane) return;
    const left = pane.offsetLeft;
    if (Math.abs(pager.scrollLeft - left) < 1) return;
    pinning = true;
    const snap = pager.style.scrollSnapType;
    pager.style.scrollSnapType = 'none';
    pager.scrollLeft = left;
    pager.style.scrollSnapType = snap;
    pinning = false;
  }

  function releaseNativePin() {
    const hold = gesture.nativeKind === 'handle' || gesture.cardHold;
    if (hold) pinPager();
    gesture.nativeKind = 'page';
    gesture.cardHold = false;
    if (hold) gesture.pinUntil = performance.now() + PAGER_PIN_SETTLE_MS;
  }

  function rememberTouchOrigin(x: number, y: number) {
    gesture.originX = x;
    gesture.originY = y;
    gesture.from = currentSurface();
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
    const hit = swipeHitFromEvent(event.target);
    const kind = teamGestureKind(hit);
    if (kind === 'page') gesture.pinUntil = 0;
    gesture.nativeKind = kind;
    if (kind === 'handle') {
      rememberTouchOrigin(event.clientX, event.clientY);
      gesture.pointerId = event.pointerId;
      gesture.cardHold = false;
      return;
    }
    if (!pageSwipeConsumesTarget(hit)) return;
    gesture.armed = true;
    gesture.dragging = false;
    gesture.axis = null;
    gesture.suppressHorizontal = horizontalPageSwipeSuppressed(hit);
    gesture.from = currentSurface();
    holding.current = true;
    gesture.originX = event.clientX;
    gesture.originY = event.clientY;
    gesture.startLeft = pager.scrollLeft;
    gesture.pointerId = event.pointerId;
    gesture.captured = false;
    pager.dataset.swipe = `down:${gesture.from}`;
  }

  function onMove(event: PointerEvent) {
    if (!gesture.armed) return;
    if (gesture.pointerId >= 0 && event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.originX;
    const dy = event.clientY - gesture.originY;
    if (gesture.cardHold) {
      event.preventDefault();
      pinPager();
      pager.dataset.swipe = `card:${gesture.from}`;
      return;
    }
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
        captureIfLocked(true);
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
    if (gesture.suppressHorizontal) {
      gesture.cardHold = true;
      gesture.dragging = false;
      event.preventDefault();
      pinPager();
      pager.dataset.swipe = `card:${gesture.from}`;
      return;
    }
    gesture.axis = 'x';
    gesture.dragging = true;
    pager.dataset.axis = 'x';
    captureIfLocked(false);
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

  function onTouchStart(event: TouchEvent) {
    const kind = teamGestureKind(swipeHitFromEvent(event.target));
    if (kind === 'page') {
      gesture.pinUntil = 0;
      gesture.nativeKind = 'page';
      return;
    }
    gesture.nativeKind = kind;
    const touch = event.changedTouches[0];
    if (touch && !gesture.armed) rememberTouchOrigin(touch.clientX, touch.clientY);
    if (kind === 'handle' && event.cancelable) event.preventDefault();
  }

  function onTouchMove(event: TouchEvent) {
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - gesture.originX;
    const dy = touch.clientY - gesture.originY;
    if (!touchBlocksNativePan(gesture.nativeKind, dx, dy)) return;
    if (event.cancelable) event.preventDefault();
    if (gesture.nativeKind === 'card') {
      gesture.cardHold = true;
      pager.dataset.swipe = `card:${gesture.from}`;
    }
    pinPager();
  }

  function onTouchEnd() {
    releaseNativePin();
  }

  function onUp(event: PointerEvent) {
    const tracked = gesture.pointerId < 0 || event.pointerId === gesture.pointerId;
    if (tracked) releaseNativePin();
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
    const pinningGesture = gesture.nativeKind === 'handle' || gesture.cardHold;
    const settle = !gesture.armed && performance.now() < gesture.pinUntil;
    if (pinningGesture || settle) {
      pinPager();
      return;
    }
    if (programmatic.current || holding.current) return;
    const width = pager.clientWidth;
    if (width <= 0) return;
    const slot = Math.round(pager.scrollLeft / width);
    const spec = DESK_PAGER_SLOTS[slot];
    if (spec && spec.id !== currentSurface()) snapTo(spec.id);
  }

  function onLostCapture(event: PointerEvent) {
    // setPointerCapture moves capture off the row that received pointerdown.
    // That loss bubbles while the finger is still down (often at the ~12px axis
    // lock). Treating it as pointerup cancels the swipe before the 56px commit,
    // so Board↔Team never wraps. Only a real release of this pager ends it.
    if (event.target !== pager || event.buttons !== 0) return;
    onUp(event);
  }

  pager.addEventListener('pointerdown', onDown, true);
  pager.addEventListener('pointermove', onMove, { passive: false });
  pager.addEventListener('pointerup', onUp);
  pager.addEventListener('pointercancel', onUp);
  pager.addEventListener('lostpointercapture', onLostCapture);
  pager.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  pager.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  pager.addEventListener('touchend', onTouchEnd);
  pager.addEventListener('touchcancel', onTouchEnd);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  pager.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    pager.removeEventListener('pointerdown', onDown, true);
    pager.removeEventListener('pointermove', onMove);
    pager.removeEventListener('pointerup', onUp);
    pager.removeEventListener('pointercancel', onUp);
    pager.removeEventListener('lostpointercapture', onLostCapture);
    pager.removeEventListener('touchstart', onTouchStart, true);
    pager.removeEventListener('touchmove', onTouchMove, true);
    pager.removeEventListener('touchend', onTouchEnd);
    pager.removeEventListener('touchcancel', onTouchEnd);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    pager.removeEventListener('scroll', onScroll);
  };
}
