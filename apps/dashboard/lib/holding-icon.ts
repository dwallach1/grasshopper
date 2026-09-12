/**
 * Quiet parchment tiles for Book holdings. Code-drawn marks — not loot art,
 * not steward faces. Venue changes the silhouette; letters stay the name.
 */
import type { DeskVenue } from './desk-venue';

export type HoldingIconKind = 'monogram' | 'contract' | 'token';

export type HoldingTilePaint = {
  fill: string;
  ink: string;
  rule: string;
};

const STOCK_TILES: readonly HoldingTilePaint[] = [
  { fill: '#e8edd9', ink: '#3a4634', rule: '#c5cbb4' },
  { fill: '#e7e4d4', ink: '#3d3a2e', rule: '#c8c3ae' },
  { fill: '#e9e8de', ink: '#3a3d38', rule: '#c6c5ba' },
];

const CONTRACT_TILES: readonly HoldingTilePaint[] = [
  { fill: '#e4e6ee', ink: '#353a48', rule: '#c3c6d2' },
  { fill: '#e6e4ea', ink: '#3a3644', rule: '#c5c2cc' },
];

const TOKEN_TILES: readonly HoldingTilePaint[] = [
  { fill: '#eee3d6', ink: '#4a3830', rule: '#d2c2b2' },
  { fill: '#eadfd4', ink: '#46362e', rule: '#d0bbaa' },
];

export function holdingIconKind(venue: DeskVenue): HoldingIconKind {
  if (venue === 'prediction') return 'contract';
  if (venue === 'meme') return 'token';
  return 'monogram';
}

/** 1–4 letter mark from the lot name. Predictions prefer YES/NO. */
export function holdingMonogram(name: string, venue: DeskVenue): string {
  const trimmed = name.trim();
  if (!trimmed) return venue === 'prediction' ? 'YES' : '—';
  if (venue === 'prediction') {
    const side = trimmed.match(/^(YES|NO|Y|N)\b/i)?.[1];
    if (side) return side.length === 1 ? (side.toUpperCase() === 'N' ? 'NO' : 'YES') : side.toUpperCase();
  }
  const token = trimmed.match(/[A-Za-z0-9]{1,4}/);
  return (token?.[0] ?? trimmed.slice(0, 4)).toUpperCase();
}

export function holdingTilePaint(seed: string, venue: DeskVenue): HoldingTilePaint {
  const palette = venue === 'prediction'
    ? CONTRACT_TILES
    : venue === 'meme'
      ? TOKEN_TILES
      : STOCK_TILES;
  let hash = 0;
  for (const char of seed) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] ?? palette[0]!;
}
