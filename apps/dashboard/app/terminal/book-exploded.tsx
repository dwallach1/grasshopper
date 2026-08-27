'use client';

import { useEffect, useState, type ComponentType } from 'react';

import type { BookSlab } from '../../lib/book-slabs';

export type BookExplodedProps = {
  slabs: readonly BookSlab[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * Book-only exploded wireframe. Loads `three` after mount so the blotter
 * paints first. Reduced-motion and WebGL-fail paths render nothing — the
 * table stays canonical.
 */
export function BookExploded(props: BookExplodedProps) {
  const [Scene, setScene] = useState<ComponentType<BookExplodedProps> | null>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!webglAvailable()) return;
    let cancelled = false;
    void import('./book-exploded-scene').then((mod) => {
      if (!cancelled) setScene(() => mod.BookExplodedScene);
    }).catch(() => {
      /* table remains */
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Scene) return null;
  return <Scene {...props} />;
}
