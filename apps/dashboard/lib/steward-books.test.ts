import { describe, expect, test } from 'bun:test';

import type { BookHolding } from './book-holdings';
import type { ExposureUsage } from './ledger-watchdog';
import { mapEarnings } from './ledger-map';
import {
  beliefKindText,
  changeText,
  earningsBookLine,
  earningsPrintPassed,
  exitLine,
  headerAmount,
  leanText,
  lessonGapText,
  lotAmount,
  lotLine,
  lotPnl,
  openRulesLine,
  plainThesisName,
  predictionShortName,
  riskText,
  rowSentence,
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

  test('track record: logged backtests count in the label and get a plain line, pass or fail', () => {
    const gap = trackRecord({
      priced_trades: 6, wins: 2, results_confidence: 52,
      backtest_tests: 1, backtest_trades: 714, backtest_mean_ret: -0.003457, backtest_effect: 'against',
    });
    expect(gap.label).toBe('6 trades + 1 backtest, score 52');
    expect(gap.backtest).toBe('Backtests: 1 logged (714 trades), -0.35% per trade after costs, counts against the score');
    expect(gap.wins).toBe(2);
    const onlyBacktests = trackRecord({
      priced_trades: 0, wins: 0, results_confidence: null,
      backtest_tests: 2, backtest_trades: 400, backtest_weight: 0, backtest_mean_ret: 0.004, backtest_effect: 'for',
    });
    expect(onlyBacktests.label).toBe('2 backtests, not scored yet');
    expect(onlyBacktests.wins).toBeNull();
    expect(onlyBacktests.backtest).toBe('Backtests: 2 logged (400 trades), +0.40% per trade after costs, counts once the thesis has 3 live trades');
    const scored = trackRecord({
      priced_trades: 4, wins: 3, results_confidence: 61,
      backtest_tests: 2, backtest_trades: 400, backtest_weight: 2, backtest_mean_ret: 0.004, backtest_effect: 'for',
    });
    expect(scored.backtest).toBe('Backtests: 2 logged (400 trades), +0.40% per trade after costs, counts for the score');
    expect(trackRecord({ priced_trades: 6, wins: 2, results_confidence: 56 }).backtest).toBeNull();
  });

  test('a collapsed row is why it is held, then the exit', () => {
    expect(rowSentence('Earnings gap structure and missed-swing autopsy', 'exits below $10.35'))
      .toBe('Earnings gap structure and missed-swing autopsy. Exits below $10.35.');
    expect(rowSentence('Sports maker bids vs sportsbook no-vig fair', 'exits below $0.10'))
      .toBe('Sports maker bids vs sportsbook no-vig fair. Exits below $0.10.');
    expect(rowSentence('opened before theses were tracked', null)).toBe('Opened before theses were tracked.');
    expect(rowSentence('no thesis linked', 'exit noted')).toBe('No thesis linked. Exit noted.');
  });

  test('only a closed row still waiting on its lesson says so', () => {
    expect(lotLine({ why: 'Sports maker bids', exit: null, lesson_waiting: true }))
      .toBe('Sports maker bids. No lesson written yet.');
    expect(lotLine({ why: 'Sports maker bids', exit: 'exits below $0.10', lesson_waiting: false }))
      .toBe('Sports maker bids. Exits below $0.10.');
    expect(lotLine({ why: '', exit: null, lesson_waiting: true })).toBe('No lesson written yet.');
    expect(lessonGapText(0)).toBeNull();
    expect(lessonGapText(1)).toBe('1 close with no lesson yet');
    expect(lessonGapText(2)).toBe('2 closes with no lesson yet');
  });

  test('a prediction row uses the side a person would say', () => {
    const dolphins = 'Who will win in the upcoming football event Miami Dolphins vs Minnesota Vikings scheduled for October 4, 2026 at 8:05 PM UTC?';
    const titans = 'Who will win in the upcoming football event Tennessee Titans vs Baltimore Ravens scheduled for October 4, 2026 at 5:00 PM UTC?';
    expect(predictionShortName(dolphins, 'yes')).toBe('Dolphins');
    expect(predictionShortName(dolphins, 'no')).toBe('Vikings');
    expect(predictionShortName(titans, 'yes')).toBe('Titans');
    expect(predictionShortName(titans, 'no')).toBe('Ravens');
    expect(predictionShortName('Who will win MIA Dolphins vs SF 49ers Sep 20 2026 (Dolphins YES)', 'yes')).toBe('Dolphins');
    expect(predictionShortName('Who will win: New England Patriots vs Seattle Seahawks (Sep 9, 2026)', 'no')).toBe('Seahawks');
    expect(predictionShortName('Fed Decision in September — 25 bps Increase', 'yes')).toBe('Fed, up 25 bps');
    expect(predictionShortName('Fed Decision in September — No Change', 'yes')).toBe('Fed, no change');
    expect(predictionShortName('Fed Decision in September — 25 bps Increase', 'no')).toBe('No on Fed, up 25 bps');
    expect(predictionShortName('Highest temperature in Chicago on September 9? — 79 or below', 'yes')).toBe('Chicago, 79 or below');
    expect(predictionShortName('Highest temperature in Los Angeles on September 10? 87 to 88', 'yes')).toBe('Los Angeles, 87 to 88');
    expect(predictionShortName('Mark Andrews 2+ touchdowns — NO Saints vs BAL Ravens Sep 20 2026', 'yes')).toBe('Mark Andrews 2+ touchdowns');
    expect(predictionShortName('Fed hike 25', 'yes')).toBe('Fed hike 25');
    expect(predictionShortName('Who will win in the upcoming football event Baltimore Ravens vs Dallas Cowboys scheduled for September 27, 2026 at 8:25 PM UTC?', 'yes')).toBe('Ravens');
  });

  test('open rules stay plain words and stay off an empty list', () => {
    expect(openRulesLine([])).toBeNull();
    expect(openRulesLine(['no_chase_already_printed_leftovers'])).toBe(
      'Rules in force no chase already printed leftovers',
    );
    expect(openRulesLine(['quality_drawdown_into_print', 'kill'])).toBe(
      'Rules in force quality drawdown into print · kill',
    );
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
    expect(statusText('killed')).toBe('dropped');
    expect(statusText('retired')).toBe('retired');
    expect(beliefKindText('playbook_rule')).toBe('rule');
    expect(beliefKindText('outcome_rescore')).toBe('re-scored on results');
    expect(beliefKindText('trade_close_lesson')).toBe('lesson from a close');
    expect(beliefKindText('gate_outcome')).toBe('what the skips did');
    expect(beliefKindText('earnings_print')).toBe('lesson from an earnings print');
  });
});

