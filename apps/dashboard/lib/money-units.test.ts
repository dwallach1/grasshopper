import { describe, expect, test } from 'bun:test';

import {
  formatAmount,
  formatSol,
  formatUsd,
  ledgerAmount,
  ledgerAmountFor,
  signedAmount,
  solDigits,
  venueUnit,
} from './money-units';

describe('venue money units', () => {
  test('meme is SOL; equity and prediction stay USD', () => {
    expect(venueUnit('meme')).toBe('SOL');
    expect(venueUnit('equity')).toBe('USD');
    expect(venueUnit('prediction')).toBe('USD');
  });

  test('SOL never uses a dollar sign, including tiny marks', () => {
    expect(formatSol(1.97261544)).toBe('1.9726 SOL');
    expect(formatSol(2.0355978427111925)).toBe('2.0356 SOL');
    expect(formatSol(0.000016462)).toBe('0.00001646 SOL');
    expect(formatSol(0)).toBe('0.00 SOL');
    expect(formatAmount(1.97, 'SOL')).toContain('SOL');
    expect(formatAmount(1.97, 'SOL')).not.toContain('$');
    expect(signedAmount(0.022982, 'SOL')).toBe('+0.0230 SOL');
    expect(formatSol(0.022982)).toBe('0.0230 SOL');
    expect(signedAmount(-0.01, 'SOL')).toBe('-0.0100 SOL');
    expect(ledgerAmount(1.97, 'SOL')).toBe('1.9700 SOL');
    expect(ledgerAmount(null, 'SOL')).toBe('not in ledger');
    expect(ledgerAmountFor({ venue: 'meme' }, 1.97)).toBe('1.9700 SOL');
    expect(ledgerAmountFor({ venue: 'meme' }, 1.97)).not.toContain('$');
  });

  test('USD still uses the dollar formatter', () => {
    expect(formatUsd(358.5809)).toBe('$358.58');
    expect(formatAmount(424.07, 'USD')).toBe('$424.07');
    expect(signedAmount(12.5, 'USD')).toBe('+$12.50');
    expect(solDigits(0.000016462)).toBe(8);
  });
});
