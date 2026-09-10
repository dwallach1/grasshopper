import { DeskWireSchema, hydratePublicDesk, PUBLIC_DESK_UNAVAILABLE } from '@quantanamo/contracts/desk-snapshot';
import { z } from 'zod';

import { isPublicDesk } from './desk-mode';
import type { DeskPayload } from './ledger-types';

const ErrorSchema = z.object({ error: z.string() }).passthrough();

let inflight: Promise<DeskPayload> | null = null;
let memory: DeskPayload | null = null;

export function cachedDesk(): DeskPayload | null {
  return memory;
}

export function rememberDesk(desk: DeskPayload): void {
  memory = desk;
}

function deskEndpoint(): string {
  return isPublicDesk() ? '/api/desk' : '/api/ledger';
}

/** Never throw a raw JSON.parse SyntaxError for HTML or Cloudflare 1102 pages. */
export function parseDeskResponseText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(PUBLIC_DESK_UNAVAILABLE);
  const start = trimmed[0];
  if (start !== '{' && start !== '[') {
    throw new Error(PUBLIC_DESK_UNAVAILABLE);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(PUBLIC_DESK_UNAVAILABLE);
  }
}

/** Schema-check a wire body and fill omitted arrays. Used by /api/desk fetch. */
export function deskFromWire(body: unknown): DeskPayload {
  const parsed = DeskWireSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Ledger payload failed schema checks');
  }
  // SAFETY: /api/ledger and /api/desk serialize DeskPayload; envelope checked above.
  // hydratePublicDesk fills omitted operator arrays (`tests`, `queue`, …) so
  // TerminalApp can read tests[0] without throwing on a slim snapshot.
  return hydratePublicDesk(parsed.data) as DeskPayload;
}

export async function fetchDeskPayload(): Promise<DeskPayload> {
  if (inflight) return inflight;
  inflight = (async () => {
    const response = await fetch(deskEndpoint(), {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const body = parseDeskResponseText(await response.text());
    if (!response.ok) {
      throw new Error(ErrorSchema.safeParse(body).data?.error || PUBLIC_DESK_UNAVAILABLE);
    }
    const desk = deskFromWire(body);
    memory = desk;
    return desk;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
