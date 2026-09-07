/**
 * Decode steward .riv bytes with the official @rive-app/canvas runtime.
 * Not a fake parser — RiveFile.init() must succeed.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installRiveDomHarness } from './rive-dom-harness';
import {
  STEWARD_RIVE_KINDS,
  STEWARD_RIVE_PLAYS,
  stewardRiveArtboard,
  type StewardRivePlay,
} from './steward-rive';
import type { StewardBotKind } from './desk-avatar';

export const STEWARD_RIV_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/stewards');

export type DecodedStewardRiv = {
  path: string;
  bytes: number;
  fingerprint: string;
  artboard: string;
  animationCount: number;
};

export async function decodeOneStewardRiv(kind: StewardBotKind, play: StewardRivePlay): Promise<DecodedStewardRiv> {
  installRiveDomHarness();
  const { EventType, RiveFile } = await import('@rive-app/canvas');
  const path = join(STEWARD_RIV_DIR, `${kind}_${play}.riv`);
  const bytes = await readFile(path);
  const file = new RiveFile({
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  await new Promise<void>((resolve, reject) => {
    file.on(EventType.Load, () => resolve());
    file.on(EventType.LoadError, (event) => reject(new Error(String(event.data))));
    void file.init();
  });

  const instance = file.getInstance();
  const artboard = instance.defaultArtboard();
  const decoded = {
    path,
    bytes: bytes.byteLength,
    fingerprint: String.fromCharCode(...bytes.subarray(0, 4)),
    artboard: artboard.name,
    animationCount: artboard.animationCount(),
  };
  artboard.delete();
  file.cleanup();
  return decoded;
}

export async function decodeAllStewardRivs(): Promise<DecodedStewardRiv[]> {
  const decoded: DecodedStewardRiv[] = [];
  for (const kind of STEWARD_RIVE_KINDS) {
    for (const play of STEWARD_RIVE_PLAYS) {
      decoded.push(await decodeOneStewardRiv(kind, play));
    }
  }
  return decoded;
}

export function expectedStewardArtboards(): string[] {
  return STEWARD_RIVE_KINDS.flatMap((kind) =>
    STEWARD_RIVE_PLAYS.map((play) => stewardRiveArtboard(kind, play)),
  );
}
