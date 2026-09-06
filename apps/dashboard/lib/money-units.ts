/** Venue money. USD books use `$`. BANDIT `*_sol` fields stay native SOL — never `$`. */

import type { DeskVenue } from './desk-venue';
import { rowVenue } from './desk-venue';

export type MoneyUnit = 'USD' | 'SOL';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function venueUnit(venue: DeskVenue): MoneyUnit {
  return venue === 'meme' ? 'SOL' : 'USD';
}

export function unitForRow(row: { venue?: DeskVenue | null }): MoneyUnit {
  return venueUnit(rowVenue(row));
}

export function solDigits(value: number): number {
  const abs = Math.abs(value);
  if (abs === 0) return 2;
  if (abs < 0.0001) return 8;
  if (abs < 0.01) return 6;
  return 4;
}

export function formatUsd(value: number): string {
  return usd.format(value);
}

export function formatSol(value: number): string {
  return `${value.toFixed(solDigits(value))} SOL`;
}

export function formatAmount(value: number, unit: MoneyUnit): string {
  return unit === 'SOL' ? formatSol(value) : formatUsd(value);
}

export function signedAmount(value: number, unit: MoneyUnit): string {
  const formatted = formatAmount(value, unit);
  return value > 0 ? `+${formatted}` : formatted;
}

export function ledgerAmount(
  value: number | null | undefined,
  unit: MoneyUnit,
  signed = false,
): string {
  if (value === null || value === undefined) return 'not in ledger';
  return signed ? signedAmount(value, unit) : formatAmount(value, unit);
}

export function ledgerAmountFor(
  row: { venue?: DeskVenue | null },
  value: number | null | undefined,
  signed = false,
): string {
  return ledgerAmount(value, unitForRow(row), signed);
}
