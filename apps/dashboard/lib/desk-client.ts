import { DeskWireSchema, PUBLIC_DESK_UNAVAILABLE } from '@quantanamo/contracts/desk-snapshot';
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
    const parsed = DeskWireSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('Ledger payload failed schema checks');
    }
    // SAFETY: /api/ledger and /api/desk serialize DeskPayload; envelope checked above.
    const desk = parsed.data as DeskPayload;
    memory = desk;
    return desk;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
