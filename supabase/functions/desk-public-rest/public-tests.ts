/**
 * Public phone projection of strategy tests.
 *
 * The full operator rows (parameter bags, trade blotters, storage paths) stay
 * off `/bundle/public` — that fat was stripped so the Worker JSON stayed inside
 * its CPU budget. Finished results still publish: name, status, and the stored
 * headline return. `placeholder` and `lookahead_invalid` are not results.
 */

export const STRATEGY_TEST_NON_RESULTS = ['placeholder', 'lookahead_invalid'] as const;

/** Artifact kinds the phone Tests panel can draw without the trade blotter or the parameter recipe. */
export const PUBLIC_ARTIFACT_KINDS = ['summary_json', 'equity_curve', 'chart_svg', 'price_source'] as const;

/**
 * Survived and killed rows store a fractional book return: test 38's autopsy
 * is −32.6% and the column is −0.32597; test 32's book −70.6% is −0.706122.
 * A few queued rows from the first earnings-gap run stored percent points
 * already (test 13's autopsy says total return −1.772% and the column is −1.772).
 */
const LEGACY_QUEUED_PERCENT = 1;

const STATUS_RANK: Record<string, number> = { survived: 0, killed: 1, queued: 2 };

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

/** `0.932264` on a survived row → `+93.2%`. Null stays null — never a made-up mark. */
export function formatTestReturn(value: number | null | undefined, status?: string): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const finished = status === 'survived' || status === 'killed';
  const legacyPercent = !finished && Math.abs(value) > LEGACY_QUEUED_PERCENT;
  const points = legacyPercent ? value : value * 100;
  const rounded = points.toFixed(1);
  return points > 0 ? `+${rounded}%` : `${rounded}%`;
}

export function testStatusText(status: string): string {
  if (status === 'survived') return 'passed';
  if (status === 'killed') return 'failed';
  if (status === 'queued') return 'still queued';
  return status.replaceAll('_', ' ');
}

export function testsForThesis<T extends { id: number; cycle_id: number; status: string; tested_at: string }>(
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
      // Queued rows are not results. They stay on the Tests panel, and on the
      // book only when a lesson names them.
      if (row.status === 'queued' && !cited) return false;
      return true;
    })
    .slice()
    .sort((a, b) => {
      const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (rank !== 0) return rank;
      return b.tested_at.localeCompare(a.tested_at);
    });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Summary artifacts keep scalar headlines. Nested event lists stay off the phone. */
export function scalarSummary(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  if (!record) return null;
  const nested = asRecord(record.metrics) ?? asRecord(record.summary);
  const source = nested ?? record;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (item === null || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = item;
      continue;
    }
    if (typeof item === 'string') out[key] = item.length > 220 ? item.slice(0, 220) : item;
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

export function slimPublicArtifacts(rows: unknown[]): Record<string, unknown>[] {
  const allowed = new Set<string>(PUBLIC_ARTIFACT_KINDS);
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record || typeof record.artifact_kind !== 'string' || !allowed.has(record.artifact_kind)) continue;
    const next = { ...record };
    delete next.storage_bucket;
    delete next.storage_path;
    if (record.artifact_kind === 'summary_json') {
      const slim = scalarSummary(record.payload_json);
      if (slim) next.payload_json = slim;
    }
    out.push(next);
  }
  return out;
}
