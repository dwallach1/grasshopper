import { z } from 'zod';

import type { DeskPayload } from './ledger-types';

const ErrorSchema = z.object({ error: z.string() }).passthrough();
const DeskWireSchema = z
  .object({
    generated_at: z.string().min(1),
    source: z.enum(['postgres', 'postgrest']),
    theses: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
    book: z.object({
      current_nav: z.number().nullable(),
      starting_nav: z.number().nullable(),
    }).passthrough(),
    routines: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
  })
  .passthrough();

let inflight: Promise<DeskPayload> | null = null;
let memory: DeskPayload | null = null;

export function cachedDesk(): DeskPayload | null {
  return memory;
}

export function rememberDesk(desk: DeskPayload): void {
  memory = desk;
}

export async function fetchDeskPayload(): Promise<DeskPayload> {
  if (inflight) return inflight;
  inflight = (async () => {
    const response = await fetch('/api/ledger', { cache: 'no-store' });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(ErrorSchema.safeParse(body).data?.error || 'Ledger refresh failed');
    }
    const parsed = DeskWireSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('Ledger payload failed schema checks');
    }
    // SAFETY: /api/ledger serializes DeskPayload from loadDesk(); envelope checked above.
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