const FIXTURE_NOW_BEFORE = Date.parse('2026-10-19T15:00:00.000Z');
const FIXTURE_NOW_AFTER = Date.parse('2026-10-21T21:00:00.000Z');

function fixturePrint(extra: Partial<Parameters<typeof earningsBookLine>[0]> = {}) {
  return {
    lot_id: 'fixture-lot',
    symbol: 'NFLX',
    report_date: '2026-10-20',
    report_timing: 'pm' as const,
    reported: false,
    straddle_price: 9.7,
    underlying_price: 100,
    expiry_date: '2026-10-23',
    expiry_gap_days: 3,
    expiry_loose: false,
    realized_open_gap: null,
    realized_close_to_close: null,
    realized_implied_ratio: null,
    line_jumped: null,
    score_missing_reason: null,
    ...extra,
  };
}

const FIXTURE_QUOTE = { mark: 48.45, size: 10, invalidation: 45.35 };

describe('Book earnings line', () => {
  test('before the print, the live mark prices the gap against the exit', () => {
    const line = earningsBookLine(fixturePrint(), FIXTURE_QUOTE, FIXTURE_NOW_BEFORE);
    expect(line).toBe(
      'Reports Tue after close. Options price about a 9.7% move, so a gap could cost about $47, more than the $31 to the exit line.',
    );
    expect(line).not.toMatch(/straddle|ATM|implied move/i);
    expect(lotLine({ why: 'Streaming demand', exit: 'exits below $45.35', lesson_waiting: false, earnings: line }))
      .toBe(`Streaming demand. Exits below $45.35. ${line}`);
  });

  test('a before-the-open print names the morning, and a loose expiry says so', () => {
    const line = earningsBookLine(fixturePrint({
      symbol: 'EFX',
      report_timing: 'am',
      expiry_date: '2026-11-20',
      expiry_gap_days: 31,
      expiry_loose: true,
    }), FIXTURE_QUOTE, FIXTURE_NOW_BEFORE);
    expect(line).toBe(
      'Reports Tue before the open. Options price about a 9.7% move, so a gap could cost about $47, more than the $31 to the exit line. That figure is a loose upper bound; the options expire well after the report.',
    );
  });

  test('after the print, the realized close sits next to the priced move', () => {
    const line = earningsBookLine(fixturePrint({
      reported: true,
      realized_close_to_close: 0.041,
    }), FIXTURE_QUOTE, FIXTURE_NOW_AFTER);
    expect(line).toBe('Moved 4.1% on earnings; options expected 9.7%.');
    expect(line).not.toMatch(/[+-]4\.1/);
  });

  test('a missing bar does not become a percent, and a missing mark drops the dollars', () => {
    const missing = earningsBookLine(fixturePrint({
      reported: true,
      score_missing_reason: 'bars_unavailable',
    }), FIXTURE_QUOTE, FIXTURE_NOW_AFTER);
    expect(missing).toBe('The report has passed. The price bars are not in the ledger yet.');
    expect(missing).not.toMatch(/\d+(\.\d+)?%/);
    const noClose = earningsBookLine(fixturePrint({
      score_missing_reason: 'no_post_close',
    }), FIXTURE_QUOTE, FIXTURE_NOW_AFTER);
    expect(noClose).toBe('The report has passed. The close after it is not in the ledger yet.');
    expect(noClose).not.toContain('gap could cost');
    const unmarked = earningsBookLine(fixturePrint(), { mark: null, size: 10, invalidation: 45.35 }, FIXTURE_NOW_BEFORE);
    expect(unmarked).toBe('Reports Tue after close. Options price about a 9.7% move.');
  });

  test('the morning after an after-close print does not keep the upcoming-gap sentence', () => {
    const morning = Date.parse('2026-10-21T14:00:00.000Z');
    expect(earningsPrintPassed(fixturePrint(), morning)).toBe(true);
    expect(earningsPrintPassed(fixturePrint({ report_timing: 'am' }), Date.parse('2026-10-20T13:00:00.000Z'))).toBe(false);
    expect(earningsPrintPassed(fixturePrint({ report_timing: 'am' }), Date.parse('2026-10-20T13:30:00.000Z'))).toBe(true);
    const line = earningsBookLine(fixturePrint(), FIXTURE_QUOTE, morning);
    expect(line).not.toContain('gap could cost');
    expect(line).toBe('The report has passed. The move is not in the ledger yet.');
  });

  test('numeric strings from the ledger map, and a row without a lot is dropped', () => {
    const rows = mapEarnings([
      {
        lot_id: 'fixture-lot',
        symbol: 'NFLX',
        report_date: '2026-10-20',
        report_timing: 'pm',
        reported: false,
        straddle_price: '9.70',
        underlying_price: '100',
        expiry_loose: false,
        realized_close_to_close: null,
      },
      { symbol: 'NOLOT' },
      { lot_id: 'bad', symbol: 'BAD', straddle_price: 'nope', report_timing: 'later', reported: false },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: 'NFLX', straddle_price: 9.7, underlying_price: 100, report_timing: 'pm' });
    expect(rows[1]).toMatchObject({ symbol: 'BAD', straddle_price: null, report_timing: null });
  });
});
