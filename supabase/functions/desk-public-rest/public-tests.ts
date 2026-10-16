/**
 * Public phone projection of strategy tests.
 *
 * The stored `total_return` is a compounded book (overlapping holds, often
 * more than 100% deployed). The phone leads with the per-trade measurement
 * in the summary, and may add the book only as a labeled second line.
 * Curves, price-source lists, charts, parameter bags, blotters, and storage
 * paths stay off `/bundle/public`.
 */

export const STRATEGY_TEST_NON_RESULTS = ['placeholder', 'lookahead_invalid'] as const;

/** Notes on the public wire (cycle text, not the raw autopsy). */
export const PUBLIC_NOTE_CHARS = 160;

/**
 * Columns the public bundle selects. Scalar summary paths only — never the
 * whole `payload_json` (that document is the events blotter, ~500 KB).
 */
export const PUBLIC_TEST_COLUMNS = 'id,external_key,cycle_id,variant_label,status,tested_at,window_start,window_end';

export const PUBLIC_SUMMARY_COLUMNS = [
  'id',
  'test_id',
  'mean_diff:payload_json->mean_diff_a_minus_b',
  'ci_diff:payload_json->bootstrap90_diff',
  'hit_a:payload_json->hit_a',
  'hit_b:payload_json->hit_b',
  'trade_count:payload_json->trade_count',
  'n:payload_json->n',
  'n_trades:payload_json->n_trades',
  'hit_rate:payload_json->hit_rate',
  'hit:payload_json->hit',
  'mean30:payload_json->mean30',
  'ci90:payload_json->ci90',
  'mean_net:payload_json->mean_net_ret_per_trade',
  'chase60:payload_json->chase_mean60',
  'ci90_60:payload_json->ci90_60',
  'chase_hit:payload_json->chase_hit60',
  'book_a:payload_json->total_return_a_book',
  'book:payload_json->total_return_book',
  'spy_a:payload_json->spy_same_dates_book',
  'spy_same:payload_json->spy_book_same_dates',
  'spy_open:payload_json->spy_open_to_close_book',
  'mean10:payload_json->by_cost->10->mean_net_pct',
  'n10:payload_json->by_cost->10->n',
  'win10:payload_json->by_cost->10->win',
  'regime_mean:payload_json->regime->mean',
  'regime_n:payload_json->regime->n',
  'other_mean:payload_json->non_regime->mean',
  'other_n:payload_json->non_regime->n',
  'regime_diff:payload_json->regime_minus_non_regime_mean_net',
  'regime_ci:payload_json->diff_bootstrap_90ci',
].join(',');

export const PUBLIC_TEST_QUERY = `strategy_tests?select=${PUBLIC_TEST_COLUMNS}&order=tested_at.desc.nullslast,id.desc`;
export const PUBLIC_SUMMARY_QUERY = `backtest_artifacts?select=${PUBLIC_SUMMARY_COLUMNS}&artifact_kind=eq.summary_json&order=id.desc`;

const STATUS_RANK: Record<string, number> = { survived: 0, killed: 1, queued: 2 };

export type PerTradeStats = {
  n: number | null;
  /** `pts` is a gap in percentage points. `percent` is a return per trade. Null when the unit is unknown. */
  unit: 'pts' | 'percent' | null;
  mean: number | null;
  ci90: [number, number] | null;
  hit: number | null;
  hit_other: number | null;
};

export type MeasuredTest = {
  result: string | null;
  per_trade: PerTradeStats | null;
  book: string | null;
};

export type MeasureContext = {
  variant?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  compared?: string | null;
};

export function strategyTestCounts(rows: readonly { status?: unknown }[]): {
  tests_survived: number;
  tests_killed: number;
  tests_queued: number;
} {
  let tests_survived = 0;
  let tests_killed = 0;
  let tests_queued = 0;
  for (const row of rows) {
    if (row.status === 'survived') tests_survived += 1;
    else if (row.status === 'killed') tests_killed += 1;
    else if (row.status === 'queued') tests_queued += 1;
  }
  return { tests_survived, tests_killed, tests_queued };
}

export function isPublicStrategyTest(row: { status?: unknown }): boolean {
  return row.status !== 'placeholder' && row.status !== 'lookahead_invalid';
}

