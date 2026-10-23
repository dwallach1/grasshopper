/**
 * Running tally for the two earnings shadow candidates.
 * Rows come from public.v_shadow_candidates. A missing price stays null.
 * The desk shows signed points, never dollars.
 */
import type { JsonObjectRow } from './ledger-map';

export type ShadowCandidate = {
  candidate_key: string;
  lesson_id: number;
  test_id: number | null;
  thesis_id: string;
  steward: string;
  kind: 'exit' | 'entry_flag';
  checked: number;
  flagged: number;
  n: number;
  mean_delta_pct: number | null;
  lcb_delta_pct: number | null;
  clips_to_decide: number | null;
  promotable: boolean;
};

const EXIT_KEY = 'ah_open_holds_prior_close';
const FLAG_KEY = 'cohort_down_3pct';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function int(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function countOf(value: unknown): number {
  const parsed = int(value);
  if (parsed === null || parsed < 0) return 0;
  return parsed;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Signed points, one decimal. A rounded zero is flat, not +0.0. */
export function shadowPointText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return 'flat';
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)} points`;
}

function countWord(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function exitLine(row: ShadowCandidate): string {
  const head = 'After-hours sale, cancelled when the regular open is at or above the prior close';
  if (row.n <= 0) return `${head}: no scored clip yet. It does not replace the exit.`;
  const versus = row.mean_delta_pct === null
    ? 'the result is not priced yet'
    : shadowPointText(row.mean_delta_pct) === 'flat'
      ? 'flat versus the real sale'
      : `${shadowPointText(row.mean_delta_pct)} versus the real sale`;
  const clips = countWord(row.n, 'clip', 'clips');
  if (row.promotable) {
    return `${head}: ${clips}, ${versus}. The cautious average is above zero. It has cleared the bar to replace that exit.`;
  }
  const cautious = row.lcb_delta_pct === null
    ? 'The cautious average is not in yet.'
    : row.lcb_delta_pct > 0
      ? 'The cautious average is above zero.'
      : 'The cautious average is still not above zero.';
  const more = row.clips_to_decide !== null && row.clips_to_decide > 0
    ? `${countWord(row.clips_to_decide, 'more', 'more')} before it can replace that exit.`
    : 'It does not replace the exit.';
  return `${head}: ${clips}, ${versus}. ${cautious} ${more}`;
}

function flagLine(row: ShadowCandidate): string {
  const head = 'Skip a pre-print buy when its group is down 3% or more that day';
  const tail = 'Still a check beside test 41, not a rule.';
  if (row.n > 0) {
    const result = row.mean_delta_pct === null
      ? 'the result is not priced yet'
      : shadowPointText(row.mean_delta_pct);
    const cautious = row.lcb_delta_pct === null
      ? ''
      : row.lcb_delta_pct > 0
        ? ' The cautious average is above zero.'
        : ' The cautious average is still not above zero.';
    return `${head}: ${countWord(row.n, 'scored skip', 'scored skips')}, ${result}.${cautious} ${tail}`;
  }
  if (row.flagged > 0) {
    return `${head}: the group was down that far, and the result is not priced yet. ${tail}`;
  }
  if (row.checked > 0) {
    return `${head}: ${countWord(row.checked, 'entry', 'entries')} checked, the group was not down that far, so nothing was skipped. ${tail}`;
  }
  return `${head}: no entry checked yet. ${tail}`;
}

export function mapShadowCandidates(rows: readonly JsonObjectRow[] | unknown): ShadowCandidate[] {
  if (!Array.isArray(rows)) return [];
  const out: ShadowCandidate[] = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!row) continue;
    const key = text(row.candidate_key);
    const lessonId = int(row.lesson_id);
    const thesisId = text(row.thesis_id);
    const steward = text(row.steward);
    const kind = text(row.kind);
    if (!key || lessonId === null || lessonId <= 0 || !thesisId || !steward) continue;
    if (kind !== 'exit' && kind !== 'entry_flag') continue;
    const clips = row.clips_to_decide === null || row.clips_to_decide === undefined || row.clips_to_decide === ''
      ? null
      : countOf(row.clips_to_decide);
    out.push({
      candidate_key: key,
      lesson_id: lessonId,
      test_id: (() => {
        const testId = int(row.test_id);
        return testId !== null && testId > 0 ? testId : null;
      })(),
      thesis_id: thesisId,
      steward,
      kind,
      checked: countOf(row.checked),
      flagged: countOf(row.flagged),
      n: countOf(row.n),
      mean_delta_pct: num(row.mean_delta_pct),
      lcb_delta_pct: num(row.lcb_delta_pct),
      clips_to_decide: clips,
      promotable: row.promotable === true || row.promotable === 'true' || row.promotable === 't',
    });
  }
  return out;
}

/** Plain Book line. An unknown candidate is omitted. */
export function shadowTallyLine(row: ShadowCandidate | null | undefined): string | null {
  if (!row) return null;
  if (row.candidate_key === EXIT_KEY) return exitLine(row);
  if (row.candidate_key === FLAG_KEY) return flagLine(row);
  return null;
}
