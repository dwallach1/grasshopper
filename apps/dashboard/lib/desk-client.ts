import { DeskWireSchema } from '@quantanamo/contracts/desk-snapshot';
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

export async function fetchDeskPayload(): Promise<DeskPayload> {
  if (inflight) return inflight;
  inflight = (async () => {
    const response = await fetch(deskEndpoint(), { cache: 'no-store' });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(ErrorSchema.safeParse(body).data?.error || 'Ledger refresh failed');
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
