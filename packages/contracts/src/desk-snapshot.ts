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
/** Phone poll and Worker live cache. Origin → Supabase is not more frequent than this. */
export const PUBLIC_LIVE_INTERVAL_MS = 45_000;
export const LIVE_JSON_CACHE_CONTROL =
  `public, max-age=0, s-maxage=${PUBLIC_LIVE_INTERVAL_MS / 1000}, stale-while-revalidate=${(PUBLIC_LIVE_INTERVAL_MS / 1000) * 2}`;

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
  'ontology_actions',
  'proposals',
]);

export const PUBLIC_CANDIDATE_CAP = 40;
/**
 * Pending fetch window before ranking. Must stay ≥ cap so memberships are not
 * crowded out. Public `/bundle/public` uses this; the operator bundle stays wider.
 */
export const PUBLIC_CANDIDATE_FETCH = 72;

/**
 * Arrays the Theses learning pulse reads. Public slim must keep them so the
 * phone can count To-review / lessons / beliefs / tagged lots without inventing
 * a second payload. Nested `prediction_markets.positions`, `meme_coins.positions`,
 * and `book.names` stay too (not in PUBLIC_OMIT).
 */
export const LEARNING_PULSE_KEYS = [
  'beliefs',
  'lessons',
  'ontology_candidates',
  'positions',
] as const;

/** Exact normalized labels that are not ontology. Keep in sync with `private.ontology_label_is_junk`. */
export const ONTOLOGY_JUNK_LABELS = [
  'http',
  'https',
  'www',
  't.co',
  'url',
  'stock',
  'stocks',
  'price',
  'results',
  'popular',
  'by',
  'in',
  'from',
  'where',
  'select',
  'order',
  'bigint',
  'smallint',
  'integer',
  'int',
  'varchar',
  'timestamp',
  'timestamptz',
  'date',
  'double',
  'float',
  'numeric',
  'boolean',
  'bool',
  'json',
  'jsonb',
  'uuid',
  'null',
  'true',
  'false',
  'create',
  'drop',
  'alter',
  'insert',
  'update',
  'delete',
  'table',
  'column',
  'schema',
  'sql',
  'postgres',
  'limit',
  'offset',
  'group',
  'having',
  'values',
  'join',
  'arr',
  'pt',
  'cpu',
  'mw',
  'llc',
  'another',
  'files',
  'github',
  'latest',
  'trending',
  'featured',
  'related',
  'headlines',
  'overview',
  'introduction',
  'conclusion',
  'contents',
  'since',
  'literally',
  'called',
  'ultimately',
  'next week',
  'names',
  'invest',
  'leader',
  'rallied',
  'fastest',
  'gonna',
  'provide',
  'hours',
  'online',
  'performers',
  'clusters',
  'crowded',
  'awaited',
  'awaited quarters',
  'logo link',
  'confirmed',
  'exploring',
  'extract',
  'brand',
  'breaking',
  'bucket',
  'department',
  'cities',
  'further',
  'directly',
  'phase',
  'value',
  'moves',
  'collapse',
  'chain',
  'think',
  'right',
  'philip',
  'models',
  'model',
  'earnings',
  'infrastructure',
  'customers',
  'bottle',
  'captcha',
  'saml',
  'sso',
  'scim',
  'php',
  'js',
  'sla',
  'sq',
  'rpm',
  'cof',
  'mcc',
  'msa',
  'blue',
  'mktp',
  'cpto',
  'rag',
  'jdbc',
  'odbc',
  'olap',
  'etl',
  'ast',
  'tpc',
  'adbc',
  'bi',
  'kb',
  'mt',
  'gt',
  'mvcc',
  'cwi',
  'gqa',
  'sota',
  'zdr',
  'ptq',
  'cuda',
  'skhy',
] as const;

const ONTOLOGY_URL_LABEL_RE = /(^| )(http|https|www|t\.co)( |$)/;
/** Two+ 2–5 letter tokens separated by spaces (`avgo cien`). Same as SQL. Not a score. */
const ONTOLOGY_TICKER_MASHUP_RE = /^[a-z]{2,5}( [a-z]{2,5})+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeOntologyLabel(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** URL fragments, space-joined ticker mashups, and documented stop labels. Does not invent a score. */
export function isJunkOntologyLabel(label: unknown, _candidateType?: unknown): boolean {
  const normalized = normalizeOntologyLabel(label);
  if (!normalized) return true;
  if (ONTOLOGY_URL_LABEL_RE.test(normalized)) return true;
  if (ONTOLOGY_TICKER_MASHUP_RE.test(normalized)) return true;
  return (ONTOLOGY_JUNK_LABELS as readonly string[]).includes(normalized);
}

/** Membership, then theme bound to an existing theme id, then terms, then unbound theme clusters. */
export function ontologyReviewTypeRank(row: Record<string, unknown>): number {
  const type = String(row.candidate_type ?? '');
  if (type === 'membership') return 0;
  if (type === 'theme' && String(row.proposed_theme_id ?? '').trim()) return 1;
  if (type === 'theme') return 3;
  return 2;
}

function ontologyReviewKey(row: Record<string, unknown>): string {
  return `${row.candidate_type ?? ''}:${normalizeOntologyLabel(row.proposed_label)}`;
}

function compareOntologyReviewRows(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const type = ontologyReviewTypeRank(left) - ontologyReviewTypeRank(right);
  if (type !== 0) return type;
  const score = Number(right.score ?? 0) - Number(left.score ?? 0);
  if (score !== 0) return score;
  const sources = Number(right.source_count ?? 0) - Number(left.source_count ?? 0);
  if (sources !== 0) return sources;
  return Number(right.id ?? 0) - Number(left.id ?? 0);
}

/**
 * Pending only. Drops deny-list junk and already-rejected labels in the same
 * payload, then membership / real theme before terms. Ledger score is unchanged.
 */
export function publicPendingCandidates(rows: unknown, cap = PUBLIC_CANDIDATE_CAP): unknown[] {
  if (!Array.isArray(rows)) return [];
  const records = rows.filter(isRecord);
  const rejected = new Set(
    records
      .filter((row) => row.status === 'rejected')
      .map((row) => ontologyReviewKey(row)),
  );
  return records
    .filter((row) => row.status === 'pending')
    .filter((row) => !isJunkOntologyLabel(row.proposed_label, row.candidate_type))
    .filter((row) => !rejected.has(ontologyReviewKey(row)))
    .slice()
    .sort(compareOntologyReviewRows)
    .slice(0, Math.max(0, cap));
}

/** Array fields the phone desk indexes (`tests[0]`, `.filter`, `.map`). Missing → []. */
export const DESK_ARRAY_KEYS = [
  'theses',
  'beliefs',
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
 * keep `prediction_markets`, `meme_coins`, `team`, theses, beliefs, lessons,
 * pending ontology candidates, and the book. Never invent marks.
 */
export function toPublicDeskSnapshot(desk: DeskWire): DeskWire {
  const slim: Record<string, unknown> = { source: 'snapshot' };
  for (const [key, value] of Object.entries(desk)) {
    if (key === 'source' || PUBLIC_OMIT.has(key)) continue;
    slim[key] = key === 'ontology_candidates' ? publicPendingCandidates(value) : value;
  }
  return hydratePublicDesk(slim as DeskWire);
}
