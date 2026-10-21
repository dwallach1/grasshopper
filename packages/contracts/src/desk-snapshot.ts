import * as z from 'zod';

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
  'adm',
  'argument',
  'asserted',
  'between',
  'blob',
  'blue collar',
  'bnf',
  'cas',
  'cdc',
  'closes',
  'commit',
  'conflict',
  'contracted',
  'dag',
  'decimal',
  'df',
  'dht',
  'do',
  'done',
  'drbd',
  'dsa',
  'dsv',
  'et',
  'excellent',
  'excellent take',
  'expected',
  'fetch',
  'filing',
  'first',
  'future',
  'fy26 results',
  'gfs',
  'glm',
  'gossip',
  'gw',
  'gwa',
  'holdings',
  'hugeint',
  'insider-filings',
  'ipc',
  'iq',
  'iso',
  'it',
  'jit',
  'jvm',
  'kl',
  'listen',
  'llvm',
  'lock',
  'lr',
  'market',
  'mp',
  'ms',
  'nbis excellent',
  'ne',
  'nearly',
  'nfs',
  'oss',
  'possible',
  'pre',
  'prepare',
  'ptl',
  'push',
  'quality',
  'race',
  'raise',
  'reasons',
  'rebase',
  'ref',
  'refetch',
  'reiterating',
  'relentless',
  'remains',
  'replicate',
  'report',
  'reporting',
  'reports',
  'requested',
  'requested features',
  'requests',
  'retained',
  'retry',
  'review',
  'rosenblatt',
  'rto',
  'scary',
  'september',
  'serve',
  'setup',
  'sf',
  'sha',
  'simd',
  'snp',
  'sre',
  'sweep',
  'thesis-linked',
  'tinyint',
  'tj',
  'tls',
  'tpch',
  'trillion',
  'txn',
  'uk',
  'upload',
  'verification',
  'vm',
  'voting',
  'window',
  'without',
  'zone',
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

export type OntologyJunkOptions = {
  /** The ledger says this membership label is a verified listed equity (`ontology_candidates.listed_equity`). */
  listedEquity?: boolean | null;
  /** Upper-case tickers from `public.listed_equities` (active rows). */
  listedEquities?: ReadonlySet<string>;
};

/**
 * URL fragments, space-joined ticker mashups, and documented stop labels. Does not invent a score.
 * The stop labels are words. A membership label that is a verified listed equity is a ticker,
 * not a word, so it is never junk here; review decides on context. Same rule as SQL.
 */
export function isJunkOntologyLabel(
  label: unknown,
  candidateType?: unknown,
  options: OntologyJunkOptions = {},
): boolean {
  const normalized = normalizeOntologyLabel(label);
  if (!normalized) return true;
  if (String(candidateType ?? '').toLowerCase() === 'membership') {
    const ticker = normalized.toUpperCase();
    if (options.listedEquity === true || options.listedEquities?.has(ticker)) return false;
  }
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
    .filter((row) => !isJunkOntologyLabel(row.proposed_label, row.candidate_type, {
      listedEquity: row.listed_equity === true,
    }))
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
  'lesson_waits',
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
  scorecard: ['stewards', 'weekly', 'trend', 'theses', 'forecast', 'gates'],
} as const;

