import type { AccountRow, BookNameLine, BookPerformance, ExposureRow } from './ledger-types';
import { nyDateKey, sameInstant } from './ny-date';

export const NOT_IN_LEDGER = 'not in ledger';
export const MARK_NOT_IN_LEDGER = 'mark not in ledger';
export const AGENTIC_LAST4 = '7638';

const AGENTIC_LABEL = /agentic/i;

export function isAgenticAccount(label: string): boolean {
  return AGENTIC_LABEL.test(label);
}

export function agenticSnapshots(rows: AccountRow[]): AccountRow[] {
  return rows.filter((row) => isAgenticAccount(row.account_label));
}

function costBasis(quantity: number, averageCost: number | null): number | null {
  if (averageCost === null) return null;
  return quantity * averageCost;
}

function lastPriorSession(snapshotsNewestFirst: AccountRow[], latest: AccountRow): AccountRow | null {
  const latestDay = nyDateKey(latest.observed_at);
  return snapshotsNewestFirst.find((row) => nyDateKey(row.observed_at) < latestDay) ?? null;
}

/**
 * Latest Agentic book only (last4 7638). Newer `observed_at` wins.
 * Other last4 books (7254 / 2786 / 7094 / …) stay out — no personal-book fallback.
 */
export function latestBookExposures(rows: ExposureRow[]): ExposureRow[] {
  const agentic = rows.filter((row) => row.account_last4 === AGENTIC_LAST4);
  if (agentic.length === 0) return [];
  let latestAt = agentic[0]!.observed_at;
  for (const row of agentic) {
    if (row.observed_at > latestAt) latestAt = row.observed_at;
  }
  return agentic.filter((row) => row.observed_at === latestAt);
}

/** QUANTANAMO writes the snapshot, then lots a few seconds later. */
const SAME_DAY_NEAR_MS = 2 * 60 * 1000;

/**
 * Exact `observed_at` first; else nearest Agentic row on the same NY calendar
 * day within two minutes; else the newest Agentic row on that NY day.
 * Never borrows a previous NY session.
 */
export function snapshotForBook(snapshots: AccountRow[], observedAt: string): AccountRow | null {
  const exact = snapshots.find((row) => sameInstant(row.observed_at, observedAt));
  if (exact) return exact;

  const day = nyDateKey(observedAt);
  const sameDay = snapshots.filter((row) => nyDateKey(row.observed_at) === day);
  if (sameDay.length === 0) return null;

  const asOfMs = Date.parse(observedAt);
  let nearest: AccountRow | null = null;
  let nearestDelta = Infinity;
  let newest: AccountRow | null = null;
  let newestMs = -Infinity;
  for (const row of sameDay) {
    const ms = Date.parse(row.observed_at);
    const delta = Math.abs(ms - asOfMs);
    if (delta < nearestDelta) {
      nearest = row;
      nearestDelta = delta;
    }
    if (ms > newestMs) {
      newest = row;
      newestMs = ms;
    }
  }
  if (nearest !== null && nearestDelta <= SAME_DAY_NEAR_MS) return nearest;
  return newest;
}

/**
 * Proof-account performance from the latest Agentic 7638 exposure snapshot
 * plus the Agentic `account_snapshots` row for that NY day.
 * Never invents marks or P/L: missing inputs become `null` plus a note.
 * A newer book never borrows yesterday's NAV/cash.
 */
export function assembleBookPerformance(input: {
  snapshotsNewestFirst: AccountRow[];
  starting: AccountRow | null;
  exposures: ExposureRow[];
  marks?: ReadonlyMap<string, number>;
}): BookPerformance {
  const snapshots = agenticSnapshots(input.snapshotsNewestFirst);
  const lots = latestBookExposures(input.exposures);
  const asOf = lots[0]?.observed_at ?? null;
  const latest = asOf ? snapshotForBook(snapshots, asOf) : snapshots[0] ?? null;
  const starting = input.starting && isAgenticAccount(input.starting.account_label)
    ? input.starting
    : snapshots[snapshots.length - 1] ?? null;

  const names: BookNameLine[] = [...lots]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((lot) => {
      const cost = costBasis(lot.quantity, lot.average_buy_price);
      const mark = input.marks?.get(lot.symbol) ?? lot.last_price ?? null;
      const pnl = mark === null || lot.average_buy_price === null
        ? null
        : (mark - lot.average_buy_price) * lot.quantity;
      return {
        symbol: lot.symbol,
        quantity: lot.quantity,
        average_cost: lot.average_buy_price,
        cost,
        mark,
        pnl,
        note: mark === null ? MARK_NOT_IN_LEDGER : '',
        venue: 'equity',
      };
    });

  const costs = names.map((row) => row.cost);
  const costMissing = names.length === 0 || costs.some((value) => value === null);
  const totalCost = costMissing ? null : costs.reduce((sum, value) => (sum ?? 0) + (value ?? 0), 0);

  const currentNav = latest?.total_value ?? null;
  const startingNav = starting?.total_value ?? null;
  const cash = latest?.cash ?? null;
  const buyingPower = latest?.buying_power ?? null;
  const deployed = latest?.equity_value ?? null;

  let vsStart: number | null = null;
  let vsStartNote = NOT_IN_LEDGER;
  if (currentNav !== null && startingNav !== null) {
    vsStart = currentNav - startingNav;
    vsStartNote = `vs first Agentic snapshot ${starting?.observed_at ?? ''}`.trim();
  }

  let dayPnl: number | null = null;
  let dayPnlNote = latest ? 'no prior-session snapshot in ledger' : NOT_IN_LEDGER;
  if (latest) {
    const prior = lastPriorSession(snapshots, latest);
    if (prior) {
      dayPnl = latest.total_value - prior.total_value;
      dayPnlNote = `vs prior NY session ${prior.observed_at}`;
    }
  }

  let vsCost: number | null = null;
  let vsCostNote = NOT_IN_LEDGER;
  if (deployed !== null && totalCost !== null) {
    vsCost = deployed - totalCost;
    vsCostNote = 'equity vs sum(qty × average buy)';
  } else if (names.some((row) => row.average_cost === null)) {
    vsCostNote = 'average buy missing on an open lot';
  } else if (asOf && !latest) {
    vsCostNote = NOT_IN_LEDGER;
  }

  return {
    account_label: latest?.account_label ?? (asOf ? `Agentic ••••${AGENTIC_LAST4}` : null),
    observed_at: asOf ?? latest?.observed_at ?? null,
    last4: lots[0]?.account_last4 ?? (asOf ? AGENTIC_LAST4 : null),
    buying_power: buyingPower,
    starting_nav: startingNav,
    current_nav: currentNav,
    cash,
    deployed,
    vs_start: vsStart,
    vs_start_note: vsStartNote,
    day_pnl: dayPnl,
    day_pnl_note: dayPnlNote,
    vs_cost: vsCost,
    vs_cost_note: vsCostNote,
    names,
  };
}
