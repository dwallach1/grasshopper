/**
 * @rive-app/canvas WASM boots against a document. Tests and the generator
 * decode path use happy-dom so the official runtime can load .riv bytes in Bun.
 */
import { Window } from 'happy-dom';

let installed = false;

export function installRiveDomHarness(): void {
  if (installed) return;
  const happy = new Window({ url: 'http://127.0.0.1/' });
  Object.assign(globalThis, {
    window: happy,
    document: happy.document,
    HTMLCanvasElement: happy.HTMLCanvasElement,
    HTMLElement: happy.HTMLElement,
    Image: happy.Image,
  });
  installed = true;
}
