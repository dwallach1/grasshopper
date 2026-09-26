import { describe, expect, test } from 'bun:test';

import type { BookHolding } from './book-holdings';
import type { ExposureUsage } from './ledger-watchdog';
import {
  beliefKindText,
  changeText,
  exitLine,
  headerAmount,
  leanText,
  lotAmount,
  lotPnl,
  plainThesisName,
  riskText,
  statusText,
  trackRecord,
} from './steward-books';

function holding(extra: Partial<BookHolding> = {}): BookHolding {
  return {
    id: 'eq:NBIS',
    name: 'NBIS',
    glyph: 'NBIS',
    book: 'QUANTANAMO',
    book_short: 'QNT',
    steward: 'QUANTANAMO',
    steward_slug: 'quantanamo',
    venue: 'equity',
    unit: 'USD',
    life: 'live',
    cost: 214.91,
    mark: 238.01,
    change_pct: 10.75,
    size: 4.653,
    upl: 107.48,
    note: '',
    thesis_id: 'neocloud_compute',
    thesis_name: 'Neocloud and GPU compute burst basket',
    untagged: null,
    rules_in_force: [],
    clip_note: null,
    invalidation: { price: 220.8, note: null },
    ...extra,
  };
}

function exposure(extra: Partial<ExposureUsage> = {}): ExposureUsage {
  return {
    steward: 'quantanamo',
    unit: 'USD',
    open_risk: 351.4,
    risk_budget: 550.06,
    used_share: 0.064,
    headroom: 198.66,
    over: false,
    risk_basis: 'to_invalidation',
    ...extra,
  };
}

describe('Books plain words', () => {
  test('thesis names drop the steward tag; ids fall back to spaced words', () => {
    expect(plainThesisName('Meme 4h momentum clip (BANDIT)')).toBe('Meme 4h momentum clip');
    expect(plainThesisName('Sports maker bids vs sportsbook no-vig fair (ODDSBORNE)')).toBe('Sports maker bids vs sportsbook no-vig fair');
    expect(plainThesisName('earnings_gap_structure', 'earnings_gap_structure')).toBe('earnings gap structure');
    expect(plainThesisName('nfl-mia-ml-vs-sf-20260920', 'nfl-mia-ml-vs-sf-20260920')).toBe('nfl mia ml vs sf 20260920');
  });

  test('track record: trades and earned score, or none yet', () => {
    expect(trackRecord({ priced_trades: 6, wins: 2, results_confidence: 56.4 }).label).toBe('6 trades, score 56');
    expect(trackRecord({ priced_trades: 1, wins: 0, results_confidence: null }).label).toBe('1 trade, not scored yet');
    expect(trackRecord({ priced_trades: 0, wins: 0, results_confidence: null }).label).toBe('no track record yet');
    expect(trackRecord(null).label).toBe('no track record yet');
  });

  test('exit line reads the lot’s own exit price in its unit', () => {
    expect(exitLine(holding())).toBe('exits below $220.80');
    expect(exitLine(holding({ invalidation: { price: null, note: 'close on a no-bid' } }))).toBe('exit noted');
    expect(exitLine(holding({ invalidation: null }))).toBeNull();
    expect(exitLine(holding({ unit: 'SOL', invalidation: { price: 0.00002, note: null } }))).toBe('exits below 0.00002000 SOL');
  });

  test('header: value, change since start, risk used of budget', () => {
    expect(headerAmount(5496.16, 'USD')).toBe('$5,496');
    expect(headerAmount(1.8201, 'SOL')).toBe('1.82 SOL');
    expect(changeText(9.92)).toBe('+9.9% since start');
    expect(changeText(-35)).toBe('-35.0% since start');
    expect(changeText(null)).toBeNull();
    expect(riskText(exposure())).toBe('risk $351 of $550');
    expect(riskText(exposure({ unit: 'SOL', open_risk: 0, risk_budget: 0.1803 }))).toBe('risk 0 of 0.18 SOL');
    expect(riskText(exposure({ unit: 'SOL', open_risk: 0.119, risk_budget: 0.1803 }))).toBe('risk 0.12 of 0.18 SOL');
  });

  test('row amount and P/L never invent a price', () => {
    expect(lotAmount(holding())).toBe('$1,107.46');
    expect(lotPnl(holding())).toEqual({ text: '+$107.48 (+10.8%)', sign: 107.48 });
    expect(lotAmount(holding({ mark: null, upl: null, change_pct: null }))).toBe('4.65 shares');
    expect(lotPnl(holding({ mark: null, upl: null, change_pct: null }))).toEqual({ text: 'no price yet', sign: null });
    const closedMeme = holding({ venue: 'meme', unit: 'SOL', life: 'closed', size: 0, upl: 0, change_pct: -46.8 });
    expect(lotAmount(closedMeme)).toBe('');
    expect(lotPnl(closedMeme)).toEqual({ text: '-46.8%', sign: -46.8 });
    const closedEquity = holding({ life: 'closed', mark: null, upl: null, change_pct: null, size: 10 });
    expect(lotPnl(closedEquity)).toEqual({ text: 'closed', sign: null });
    expect(lotAmount(holding({ venue: 'prediction', mark: null, size: 7 }))).toBe('7 contracts');
  });

  test('stance, status, and belief kinds in plain words', () => {
    expect(leanText('bullish')).toBe('expects up');
    expect(leanText('bearish')).toBe('expects down');
    expect(leanText('neutral')).toBe('no direction');
    expect(statusText('hardening')).toBe('active');
    expect(statusText('forming')).toBe('early');
    expect(statusText('rejected')).toBe('set aside');
    expect(beliefKindText('playbook_rule')).toBe('rule');
    expect(beliefKindText('outcome_rescore')).toBe('re-scored on results');
    expect(beliefKindText('trade_close_lesson')).toBe('lesson from a close');
  });
});
