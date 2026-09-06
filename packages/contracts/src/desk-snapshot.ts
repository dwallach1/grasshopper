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

export const PUBLIC_DESK_UNAVAILABLE = 'Desk snapshot unavailable';
export const SNAPSHOT_KV_KEY = 'current';
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** Old desk URLs the public Worker 302s so phones do not land on empty chrome. */
export const PUBLIC_DESK_REDIRECTS = [
  { source: '/leaderboard', destination: '/' },
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

/** Public site only serves curated snapshots — never a live postgres/postgrest envelope. */
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
 * rows. `prediction_markets` (ODDSBORNE `pm_*`), `meme_coins` (BANDIT `meme_*`),
 * and `team` (desk_agents) pass through when present. Never invent marks.
 */
export function toPublicDeskSnapshot(desk: DeskWire): DeskWire {
  const {
    ontology_actions: _ontologyActions,
    ...rest
  } = desk;
  return {
    ...rest,
    source: 'snapshot',
    ontology_actions: [],
  };
}
