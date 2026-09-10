import { z } from 'zod';

/** Envelope the public Worker and local `/api/desk` accept. Extra keys pass through. */
export const DeskSourceSchema = z.enum(['postgres', 'postgrest', 'snapshot']);

export const DeskWireSchema = z
  .object({
    generated_at: z.string().min(1),
    source: DeskSourceSchema,
    theses: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
    book: z
      .object({
        current_nav: z.number().nullable(),
        starting_nav: z.number().nullable(),
        observed_at: z.string().nullable(),
      })
      .passthrough(),
    routines: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
  })
  .passthrough();

export type DeskWire = z.infer<typeof DeskWireSchema>;

export const PUBLIC_DESK_UNAVAILABLE = 'Desk ledger unavailable';
export const PUBLIC_DESK_REFRESH_FAILED = 'Showing last good ledger — live read failed';
export const LIVE_JSON_CACHE_CONTROL = 'public, max-age=0, s-maxage=8, stale-while-revalidate=30';

const PUBLIC_OMIT = new Set([
  'evidence',
  'scores',
  'relations',
  'runs',
  'cloud_runs',
  'cloud_tasks',
  'automations',
  'catalysts',
  'queue',
  'lessons',
  'postmortems',
  'cycles',
  'tests',
  'backtest_artifacts',
  'scenarios',
  'agent_runs',
  'insights',
  'predictions',
  'risk_controls',
  'ontology_symbols',
  'ontology_candidates',
  'ontology_actions',
  'proposals',
]);
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** PostgREST JWT `role` claim for the public Worker. SELECT only. */
export const DESK_PUBLIC_READER_ROLE = 'desk_public_reader';

/** Old desk URLs the public Worker 302s so phones do not land on empty chrome. */
export const PUBLIC_DESK_REDIRECTS = [
  { source: '/leaderboard', destination: '/' },
  { source: '/board', destination: '/' },
  { source: '/ranks', destination: '/' },
  { source: '/catalysts', destination: '/events' },
  { source: '/ontology', destination: '/theses' },
  { source: '/risk', destination: '/book' },
  { source: '/runs', destination: '/book' },
  { source: '/learnings', destination: '/theses' },
  { source: '/mates', destination: '/team' },
] as const;

export function parseDeskWire(value: unknown): DeskWire {
  return DeskWireSchema.parse(value);
}

export function isDeskWire(value: unknown): value is DeskWire {
  return DeskWireSchema.safeParse(value).success;
}

/** Public site serves a curated envelope. Live PostgREST reads are sanitized to `source=snapshot`. */
export function isPublicSnapshot(value: unknown): value is DeskWire {
  const parsed = DeskWireSchema.safeParse(value);
  return parsed.success && parsed.data.source === 'snapshot';
}

const PUBLIC_ERROR_MESSAGES = new Set([
  PUBLIC_DESK_UNAVAILABLE,
  'Not found',
  'Method not allowed',
]);

export function publicDeskJsonError(message = PUBLIC_DESK_UNAVAILABLE): { error: string } {
  return { error: PUBLIC_ERROR_MESSAGES.has(message) ? message : PUBLIC_DESK_UNAVAILABLE };
}

/**
 * Mark a live desk payload as the public snapshot. Drops operator-only audit
 * rows so GET /api/desk stays JSON-healthy under Worker CPU. Book / Board /
 * Team keep `prediction_markets`, `meme_coins`, `team`, theses, and the book.
 * Never invent marks.
 */
export function toPublicDeskSnapshot(desk: DeskWire): DeskWire {
  const slim: Record<string, unknown> = { source: 'snapshot' };
  for (const [key, value] of Object.entries(desk)) {
    if (key === 'source' || PUBLIC_OMIT.has(key)) continue;
    slim[key] = value;
  }
  slim.ontology_actions = [];
  return slim as DeskWire;
}