export function testStatusText(status: string): string {
  if (status === 'survived') return 'passed';
  if (status === 'killed') return 'failed';
  if (status === 'queued') return 'still queued';
  return status.replaceAll('_', ' ');
}

export function clipPublicNote(value: unknown, max = PUBLIC_NOTE_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

export function testsForThesis<T extends { id: number; cycle_id: number; status: string; tested_at?: string }>(
  thesisId: string,
  tests: readonly T[],
  cycles: readonly { id: number; thesis_id: string }[],
  lessons: readonly { thesis_id: string; test_id: number | null }[],
): T[] {
  const cycleIds = new Set(cycles.filter((row) => row.thesis_id === thesisId).map((row) => row.id));
  const lessonIds = new Set(
    lessons
      .filter((row) => row.thesis_id === thesisId && row.test_id !== null)
      .map((row) => row.test_id as number),
  );
  return tests
    .filter((row) => {
      if (!isPublicStrategyTest(row)) return false;
      const cited = lessonIds.has(row.id);
      const onThesis = cycleIds.has(row.cycle_id) || cited;
      if (!onThesis) return false;
      if (row.status === 'queued' && !cited) return false;
      return true;
    })
    .slice()
    .sort((a, b) => {
      const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (rank !== 0) return rank;
      const byTime = (b.tested_at ?? '').localeCompare(a.tested_at ?? '');
      return byTime !== 0 ? byTime : b.id - a.id;
    });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dig(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    const next = asRecord(current);
    if (!next || !(key in next)) return undefined;
    current = next[key];
  }
  return current;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function firstNum(record: Record<string, unknown>, paths: readonly (readonly string[])[]): number | null {
  for (const path of paths) {
    const value = num(dig(record, path));
    if (value !== null) return value;
  }
  return null;
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const low = num(value[0]);
  const high = num(value[1]);
  if (low === null || high === null) return null;
  return [low, high];
}

function firstPair(record: Record<string, unknown>, paths: readonly (readonly string[])[]): [number, number] | null {
  for (const path of paths) {
    const value = pair(dig(record, path));
    if (value) return value;
  }
  return null;
}

function signed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  if (text.startsWith('-') || Number(text) === 0) return Number(text) === 0 ? (0).toFixed(digits) : text;
  return `+${text}`;
}

function percentHit(fraction: number): string {
  const points = Math.round(fraction * 1000) / 10;
  const text = Number.isInteger(points) ? String(points) : points.toFixed(1);
  return `${text}%`;
}

function sampleCount(record: Record<string, unknown>): number | null {
  return firstNum(record, [['trade_count'], ['n'], ['n_trades'], ['n10'], ['by_cost', '10', 'n']]);
}

/** Hold-vs-exit is the preregistered pair: holding through the print versus selling the close before it. */
function comparisonArms(variant: string, compared: string): { a: string; b: string } | null {
  const text = `${variant} ${compared}`.toLowerCase();
  const hold = text.includes('hold-through') || text.includes('hold through') || text.includes('hold-vs-exit') || text.includes('hold vs exit');
  const sell = text.includes('sell-before') || text.includes('sell before') || text.includes('selling before') || text.includes('hold-vs-exit') || text.includes('hold vs exit');
  if (hold && sell) return { a: 'hold-through', b: 'selling before' };
  return null;
}

function aboutOneYear(start: string | null | undefined, end: string | null | undefined): boolean {
  if (!start || !end) return false;
  const days = (Date.parse(`${end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${start.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(days) && days >= 300 && days <= 430;
}

function bookLine(
  record: Record<string, unknown>,
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
): string | null {
  const book = firstNum(record, [['book_a'], ['total_return_a_book'], ['book'], ['total_return_book']]);
  if (book === null) return null;
  const spy = firstNum(record, [
    ['spy_a'],
    ['spy_same_dates_book'],
    ['spy_same'],
    ['spy_book_same_dates'],
    ['spy_open'],
    ['spy_open_to_close_book'],
  ]);
  const label = aboutOneYear(windowStart, windowEnd) ? '1-yr compounded book' : 'compounded book';
  const spyText = spy === null ? '' : ` (SPY ${signed(spy * 100, 1)}%)`;
  return `${label} ${signed(book * 100, 1)}%${spyText}`;
}

function stats(partial: Partial<PerTradeStats> & Pick<PerTradeStats, 'n'>): PerTradeStats {
  return {
    n: partial.n,
    unit: partial.unit ?? null,
    mean: partial.mean ?? null,
    ci90: partial.ci90 ?? null,
    hit: partial.hit ?? null,
    hit_other: partial.hit_other ?? null,
  };
}

function emptyMeasured(): MeasuredTest {
  return { result: null, per_trade: null, book: null };
}

/**
 * One plain sentence from per-trade summary stats.
 * A bare `total_return` is not used: queued rows stored that column in more than one unit.
 */
export function measureStrategyTest(summary: unknown, context: MeasureContext = {}): MeasuredTest {
  const record = asRecord(summary);
  if (!record) return emptyMeasured();
  const variant = context.variant ?? '';
  const compared = context.compared ?? '';
  const n = sampleCount(record);
  const hit = firstNum(record, [['hit'], ['hit_rate'], ['chase_hit'], ['chase_hit60']]);

  const meanDiff = firstNum(record, [['mean_diff'], ['mean_diff_a_minus_b']]);
  if (meanDiff !== null) {
    const meanPts = meanDiff * 100;
    const ciFrac = firstPair(record, [['ci_diff'], ['bootstrap90_diff']]);
    const ci = ciFrac ? [ciFrac[0] * 100, ciFrac[1] * 100] as [number, number] : null;
    const hitA = firstNum(record, [['hit_a']]);
    const hitB = firstNum(record, [['hit_b']]);
    const arms = comparisonArms(variant, compared);
    const ciText = ci ? ` (90% CI ${signed(ci[0], 2)} to ${signed(ci[1], 2)})` : '';
    const hitText = hitA !== null && hitB !== null
      ? `, hit ${percentHit(hitA)} vs ${percentHit(hitB)}`
      : hitA !== null
        ? `, hit ${percentHit(hitA)}`
        : '';
    const nText = n !== null ? `, n=${Math.round(n)}` : '';
    let result: string;
    if (arms && meanPts > 0) result = `${arms.a} beat ${arms.b} by ${signed(meanPts, 2)} pts/trade${ciText}${hitText}${nText}`;
    else if (arms && meanPts < 0) result = `${arms.a} trailed ${arms.b} by ${signed(Math.abs(meanPts), 2)} pts/trade${ciText}${hitText}${nText}`;
    else result = `mean difference ${signed(meanPts, 2)} pts/trade${ciText}${hitText}${nText}`;
    return {
      result,
      per_trade: stats({ n, unit: 'pts', mean: Number(meanPts.toFixed(2)), ci90: ci && [Number(ci[0].toFixed(2)), Number(ci[1].toFixed(2))], hit: hitA, hit_other: hitB }),
      book: bookLine(record, context.windowStart, context.windowEnd),
    };
  }

  const regimeMean = firstNum(record, [['regime_mean'], ['regime', 'mean']]);
  const otherMean = firstNum(record, [['other_mean'], ['non_regime', 'mean']]);
  const regimeDiff = firstNum(record, [['regime_diff'], ['regime_minus_non_regime_mean_net']]);
  if (regimeMean !== null && otherMean !== null) {
    const regimeN = firstNum(record, [['regime_n'], ['regime', 'n']]);
    const otherN = firstNum(record, [['other_n'], ['non_regime', 'n']]);
    const ciFrac = firstPair(record, [['regime_ci'], ['diff_bootstrap_90ci']]);
    const gap = regimeDiff === null ? (regimeMean - otherMean) * 100 : regimeDiff * 100;
    const ciText = ciFrac ? `, 90% CI ${signed(ciFrac[0] * 100, 2)} to ${signed(ciFrac[1] * 100, 2)}` : '';
    const nText = regimeN !== null
      ? `, n=${Math.round(regimeN)}${otherN !== null ? ` vs ${Math.round(otherN)}` : ''}`
      : '';
    const ci = ciFrac ? [Number((ciFrac[0] * 100).toFixed(2)), Number((ciFrac[1] * 100).toFixed(2))] as [number, number] : null;
    return {
      result: `mean ${signed(regimeMean * 100, 2)}%/trade vs ${signed(otherMean * 100, 2)}%/trade (gap ${signed(gap, 2)} pts${ciText})${nText}`,
      per_trade: stats({
        n: regimeN,
        unit: 'percent',
        mean: Number((regimeMean * 100).toFixed(2)),
        ci90: ci,
        hit: null,
        hit_other: null,
      }),
      book: bookLine(record, context.windowStart, context.windowEnd),
    };
  }

  const chase = firstNum(record, [['chase60'], ['chase_mean60']]);
  const mean30 = firstNum(record, [['mean30']]);
  const meanNet = firstNum(record, [['mean_net'], ['mean_net_ret_per_trade']]);
  const meanPct = firstNum(record, [['mean10'], ['by_cost', '10', 'mean_net_pct']]);
  const fractionMean = chase ?? mean30 ?? meanNet;
  if (fractionMean !== null || meanPct !== null) {
    const alreadyPercent = fractionMean === null;
    const mean = alreadyPercent ? meanPct! : fractionMean!;
    const shown = alreadyPercent ? mean : mean * 100;
    const ciFrac = chase !== null
      ? firstPair(record, [['ci90_60']])
      : mean30 !== null
        ? firstPair(record, [['ci90']])
        : null;
    const ciShown = ciFrac ? ciFrac.map((item) => alreadyPercent ? item : item * 100) as [number, number] : null;
    const win = firstNum(record, [['win10'], ['by_cost', '10', 'win']]);
    const hitRate = chase !== null
      ? firstNum(record, [['chase_hit'], ['chase_hit60'], ['hit_rate'], ['hit']])
      : (hit ?? (win !== null && n ? win / n : null));
    const ciText = ciShown ? ` (90% CI ${signed(ciShown[0], 2)} to ${signed(ciShown[1], 2)})` : '';
    const hitText = hitRate !== null ? `, hit ${percentHit(hitRate)}` : '';
    const nText = n !== null ? `, n=${Math.round(n)}` : '';
    return {
      result: `mean ${signed(shown, 2)}%/trade${ciText}${hitText}${nText}`,
      per_trade: stats({
        n,
        unit: 'percent',
        mean: Number(shown.toFixed(2)),
        ci90: ciShown && [Number(ciShown[0].toFixed(2)), Number(ciShown[1].toFixed(2))],
        hit: hitRate,
        hit_other: null,
      }),
      book: bookLine(record, context.windowStart, context.windowEnd),
    };
  }

  if (hit !== null || n !== null) {
    const parts: string[] = [];
    if (hit !== null) parts.push(`hit ${percentHit(hit)}`);
    if (n !== null) parts.push(`n=${Math.round(n)}`);
    return {
      result: parts.join(', ') || null,
      per_trade: stats({ n, hit, unit: null, mean: null }),
      book: null,
    };
  }

  return emptyMeasured();
}

/** `+1.96 pts` or `+0.24%`. Null when the summary did not name a unit. */
export function perTradeText(stats: PerTradeStats | null | undefined): string | null {
  if (!stats || stats.mean == null || stats.unit == null) return null;
  const text = signed(stats.mean, 2);
  return stats.unit === 'pts' ? `${text} pts` : `${text}%`;
}

type SummaryRow = { id?: number; test_id?: number; payload?: Record<string, unknown> };

function summaryRows(rows: readonly unknown[]): Map<number, Record<string, unknown>> {
  const grouped = new Map<number, SummaryRow[]>();
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const testId = num(record.test_id);
    if (testId === null) continue;
    const list = grouped.get(testId) ?? [];
    list.push({ id: num(record.id) ?? 0, test_id: testId, payload: record.payload_json && asRecord(record.payload_json) ? asRecord(record.payload_json)! : record });
    grouped.set(testId, list);
  }
  const picked = new Map<number, Record<string, unknown>>();
  for (const [testId, list] of grouped) {
    const ordered = list.slice().sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    const measuring = ordered.find((row) => row.payload && measureStrategyTest(row.payload).result);
    picked.set(testId, (measuring ?? ordered[0])?.payload ?? {});
  }
  return picked;
}

/**
 * Public test rows for the phone mapper: name, status, the measured line, per-trade stats.
 * Parameter bags and the compounded column are not copied.
 */
export function projectPublicTests(tests: readonly unknown[], summaries: readonly unknown[]): Record<string, unknown>[] {
  const byTest = summaryRows(summaries);
  const out: Record<string, unknown>[] = [];
  for (const row of tests) {
    const record = asRecord(row);
    if (!record || !isPublicStrategyTest(record)) continue;
    const id = num(record.id);
    if (id === null) continue;
    const measured = measureStrategyTest(byTest.get(id) ?? null, {
      variant: typeof record.variant_label === 'string' ? record.variant_label : '',
      windowStart: typeof record.window_start === 'string' ? record.window_start : null,
      windowEnd: typeof record.window_end === 'string' ? record.window_end : null,
    });
    out.push({
      id,
      external_key: typeof record.external_key === 'string' ? record.external_key : '',
      cycle_id: num(record.cycle_id) ?? 0,
      variant_label: typeof record.variant_label === 'string' ? record.variant_label : '',
      status: typeof record.status === 'string' ? record.status : '',
      total_return: null,
      max_drawdown: null,
      deflated_sharpe: null,
      cost_multiplier: num(record.cost_multiplier) ?? 1,
      stress_regime: null,
      failure_reason: null,
      autopsy: null,
      tested_at: typeof record.tested_at === 'string' ? record.tested_at : '',
      price_source: null,
      window_start: null,
      window_end: null,
      symbols: null,
      params_json: null,
      result: measured.result,
      per_trade: measured.per_trade,
      book: measured.book,
    });
  }
  return out;
}

export function slimPublicTests(rows: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record || !isPublicStrategyTest(record)) continue;
    const next = { ...record };
    delete next.params_json;
    out.push(next);
  }
  return out;
}

/** Phone renders no artifact kinds. A kind added here still has to clear the test-status gate. */
export const PUBLIC_RENDERED_ARTIFACT_KINDS = new Set<string>();

/**
 * Nothing in `backtest_artifacts` is rendered on the phone. The measured line
 * lives on the test. Status is checked before kind: a placeholder or
 * lookahead row (test 15) cannot publish even if its artifact kind is allowed.
 */
export function slimPublicArtifacts(
  rows: unknown[],
  tests: readonly { id?: unknown; status?: unknown }[] = [],
  rendered: ReadonlySet<string> = PUBLIC_RENDERED_ARTIFACT_KINDS,
): Record<string, unknown>[] {
  const publicIds = new Set(
    tests
      .filter((row) => isPublicStrategyTest(row))
      .map((row) => num(row.id))
      .filter((id): id is number => id !== null),
  );
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const testId = num(record.test_id);
    if (testId === null || !publicIds.has(testId)) continue;
    if (typeof record.artifact_kind !== 'string' || !rendered.has(record.artifact_kind)) continue;
    if ('storage_path' in record || 'storage_bucket' in record || 'payload_json' in record) continue;
    out.push(record);
  }
  return out;
}

export type MeasuredSource = {
  id: number;
  variant_label: string;
  window_start?: string | null;
  window_end?: string | null;
  cycle_id?: number;
  result?: string | null;
  per_trade?: PerTradeStats | null;
  book?: string | null;
};

export function withMeasuredTests<T extends MeasuredSource>(
  tests: readonly T[],
  artifacts: readonly { id?: number; test_id: number; artifact_kind: string; payload_json?: unknown }[],
  cycles: readonly { id: number; preregistered_outcome?: string | null }[] = [],
): T[] {
  return tests.map((test) => {
    const measured = measuredForTest(test, artifacts, cycles);
    return { ...test, result: measured.result, per_trade: measured.per_trade, book: measured.book };
  });
}

export function measuredForTest(
  test: MeasuredSource,
  artifacts: readonly { id?: number; test_id: number; artifact_kind: string; payload_json?: unknown }[],
  cycles: readonly { id: number; preregistered_outcome?: string | null }[] = [],
): MeasuredTest {
  const summaries = artifacts
    .filter((row) => row.test_id === test.id && row.artifact_kind === 'summary_json' && row.payload_json)
    .slice()
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  const compared = cycles.find((row) => row.id === test.cycle_id)?.preregistered_outcome ?? null;
  for (const row of summaries) {
    const measured = measureStrategyTest(row.payload_json, {
      variant: test.variant_label,
      windowStart: test.window_start,
      windowEnd: test.window_end,
      compared,
    });
    if (measured.result) return measured;
  }
  return {
    result: test.result ?? null,
    per_trade: test.per_trade ?? null,
    book: test.book ?? null,
  };
}
