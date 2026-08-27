import { z } from 'zod';

import type { DeskPayload } from './ledger-types';
import { createBrowserSupabase } from './supabase-browser';

const ErrorSchema = z.object({ error: z.string() }).passthrough();
const DeskWireSchema = z
  .object({
    generated_at: z.string().min(1),
    source: z.enum(['postgres', 'postgrest']),
    theses: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
    book: z.object({
      current_nav: z.number().nullable(),
      starting_nav: z.number().nullable(),
      observed_at: z.string().nullable(),
    }).passthrough(),
    routines: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
  })
  .passthrough();

const LEDGER_WATCH = [
  'portfolio_exposure',
  'account_snapshots',
  'trade_intents',
  'trade_proposals',
  'thesis_symbols',
  'broker_fills',
  'theses',
] as const;

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

/** Refetch when QUANTANAMO writes a new snapshot. Polling remains the fallback. */
export function subscribeDeskRefresh(onChange: () => void): () => void {
  const supabase = createBrowserSupabase();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bounce = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(onChange, 400);
  };
  let channel = supabase.channel('desk-ledger');
  for (const table of LEDGER_WATCH) {
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, bounce);
  }
  void channel.subscribe();
  return () => {
    if (timer !== null) clearTimeout(timer);
    void supabase.removeChannel(channel);
  };
}
