import type { DeskPayload } from './ledger-types';

export type FreshnessTone = 'live' | 'warn' | 'stale';

export type FreshnessChip = {
  id: 'read' | 'ledger';
  label: 'read' | 'ledger';
  at: string | null;
  title: string;
};

export type DeskFreshness = {
  read_at: string | null;
  ledger_at: string | null;
  chips: FreshnessChip[];
};

const FRESH_MS = 6 * 60 * 60 * 1000;
const WARN_MS = 48 * 60 * 60 * 1000;

function maxIso(candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const raw of candidates) {
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = raw;
    }
  }
  return best;
}

function collectLedgerTimes(desk: DeskPayload): Array<string | null | undefined> {
  const out: Array<string | null | undefined> = [];

  for (const row of desk.fill_log ?? []) out.push(row.at);
  for (const row of desk.fills ?? []) out.push(row.executed_at);
  for (const row of desk.positions ?? []) out.push(row.opened_at, row.closed_at);
  for (const row of desk.exposures ?? []) out.push(row.observed_at);
  out.push(desk.book?.observed_at);
  for (const row of desk.snapshots ?? []) out.push(row.observed_at);

  const predictions = desk.prediction_markets;
  if (predictions) {
    for (const row of predictions.fills ?? []) out.push(row.executed_at);
    for (const row of predictions.positions ?? []) {
      out.push(row.opened_at, row.closed_at, row.mark_at);
    }
    for (const row of predictions.markets ?? []) out.push(row.last_marked_at);
    for (const row of predictions.pnl ?? []) out.push(row.as_of);
  }

  const meme = desk.meme_coins;
  if (meme) {
    for (const row of meme.fills ?? []) out.push(row.executed_at);
    for (const row of meme.positions ?? []) {
      out.push(row.opened_at, row.closed_at, row.mark_at);
    }
    for (const row of meme.tokens ?? []) out.push(row.last_marked_at);
    for (const row of meme.pnl ?? []) out.push(row.as_of);
  }

  return out;
}

/** Latest fill, mark, or position stamp across every steward the desk already aggregates. */
export function latestLedgerEventAt(desk: DeskPayload): string | null {
  return maxIso(collectLedgerTimes(desk));
}

export function freshnessTone(at: string | null | undefined, now: Date): FreshnessTone {
  if (!at) return 'stale';
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return 'stale';
  const age = now.getTime() - ms;
  if (age < 0) return 'live';
  if (age < FRESH_MS) return 'live';
  if (age < WARN_MS) return 'warn';
  return 'stale';
}

export function assembleDeskFreshness(desk: DeskPayload): DeskFreshness {
  const read_at = desk.generated_at || null;
  const ledger_at = latestLedgerEventAt(desk);
  return {
    read_at,
    ledger_at,
    chips: [
      {
        id: 'read',
        label: 'read',
        at: read_at,
        title: read_at ? `Last successful ledger read ${read_at}` : 'No ledger read timestamp',
      },
      {
        id: 'ledger',
        label: 'ledger',
        at: ledger_at,
        title: ledger_at
          ? `Latest fill, mark, or position event ${ledger_at}`
          : 'No fills, marks, or position events on the desk',
      },
    ],
  };
}
