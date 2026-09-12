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
  { fill: '#d5debf', ink: '#2f3a2a', rule: '#b4be9a' },
  { fill: '#ddd6be', ink: '#3a3426', rule: '#c0b89a' },
  { fill: '#d8d6c8', ink: '#33362f', rule: '#b7b5a6' },
];

const CONTRACT_TILES: readonly HoldingTilePaint[] = [
  { fill: '#cfd4e4', ink: '#2c3140', rule: '#a8adbf' },
  { fill: '#d4d0de', ink: '#322e3c', rule: '#b0abbc' },
];

const TOKEN_TILES: readonly HoldingTilePaint[] = [
  { fill: '#e4c9b0', ink: '#3f2d24', rule: '#c4a88e' },
  { fill: '#e0c4b4', ink: '#3c2a24', rule: '#c2a090' },
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
