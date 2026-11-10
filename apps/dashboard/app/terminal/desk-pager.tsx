'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { type DeskSwipeSurface } from '../../lib/desk-nav';
import {
  NESTED_SCROLL_ATTR,
  PULL_TRIGGER_PX,
  canBeginPull,
  paneScrollTop,
  pullFingerForTravel,
  pullPhase,
  pullProgress,
  pullReleaseVelocity,
  pullTravel,
  shouldCommitPull,
} from '../../lib/desk-pull-refresh';
import {
  DESK_PAGER_SLOTS,
  compatMouseUntil,
  followPagerScroll,
  gestureSpring,
  horizontalPageSwipeSuppressed,
  instantPagerLeft,
  isCompatMouseSuppressed,
  isSwipeSurface,
  isSwipeWrap,
  lockSwipeAxis,
  notePointerSample,
  PAGER_PIN_SETTLE_MS,
  pageSwipeConsumesTarget,
  pageSwipeFromDrag,
  pagerScrollToBehavior,
  pagerSlotKey,
  releaseVelocity,
  settledPagerSlot,
  shouldCapturePagerPointer,
  springSettled,
  springStep,
  swipeHitFromEvent,
  swipeRelease,
  swipeTabLabel,
  teamGestureKind,
  touchBlocksNativePan,
  wrapSwipeSurface,
  type PointerSample,
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
  const reduceRef = useRef(reduceMotion);

  useEffect(() => {
    surfaceRef.current = surface;
    reduceRef.current = reduceMotion;
  });

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
      instantPagerLeft(root, pane.offsetLeft);
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
      const width = root.clientWidth;
      const slot = settledPagerSlot(root.scrollLeft, width, DESK_PAGER_SLOTS.length);
      const resting = slot === null ? null : DESK_PAGER_SLOTS[slot];
      if (!resting || resting.clone) return;
      const hit = entries
        .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.55)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const id = hit?.target.getAttribute('data-desk-page');
      if (id && isSwipeSurface(id) && id === resting.id && id !== surfaceRef.current) onSnap(id);
    }, { root, threshold: [0.55, 0.9] });
    for (const pane of panes) io.observe(pane);
    return () => io.disconnect();
  }, [onSnap]);

  useEffect(() => {
    const pager = scrollerRef.current;
    const mark = markRef.current;
    if (pager === null || mark === null) return undefined;
    return bindPagerSwipe(
      pager,
      mark,
      () => surfaceRef.current,
      onSnap,
      onRefresh,
      programmatic,
      holding,
      reduceRef,
    );
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
  const shown = travel > 0 ? travel : 0;
  const progress = pullProgress(shown);
  const phase = pullPhase(shown, refreshing);
  mark.style.setProperty('--pull', String(progress));
  pager.dataset.pull = `${phase}:${Math.round(shown)}`;
  mark.dataset.state = phase;
  // Refresh owns the mark through its stylesheet. While the finger is down,
  // and while the spring returns, write the transform here so it can leave
  // the trigger and still land on the idle pose.
  if (refreshing) {
    mark.style.transform = '';
    mark.style.opacity = '';
    return;
  }
  if (!(shown > 0)) {
    mark.style.transform = '';
    mark.style.opacity = '';
    return;
  }
  const stretch = shown / PULL_TRIGGER_PX;
  mark.style.transform = `translate3d(0, ${stretch * 36}px, 0) scale(${0.78 + Math.min(stretch, 1.2) * 0.24})`;
  mark.style.opacity = String(Math.min(1, stretch));
}

function runSpring(
  reduceMotion: boolean,
  from: number,
  velocity: number,
  target: number,
  apply: (value: number) => void,
  done: () => void,
): () => void {
  if (reduceMotion || !Number.isFinite(from) || !Number.isFinite(target)) {
    apply(Number.isFinite(target) ? target : 0);
    done();
    return () => undefined;
  }
  const tune = gestureSpring(false);
  let position = from;
  let vel = Number.isFinite(velocity) ? velocity : 0;
  let last = performance.now();
  let frame = 0;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.034, Math.max(0, (now - last) / 1000));
    last = now;
    if (dt > 0) {
      const stepped = springStep({ position, velocity: vel, target }, dt, tune);
      position = stepped.position;
      vel = stepped.velocity;
      apply(position);
      if (springSettled(stepped)) {
        apply(target);
        frame = 0;
        done();
        return;
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  };
}

function bindPagerSwipe(
  pager: HTMLDivElement,
  mark: HTMLElement,
  currentSurface: () => DeskSwipeSurface,
  onSnap: (next: DeskSwipeSurface) => void,
  onRefresh: () => Promise<void>,
  programmatic: { current: boolean },
  holding: { current: boolean },
  reduceRef: { current: boolean },
): () => void {
  const gesture = {
    armed: false,
    dragging: false,
    captured: false,
    // SAFETY: axis stays null until lockSwipeAxis returns 'x' or 'y'.
    axis: null as SwipeAxisLock,
    suppressHorizontal: false,
    cardHold: false,
    // SAFETY: kind starts as a page swipe and is only assigned from teamGestureKind.
    nativeKind: 'page' as TeamGestureKind,
    pinUntil: 0,
    from: currentSurface(),
    originX: 0,
    originY: 0,
    grabLeft: 0,
    restLeft: 0,
    settling: false,
    // SAFETY: samples only store { t, x } points appended by notePointerSample.
    xSamples: [] as PointerSample[],
    // SAFETY: samples only store { t, x } points appended by notePointerSample.
    ySamples: [] as PointerSample[],
    pullBase: 0,
    pullTravelNow: 0,
    pointerId: -1,
    ignoreMouseUntil: 0,
    refreshing: false,
  };
  let pinning = false;
  let stopSettle: () => void = () => undefined;

  function cancelSettle() {
    const wasSettling = gesture.settling;
    stopSettle();
    stopSettle = () => undefined;
    gesture.settling = false;
    if (!wasSettling) return;
    // The spring had the scroll handler parked. A catch has to own the pointer
    // again, or a cancelled flight leaves the rail stuck mid-page.
    holding.current = false;
    programmatic.current = false;
  }

  function trackScroll(active: boolean) {
    pager.style.scrollSnapType = active ? 'none' : '';
    pager.style.scrollBehavior = active ? 'auto' : '';
  }

  function noteSamples(event: PointerEvent): number {
    const t = performance.now();
    gesture.xSamples = notePointerSample(gesture.xSamples, t, event.clientX);
    gesture.ySamples = notePointerSample(gesture.ySamples, t, event.clientY);
    return t;
  }

  function settlePull(fromTravel: number, velocity: number) {
    cancelSettle();
    gesture.settling = true;
    stopSettle = runSpring(
      reduceRef.current,
      fromTravel,
      velocity,
      0,
      (travel) => {
        const shown = travel > 0 ? travel : 0;
        gesture.pullTravelNow = shown;
        paintPull(pager, mark, shown, false);
      },
      () => {
        gesture.settling = false;
        gesture.pullTravelNow = 0;
        gesture.pullBase = 0;
        paintPull(pager, mark, 0, false);
      },
    );
  }

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
    instantPagerLeft(pager, left);
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

  function followFinger(dx: number) {
    const maxLeft = Math.max(0, pager.scrollWidth - pager.clientWidth);
    pager.scrollLeft = followPagerScroll(gesture.grabLeft, dx, maxLeft);
  }

  function settlePage(from: DeskSwipeSurface, dx: number, vx: number) {
    const pane = canonicalPane(pager, from);
    const width = pager.clientWidth;
    // The scroll position is the finger. A catch mid-spring measures from the
    // resting page, so dragging back under the threshold can cancel the flip.
    // With no layout yet, the finger delta is the only distance we have.
    if (width > 0) followFinger(dx);
    const displaced = width > 0 ? gesture.restLeft - pager.scrollLeft : dx;
    const chosen = swipeRelease(displaced, vx);
    const next = chosen === 0 ? null : wrapSwipeSurface(from, chosen);
    cancelSettle();
    if (reduceRef.current || width <= 0) {
      trackScroll(false);
      if (next) snapTo(next);
      else if (pane) pager.scrollTo({ left: pane.offsetLeft, top: 0, behavior: 'auto' });
      return;
    }
    const max = Math.max(0, pager.scrollWidth - width);
    const target = Math.min(max, Math.max(0, gesture.restLeft + (chosen * width)));
    gesture.settling = true;
    holding.current = true;
    programmatic.current = true;
    trackScroll(true);
    stopSettle = runSpring(
      false,
      pager.scrollLeft,
      -vx,
      target,
      (left) => {
        pager.scrollLeft = Math.min(max, Math.max(0, left));
      },
      () => {
        gesture.settling = false;
        programmatic.current = true;
        holding.current = true;
        const landed = Math.min(max, Math.max(0, target));
        instantPagerLeft(pager, landed);
        const slot = Math.round(landed / width);
        const spec = DESK_PAGER_SLOTS[slot];
        if (spec?.clone) {
          const canonical = canonicalPane(pager, spec.id);
          if (canonical) instantPagerLeft(pager, canonical.offsetLeft);
        }
        trackScroll(false);
        holding.current = false;
        if (next && next !== currentSurface()) {
          snapTo(next);
          return;
        }
        window.setTimeout(() => {
          programmatic.current = false;
        }, 80);
      },
    );
  }

  function startRefresh() {
    if (gesture.refreshing) return;
    gesture.refreshing = true;
    cancelSettle();
    gesture.pullBase = 0;
    gesture.pullTravelNow = 0;
    paintPull(pager, mark, pullTravel(200), true);
    void onRefresh().finally(() => {
      gesture.refreshing = false;
      if (reduceRef.current) {
        paintPull(pager, mark, 0, false);
        return;
      }
      settlePull(PULL_TRIGGER_PX, 0);
    });
  }

  function onDown(event: PointerEvent) {
    if (gesture.armed) return;
    if (gesture.refreshing) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isCompatMouseSuppressed(event.pointerType, performance.now(), gesture.ignoreMouseUntil)) return;
    const interrupting = gesture.settling;
    cancelSettle();
    if (!interrupting) {
      const pane = canonicalPane(pager, currentSurface());
      gesture.restLeft = pane ? pane.offsetLeft : pager.scrollLeft;
    }
    gesture.grabLeft = pager.scrollLeft;
    gesture.pullBase = pullFingerForTravel(gesture.pullTravelNow);
    gesture.xSamples = [];
    gesture.ySamples = [];
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
    noteSamples(event);
    gesture.armed = true;
    gesture.dragging = false;
    gesture.axis = null;
    gesture.suppressHorizontal = horizontalPageSwipeSuppressed(hit);
    gesture.from = currentSurface();
    holding.current = true;
    gesture.originX = event.clientX;
    gesture.originY = event.clientY;
    gesture.pointerId = event.pointerId;
    gesture.captured = false;
    pager.dataset.swipe = `down:${gesture.from}`;
  }

  function onMove(event: PointerEvent) {
    if (!gesture.armed) return;
    if (gesture.pointerId >= 0 && event.pointerId !== gesture.pointerId) return;
    noteSamples(event);
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
      const travel = pullTravel(gesture.pullBase + dy);
      gesture.pullTravelNow = travel;
      paintPull(pager, mark, travel, false);
      pager.dataset.swipe = `pull:${gesture.from}:${Math.round(travel)}`;
      return;
    }
    if (gesture.axis === 'x') {
      event.preventDefault();
      trackScroll(true);
      followFinger(dx);
      const next = pageSwipeFromDrag(gesture.from, dx, dy);
      pager.dataset.swipe = `move:${gesture.from}:${Math.round(dx)}:${next ?? 'none'}`;
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
        const travel = pullTravel(gesture.pullBase + dy);
        gesture.pullTravelNow = travel;
        paintPull(pager, mark, travel, false);
        pager.dataset.swipe = `pull:${gesture.from}:${Math.round(travel)}`;
        return;
      }
      disarm();
      pager.dataset.swipe = `vertical:${gesture.from}`;
      if (gesture.pullTravelNow > 0) {
        const fromTravel = gesture.pullTravelNow;
        gesture.pullBase = 0;
        settlePull(fromTravel, 0);
      }
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
    trackScroll(true);
    followFinger(dx);
    const next = pageSwipeFromDrag(gesture.from, dx, dy);
    pager.dataset.swipe = `move:${gesture.from}:${Math.round(dx)}:${next ?? 'none'}`;
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
    const now = noteSamples(event);
    const dx = event.clientX - gesture.originX;
    const dy = event.clientY - gesture.originY;
    const vx = releaseVelocity(gesture.xSamples, now);
    const vy = releaseVelocity(gesture.ySamples, now);
    const pulled = gesture.axis === 'y';
    const dragged = gesture.dragging && gesture.axis === 'x';
    const from = gesture.from;
    const until = compatMouseUntil(event.pointerType, performance.now());
    if (until) gesture.ignoreMouseUntil = until;
    disarm();
    if (pulled) {
      const finger = gesture.pullBase + dy;
      const travel = pullTravel(finger);
      gesture.pullTravelNow = travel;
      if (shouldCommitPull(travel)) {
        startRefresh();
        return;
      }
      settlePull(travel, pullReleaseVelocity(finger, vy));
      return;
    }
    if (gesture.pullTravelNow > 0) {
      gesture.pullTravelNow = 0;
      gesture.pullBase = 0;
      paintPull(pager, mark, 0, false);
    }
    if (!dragged) return;
    settlePage(from, dx, vx);
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
    const slot = settledPagerSlot(pager.scrollLeft, width, DESK_PAGER_SLOTS.length);
    if (slot === null) return;
    const spec = DESK_PAGER_SLOTS[slot];
    if (!spec) return;
    // A clone is the wrap neighbor. Rebase to its canonical pane in place —
    // a smooth scroll from this end back across the strip stops on Book.
    if (spec.clone) {
      const pane = canonicalPane(pager, spec.id);
      if (pane) instantPagerLeft(pager, pane.offsetLeft);
    }
    if (spec.id !== currentSurface()) snapTo(spec.id);
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
    cancelSettle();
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
