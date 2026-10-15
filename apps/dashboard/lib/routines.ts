import type { AutomationRow, CloudRunRow, DeskRoutine, RunRow } from './ledger-types';

/** Shown when the ledger has no row for that routine. Never a stand-in time. */
export const NO_RUN_RECORDED = 'No run recorded';

export const QUANTANAMO_ROUTINES = [
  {
    id: 'market_scan',
    name: 'QUANTANAMO market scan',
    cadence: 'Weekday hourly 10:59–15:59 ET',
    run_types: ['market_scan'],
  },
  {
    id: 'missed_swing_autopsy',
    name: 'QUANTANAMO missed-swing autopsy',
    cadence: 'Weekday 16:15 ET',
    run_types: ['missed_swing_autopsy'],
  },
] as const;

function latestRun(runs: RunRow[], types: readonly string[]): RunRow | null {
  return runs.find((run) => types.includes(run.run_type)) ?? null;
}

function recordedRun(last: RunRow | null): Pick<DeskRoutine, 'last_run_at' | 'last_run_type' | 'last_outcome' | 'last_summary'> {
  if (!last) {
    return {
      last_run_at: null,
      last_run_type: null,
      last_outcome: null,
      last_summary: NO_RUN_RECORDED,
    };
  }
  const summary = last.parsed.summary.trim();
  return {
    last_run_at: last.started_at,
    last_run_type: last.run_type,
    last_outcome: last.parsed.outcome,
    last_summary: summary || null,
  };
}

/**
 * Live QUANTANAMO (Grok Bot) cadences plus retired Cloudflare / ThesisForge /
 * Codex jobs. Last-run times come from ledger rows. No next-fire clock.
 * Keep README.md "Routines" in the same PR when this list changes.
 */
export function assembleRoutines(input: {
  runs: RunRow[];
  automations: AutomationRow[];
  cloudRuns: CloudRunRow[];
}): DeskRoutine[] {
  const live: DeskRoutine[] = QUANTANAMO_ROUTINES.map((routine) => {
    const last = latestRun(input.runs, routine.run_types);
    return {
      id: routine.id,
      name: routine.name,
      cadence: routine.cadence,
      status: 'live',
      ...recordedRun(last),
    };
  });

  const retiredAutomations: DeskRoutine[] = input.automations.map((job) => ({
    id: job.id,
    name: job.name,
    cadence: 'Retired Codex / ThesisForge automation',
    status: 'retired',
    last_run_at: job.last_run_at,
    last_run_type: null,
    last_outcome: null,
    last_summary: job.last_run_at
      ? `status ${job.status}; next_run_at ignored`
      : NO_RUN_RECORDED,
  }));

  const lastCloud = input.cloudRuns[0] ?? null;
  const lastIngest = latestRun(input.runs, ['bookmark_ingest', 'cloud_research', 'scheduled_research']);
  const cloudAt = lastCloud?.started_at || lastCloud?.scheduled_for || lastIngest?.started_at || null;
  const cloudSummary = lastCloud?.error_text || lastIngest?.parsed.summary || lastCloud?.summary || null;
  const retiredCloudflare: DeskRoutine = {
    id: 'cloudflare-workers',
    name: 'Cloudflare knowledge / research workers',
    cadence: 'Retired — QUANTANAMO (Grok Bot) is the live automation',
    status: 'retired',
    last_run_at: cloudAt,
    last_run_type: lastIngest?.run_type ?? lastCloud?.trigger_source ?? null,
    last_outcome: lastCloud?.status ?? lastIngest?.parsed.outcome ?? null,
    last_summary: cloudAt || cloudSummary ? cloudSummary : NO_RUN_RECORDED,
  };

  return [...live, ...retiredAutomations, retiredCloudflare];
}
