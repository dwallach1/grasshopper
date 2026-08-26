import type { AccountRow, BookNameLine, BookPerformance, PositionRow } from './ledger-types';
import { nyDateKey } from './ny-date';

export const NOT_IN_LEDGER = 'not in ledger';

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
 * Proof-account performance from canonical ledger rows.
 * Never invents marks or P/L: missing inputs become `null` plus a note.
 */
export function assembleBookPerformance(input: {
  snapshotsNewestFirst: AccountRow[];
  starting: AccountRow | null;
  positions: PositionRow[];
}): BookPerformance {
  const snapshots = agenticSnapshots(input.snapshotsNewestFirst);
  const latest = snapshots[0] ?? null;
  const starting = input.starting && isAgenticAccount(input.starting.account_label)
    ? input.starting
    : snapshots[snapshots.length - 1] ?? null;

  const names: BookNameLine[] = input.positions.map((position) => {
    const cost = costBasis(position.quantity, position.average_cost);
    return {
      symbol: position.symbol,
      quantity: position.quantity,
      average_cost: position.average_cost,
      cost,
      mark: null,
      pnl: null,
      note: 'mark not in ledger',
    };
  });

  const costs = names.map((row) => row.cost);
  const costMissing = names.length === 0 || costs.some((value) => value === null);
  const totalCost = costMissing ? null : costs.reduce((sum, value) => (sum ?? 0) + (value ?? 0), 0);

  const currentNav = latest?.total_value ?? null;
  const startingNav = starting?.total_value ?? null;
  const cash = latest?.cash ?? null;
  const deployed = latest?.equity_value ?? null;

  let vsStart: number | null = null;
  let vsStartNote = NOT_IN_LEDGER;
  if (currentNav !== null && startingNav !== null) {
    vsStart = currentNav - startingNav;
    vsStartNote = `vs first Agentic snapshot ${starting?.observed_at ?? ''}`.trim();
  }

  let dayPnl: number | null = null;
  let dayPnlNote = 'no prior-session snapshot in ledger';
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
    vsCostNote = 'equity vs sum(qty × average cost)';
  } else if (names.some((row) => row.average_cost === null)) {
    vsCostNote = 'average cost missing on an open episode';
  }

  return {
    account_label: latest?.account_label ?? null,
    observed_at: latest?.observed_at ?? null,
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