const EMPTY_COUNTS = {
  sources: 0,
  symbols: 0,
  open_research: 0,
  tests_killed: 0,
  tests_survived: 0,
  tests_retired: 0,
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
  { source: '/books', destination: '/book' },
  { source: '/theses', destination: '/book' },
  { source: '/ontology', destination: '/book' },
  { source: '/risk', destination: '/book' },
  { source: '/runs', destination: '/book' },
  { source: '/learnings', destination: '/book' },
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

const STRATEGY_TEST_HIDDEN = new Set(['placeholder', 'lookahead_invalid']);
const PUBLIC_TEST_KEYS = ['id', 'cycle_id', 'variant_label', 'status', 'failure_reason', 'result', 'per_trade', 'book'] as const;
const PUBLIC_PER_TRADE_KEYS = ['n', 'unit', 'mean', 'ci90', 'hit', 'hit_other'] as const;
/** Cycle hypothesis and preregistered outcome on the phone. */
export const PUBLIC_CYCLE_NOTE_CHARS = 160;

function isSnapshotRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clipSnapshotNote(value: unknown, max = PUBLIC_CYCLE_NOTE_CHARS): unknown {
  if (typeof value !== 'string' || value.length <= max) return value;
  return value.slice(0, max);
}

function publishPerTrade(value: unknown): Record<string, unknown> | null {
  if (!isSnapshotRecord(value)) return null;
  const next: Record<string, unknown> = {};
  for (const key of PUBLIC_PER_TRADE_KEYS) {
    const item = value[key];
    if (item === undefined || item === null) continue;
    next[key] = item;
  }
  return Object.keys(next).length ? next : null;
}

function publishTests(rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!isSnapshotRecord(row) || STRATEGY_TEST_HIDDEN.has(String(row.status ?? ''))) continue;
    const next: Record<string, unknown> = {};
    for (const key of PUBLIC_TEST_KEYS) {
      const value = key === 'per_trade' ? publishPerTrade(row[key]) : row[key];
      if (value === undefined || value === null || value === '') continue;
      next[key] = value;
    }
    if (typeof next.id !== 'number' && typeof next.id !== 'string') continue;
    out.push(next);
  }
  return out;
}

function publishCycles(rows: unknown, cycleIds: Set<number>): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!isSnapshotRecord(row) || !cycleIds.has(Number(row.id))) continue;
    out.push({
      id: row.id,
      thesis_id: row.thesis_id,
      stage: row.stage,
      status: row.status,
      market_regime: row.market_regime ?? null,
      hypothesis: clipSnapshotNote(row.hypothesis) ?? '',
      preregistered_outcome: clipSnapshotNote(row.preregistered_outcome) ?? '',
    });
  }
  return out;
}

function publishScenarios(rows: unknown, testIds: Set<number>): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> =>
    isSnapshotRecord(row) && testIds.has(Number(row.test_id)),
  );
}

/**
 * Mark a live desk payload as the public snapshot. Strips operator-only audit
 * *rows* so GET /api/desk stays JSON-healthy under Worker CPU, then puts empty
 * arrays back so the phone client can index `tests[0]`. Book / Board / Team
 * keep `prediction_markets`, `meme_coins`, `team`, theses, beliefs, lessons,
 * pending ontology candidates, the book, and the slim strategy-test result
 * (name, status, measured line, per-trade stats; cycles and scenarios only
 * for those tests). Curves, charts, price lists, params, and blotters stay off.
 * Never invent marks.
 */
export function toPublicDeskSnapshot(desk: DeskWire): DeskWire {
  const slim: Record<string, unknown> = { source: 'snapshot' };
  const source = desk as Record<string, unknown>;
  for (const [key, value] of Object.entries(desk)) {
    if (key === 'source' || PUBLIC_OMIT.has(key)) continue;
    slim[key] = key === 'ontology_candidates' ? publicPendingCandidates(value) : value;
  }
  if (Array.isArray(source.tests)) {
    const tests = publishTests(source.tests);
    const testIds = new Set(tests.map((row) => Number(row.id)));
    const cycleIds = new Set(tests.map((row) => Number(row.cycle_id)).filter((id) => Number.isFinite(id)));
    const scenarios = publishScenarios(source.scenarios, testIds);
    slim.tests = tests;
    slim.cycles = publishCycles(source.cycles, cycleIds);
    slim.scenarios = scenarios;
    slim.backtest_artifacts = [];
    if (isSnapshotRecord(slim.counts)) {
      let tests_survived = 0;
      let tests_killed = 0;
      let tests_retired = 0;
      let tests_queued = 0;
      for (const row of tests) {
        if (row.status === 'survived') tests_survived += 1;
        else if (row.status === 'killed') tests_killed += 1;
        else if (row.status === 'retired') tests_retired += 1;
        else if (row.status === 'queued') tests_queued += 1;
      }
      slim.counts = {
        ...slim.counts,
        tests_survived,
        tests_killed,
        tests_retired,
        tests_queued,
        scenario_cells: scenarios.length,
      };
    }
  }
  return hydratePublicDesk(slim as DeskWire);
}
