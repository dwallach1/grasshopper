/**
 * Decode steward .riv bytes with the official @rive-app/canvas runtime.
 * Not a fake parser — RiveFile.init() must succeed.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installRiveDomHarness } from './rive-dom-harness';
import { stewardRiveArtboards } from './steward-rive';

export const STEWARD_RIV_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../public/stewards/stewards.riv',
);

export type DecodedStewardRiv = {
  bytes: number;
  fingerprint: string;
  artboardCount: number;
  artboards: string[];
  animationsPerArtboard: number[];
};

export async function decodeStewardRiv(path = STEWARD_RIV_PATH): Promise<DecodedStewardRiv> {
  installRiveDomHarness();
  const { EventType, RiveFile } = await import('@rive-app/canvas');
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
  const artboardCount = instance.artboardCount();
  const artboards: string[] = [];
  const animationsPerArtboard: number[] = [];
  for (let i = 0; i < artboardCount; i += 1) {
    const artboard = instance.artboardByIndex(i);
    artboards.push(artboard.name);
    animationsPerArtboard.push(artboard.animationCount());
    artboard.delete();
  }
  file.cleanup();

  return {
    bytes: bytes.byteLength,
    fingerprint: String.fromCharCode(...bytes.subarray(0, 4)),
    artboardCount,
    artboards,
    animationsPerArtboard,
  };
}

export function expectedStewardArtboards(): string[] {
  return stewardRiveArtboards();
}
