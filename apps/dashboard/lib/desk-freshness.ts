import type { DeskPayload } from './ledger-types';
import { latestMemePnl, memeDesk } from './meme-book';
import { latestPredictionPnl, predictionDesk } from './prediction-book';

export type FreshnessTone = 'live' | 'warn' | 'stale';

export type FreshnessChip = {
  id: 'read' | 'ledger';
  label: 'read' | 'ledger';
  at: string | null;
  title: string;
};

export type StewardFreshnessId = 'quantanamo' | 'oddsborne' | 'bandit';

export type StewardFreshness = {
  id: StewardFreshnessId;
  label: 'QNT' | 'ODD' | 'BND';
  /** Latest mark / pnl / CLOB stamp. Notes and heartbeats do not count. */
  mark_at: string | null;
  /** Latest steward write, including notes and heartbeat. Pulse only. */
  activity_at: string | null;
};

export type DeskFreshness = {
  read_at: string | null;
  /** Oldest steward book mark — chip must not look live when one book lags. */
  ledger_at: string | null;
  /** Newest fill/mark/position across every steward. Not the header chip. */
  latest_any_at: string | null;
  chips: FreshnessChip[];
  stewards: StewardFreshness[];
};

const FRESH_MS = 6 * 60 * 60 * 1000;
const WARN_MS = 48 * 60 * 60 * 1000;

const STEWARD_META: Record<StewardFreshnessId, StewardFreshness['label']> = {
  quantanamo: 'QNT',
  oddsborne: 'ODD',
  bandit: 'BND',
};

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

function minIso(candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const raw of candidates) {
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    if (ms < bestMs) {
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

function quantanamoMarkAt(desk: DeskPayload): string | null {
  return maxIso([
    desk.book?.observed_at,
    ...(desk.snapshots ?? []).map((row) => row.observed_at),
    ...(desk.exposures ?? []).map((row) => row.observed_at),
  ]);
}

function oddsborneMarkAt(desk: DeskPayload): string | null {
  const predictions = predictionDesk(desk);
  return maxIso([
    latestPredictionPnl(predictions)?.as_of,
    ...predictions.positions.map((row) => row.mark_at),
    ...predictions.markets.map((row) => row.last_marked_at),
    ...predictions.fills.map((row) => row.executed_at),
  ]);
}

function banditMarkAt(desk: DeskPayload): string | null {
  const meme = memeDesk(desk);
  return maxIso([
    latestMemePnl(meme)?.as_of,
    ...meme.positions.map((row) => row.mark_at),
    ...meme.tokens.map((row) => row.last_marked_at),
    ...meme.fills.map((row) => row.executed_at),
  ]);
}

function agentHeartbeat(desk: DeskPayload, slug: StewardFreshnessId): string | null {
  return desk.team?.agents?.find((row) => row.slug === slug)?.heartbeat_at ?? null;
}

function quantanamoActivityAt(desk: DeskPayload): string | null {
  return maxIso([
    agentHeartbeat(desk, 'quantanamo'),
    quantanamoMarkAt(desk),
    ...(desk.fills ?? []).map((row) => row.executed_at),
    ...(desk.fill_log ?? []).map((row) => row.at),
  ]);
}

function oddsborneActivityAt(desk: DeskPayload): string | null {
  const predictions = predictionDesk(desk);
  return maxIso([
    agentHeartbeat(desk, 'oddsborne'),
    oddsborneMarkAt(desk),
    ...predictions.notes.map((row) => row.created_at),
    ...predictions.orders.map((row) => row.submitted_at ?? row.created_at),
    ...predictions.positions.map((row) => row.opened_at),
    ...predictions.positions.map((row) => row.closed_at),
  ]);
}

function banditActivityAt(desk: DeskPayload): string | null {
  const meme = memeDesk(desk);
  return maxIso([
    agentHeartbeat(desk, 'bandit'),
    banditMarkAt(desk),
    ...meme.notes.map((row) => row.created_at),
    ...meme.orders.map((row) => row.submitted_at ?? row.created_at),
    ...meme.positions.map((row) => row.opened_at),
    ...meme.positions.map((row) => row.closed_at),
  ]);
}

/** Latest fill, mark, or position stamp across every steward the desk already aggregates. */
export function latestLedgerEventAt(desk: DeskPayload): string | null {
  return maxIso(collectLedgerTimes(desk));
}

export function assembleStewardFreshness(desk: DeskPayload): StewardFreshness[] {
  return [
    {
      id: 'quantanamo',
      label: STEWARD_META.quantanamo,
      mark_at: quantanamoMarkAt(desk),
      activity_at: quantanamoActivityAt(desk),
    },
    {
      id: 'oddsborne',
      label: STEWARD_META.oddsborne,
      mark_at: oddsborneMarkAt(desk),
      activity_at: oddsborneActivityAt(desk),
    },
    {
      id: 'bandit',
      label: STEWARD_META.bandit,
      mark_at: banditMarkAt(desk),
      activity_at: banditActivityAt(desk),
    },
  ];
}

export function stewardFreshness(
  desk: DeskPayload,
  id: StewardFreshnessId,
): StewardFreshness | undefined {
  return assembleStewardFreshness(desk).find((row) => row.id === id);
}

/** Oldest mark among stewards that already have a book. Empty books do not count. */
export function oldestStewardMarkAt(desk: DeskPayload): string | null {
  return minIso(assembleStewardFreshness(desk).map((row) => row.mark_at));
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

function stewardMarkTitle(stewards: readonly StewardFreshness[]): string {
  const parts = stewards
    .filter((row) => row.mark_at)
    .map((row) => `${row.label} ${row.mark_at}`);
  return parts.length ? parts.join(' · ') : 'No steward marks in ledger';
}

export function assembleDeskFreshness(desk: DeskPayload): DeskFreshness {
  const read_at = desk.generated_at || null;
  const stewards = assembleStewardFreshness(desk);
  const latest_any_at = latestLedgerEventAt(desk);
  const ledger_at = oldestStewardMarkAt(desk);
  return {
    read_at,
    ledger_at,
    latest_any_at,
    stewards,
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
          ? `Oldest steward book mark ${ledger_at} (${stewardMarkTitle(stewards)})`
          : 'No steward marks on the desk',
      },
    ],
  };
}
