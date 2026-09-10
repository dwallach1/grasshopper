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
export const LIVE_JSON_CACHE_CONTROL = 'public, max-age=0, s-maxage=15, stale-while-revalidate=45';

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

/** Array fields the phone desk indexes (`tests[0]`, `.filter`, `.map`). Missing → []. */
export const DESK_ARRAY_KEYS = [
  'theses',
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
  'snapshots',
  'positions',
  'exposures',
  'intents',
  'proposals',
  'fills',
  'fill_log',
  'insights',
  'predictions',
  'risk_controls',
  'routines',
  'ontology_themes',
  'ontology_symbols',
  'ontology_candidates',
  'ontology_actions',
] as const;

const NESTED_ARRAYS = {
  prediction_markets: ['markets', 'positions', 'orders', 'fills', 'pnl', 'notes'],
  meme_coins: ['tokens', 'positions', 'orders', 'fills', 'pnl', 'notes'],
  team: ['agents', 'domains', 'stewards', 'accounts'],
} as const;

const EMPTY_COUNTS = {
  sources: 0,
  symbols: 0,
  open_research: 0,
  tests_killed: 0,
  tests_survived: 0,
  scenario_cells: 0,
  open_positions: 0,
  queued_tasks: 0,
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
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
 * Fill missing desk arrays so `tests[0]` / `.map` cannot throw. Does not invent
 * marks — empty list means "not in this public envelope", not a fake row.
 */
export function hydratePublicDesk(desk: DeskWire): DeskWire {
  const out: Record<string, unknown> = { ...desk };
  for (const key of DESK_ARRAY_KEYS) {
    out[key] = asArray(out[key]);
  }
  if (Array.isArray(out.theses)) {
    out.theses = out.theses.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const item = row as Record<string, unknown>;
      return {
        ...item,
        symbols: asArray(item.symbols),
        lots: asArray(item.lots),
      };
    });
  }
  for (const [field, keys] of Object.entries(NESTED_ARRAYS)) {
    const raw = out[field];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const nested: Record<string, unknown> = { ...raw };
    for (const key of keys) nested[key] = asArray(nested[key]);
    out[field] = nested;
  }
  if (out.book && typeof out.book === 'object' && !Array.isArray(out.book)) {
    const book: Record<string, unknown> = { ...out.book };
    book.names = asArray(book.names);
    out.book = book;
  }
  if (!out.counts || typeof out.counts !== 'object' || Array.isArray(out.counts)) {
    out.counts = { ...EMPTY_COUNTS };
  }
  return out as DeskWire;
}

/**
 * Mark a live desk payload as the public snapshot. Strips operator-only audit
 * *rows* so GET /api/desk stays JSON-healthy under Worker CPU, then puts empty
 * arrays back so the phone client can index `tests[0]`. Book / Board / Team
 * keep `prediction_markets`, `meme_coins`, `team`, theses, and the book.
 * Never invent marks.
 */
export function toPublicDeskSnapshot(desk: DeskWire): DeskWire {
  const slim: Record<string, unknown> = { source: 'snapshot' };
  for (const [key, value] of Object.entries(desk)) {
    if (key === 'source' || PUBLIC_OMIT.has(key)) continue;
    slim[key] = value;
  }
  return hydratePublicDesk(slim as DeskWire);
}
