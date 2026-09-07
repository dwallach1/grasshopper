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

export type StewardFigureSample = {
  artboard: string;
  durationSec: number;
  y0: number;
  yMid: number;
  scaleX0: number;
  scaleXMid: number;
};

/** Apply the first clip in the official runtime and sample the Figure node. */
export async function sampleStewardFigure(
  kind: StewardBotKind,
  play: StewardRivePlay,
): Promise<StewardFigureSample> {
  installRiveDomHarness();
  const { RuntimeLoader } = await import('@rive-app/canvas');
  const runtime = await RuntimeLoader.awaitInstance();
  const path = join(STEWARD_RIV_DIR, `${kind}_${play}.riv`);
  const bytes = await readFile(path);
  const file = await runtime.load(new Uint8Array(bytes));
  const artboard = file.defaultArtboard();
  const anim = artboard.animationByIndex(0);
  const timed = anim as typeof anim & { duration: number; fps: number };
  const clip = new runtime.LinearAnimationInstance(anim, artboard);
  const figure = artboard.node('Figure');
  if (!figure) throw new Error(`missing Figure on ${artboard.name}`);
  const durationSec = timed.duration / timed.fps;
  clip.time = 0;
  clip.apply(1);
  artboard.advance(0);
  const y0 = figure.y;
  const scaleX0 = figure.scaleX;
  clip.advance(durationSec / 2);
  clip.apply(1);
  artboard.advance(0);
  const sampled = {
    artboard: artboard.name,
    durationSec,
    y0,
    yMid: figure.y,
    scaleX0,
    scaleXMid: figure.scaleX,
  };
  clip.delete();
  artboard.delete();
  return sampled;
}
