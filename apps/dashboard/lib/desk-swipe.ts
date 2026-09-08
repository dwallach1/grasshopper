/**
 * Board / Book / Team are one horizontal deck. Labels are an indicator.
 * Reduced motion snaps with no travel animation.
 */
import {
  DESK_SWIPE_SURFACES,
  tabForSurface,
  type DeskSurface,
  type DeskSwipeSurface,
} from './desk-nav';

export function isSwipeSurface(id: string): id is DeskSwipeSurface {
  for (const surface of DESK_SWIPE_SURFACES) {
    if (surface === id) return true;
  }
  return false;
}

export function swipeSurfaceIndex(id: DeskSurface): number {
  let index = 0;
  for (const surface of DESK_SWIPE_SURFACES) {
    if (surface === id) return index;
    index += 1;
  }
  return -1;
}

export function swipeSurfaceAt(index: number): DeskSwipeSurface | null {
  return DESK_SWIPE_SURFACES[index] ?? null;
}

export function pagerScrollBehavior(reduceMotion: boolean): ScrollBehavior {
  return reduceMotion ? 'auto' : 'smooth';
}

export function swipeTabLabel(id: DeskSwipeSurface): string {
  return tabForSurface(id).label;
}
