/**
 * Shared names for the generated steward .riv and the official @rive-app runtime.
 * Artboard names are KIND_mood because rive-generator linear-animation names
 * do not round-trip through @rive-app/canvas — each artboard has one default clip.
 */
import type { StewardBotKind, StewardMood } from './desk-avatar';

export const RIVE_WASM_SRC = '/rive/rive.wasm';

/** @rive-app remaps KeyedObject.objectId from the artboard, not the file. */
export function riveKeyedObjectId(artboardId: number, targetId: number): number {
  return targetId - artboardId;
}

/** One artboard per file; KeyedObject ids are artboard-relative. */
export function stewardRiveSrc(kind: StewardBotKind, play: StewardRivePlay): string {
  return `/stewards/${kind}_${play}.riv`;
}

export const STEWARD_RIVE_PLAYS = ['still', 'idle', 'up', 'down', 'alive'] as const;
export type StewardRivePlay = (typeof STEWARD_RIVE_PLAYS)[number];

export const STEWARD_RIVE_KINDS: StewardBotKind[] = [
  'quantanamo',
  'oddsborne',
  'bandit',
  'grasshopper',
  'spark',
];

export function stewardRivePlay(
  mood: StewardMood,
  alive: boolean,
  reducedMotion: boolean,
): StewardRivePlay {
  if (reducedMotion) return 'still';
  if (alive && mood === 'idle') return 'alive';
  return mood;
}

export function stewardRiveArtboard(kind: StewardBotKind, play: StewardRivePlay): string {
  return `${kind.toUpperCase()}_${play}`;
}

export function stewardRiveArtboards(): string[] {
  return STEWARD_RIVE_KINDS.flatMap((kind) =>
    STEWARD_RIVE_PLAYS.map((play) => stewardRiveArtboard(kind, play)),
  );
}
