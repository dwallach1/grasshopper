import { describe, expect, test } from 'bun:test';

import { emptyMemeCoins } from './meme-book';
import { emptyPredictionMarkets } from './prediction-book';
import { fallbackTeam } from './desk-team';
import { assemblePublicDeskFromRestBag } from './ledger-live';
import { toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';
import {
  formatTestReturn,
  slimPublicArtifacts,
  slimPublicTests,
  strategyTestCounts,
  testsForThesis,
} from './strategy-tests-public';

const AT = '2026-10-16T13:15:29.712Z';

function thesis() {
  return {
    id: 'earnings_gap_structure',
    name: 'Earnings gap structure',
    summary: 'Gap leftovers are not a chase.',
    status: 'hardening',
    confidence: 70,
    time_horizon: 'days_to_weeks',
    stance: 'bullish',
    variant_perception: null,
    falsifier: 'A printed gap that still pays.',
    created_at: AT,
    updated_at: AT,
  };
}

function testRow(id: number, status: string, total: number | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    external_key: `key-${id}`,
    cycle_id: 144,
    variant_label: status === 'survived' ? 'serial-negative-reactor-hold-vs-exit-v1' : `variant-${id}`,
    status,
    total_return: total,
    max_drawdown: total === null ? null : -0.24,
    deflated_sharpe: status === 'survived' ? -0.067909 : null,
    cost_multiplier: 1,
    stress_regime: null,
    failure_reason: status === 'killed' ? 'survive rule failed' : null,
    autopsy: status === 'survived' ? 'Hold-through beat sell-before by +1.96pp.' : null,
    tested_at: AT,
    price_source: 'robinhood_mcp',
    window_start: '2025-10-06',
    window_end: '2026-10-15',
    symbols: ['AAPL'],
    params_json: { secret_rule: 'do not publish' },
    ...extra,
  };
}

function finishedLedger() {
  const killed = [16, 30, 31, 32, 34, 35, 36, 38].map((id) => testRow(id, 'killed', -0.23));
  const queued = Array.from({ length: 16 }, (_, index) => testRow(100 + index, 'queued', null, { cycle_id: 10 }));
  const placeholders = [1, 2, 3, 4, 6].map((id) => testRow(id, 'placeholder', 11.2));
  return [
    testRow(40, 'survived', 0.932264),
    ...killed,
    ...queued,
    ...placeholders,
    testRow(15, 'lookahead_invalid', 4.54),
  ];
}

describe('public strategy test projection', () => {
  test('counts finished tests and ignores placeholder and lookahead rows', () => {
    const rows = finishedLedger();
    expect(strategyTestCounts(rows)).toEqual({
      tests_survived: 1,
      tests_killed: 8,
      tests_queued: 16,
    });
    expect(strategyTestCounts(rows).tests_survived).not.toBe(0);
    expect(strategyTestCounts(rows).tests_killed).not.toBe(0);
    const published = slimPublicTests(rows);
    expect(published.map((row) => row.status).sort()).toEqual([
      ...Array.from({ length: 8 }, () => 'killed'),
      ...Array.from({ length: 16 }, () => 'queued'),
      'survived',
    ].sort());
    expect(published.some((row) => row.status === 'placeholder' || row.status === 'lookahead_invalid')).toBe(false);
    expect(published.some((row) => 'params_json' in row)).toBe(false);
  });

  test('formats the stored fractional book return and leaves a missing one blank', () => {
    expect(formatTestReturn(0.932264, 'survived')).toBe('+93.2%');
    expect(formatTestReturn(-0.32597, 'killed')).toBe('-32.6%');
    expect(formatTestReturn(-0.706122, 'killed')).toBe('-70.6%');
    expect(formatTestReturn(null, 'survived')).toBeNull();
    expect(formatTestReturn(-1.772, 'queued')).toBe('-1.8%');
    expect(formatTestReturn(0.929116, 'queued')).toBe('+92.9%');
  });

  test('summary artifacts keep scalar headlines and drop the blotter and storage path', () => {
    const slim = slimPublicArtifacts([
      {
        id: 1,
        test_id: 40,
        artifact_kind: 'summary_json',
        payload_json: { trade_count: 50, verdict: 'survived', events: [{ symbol: 'NFLX' }] },
        storage_bucket: 'private',
        storage_path: 'secret/path',
      },
      { id: 2, test_id: 40, artifact_kind: 'trades', payload_json: { trades: [{ symbol: 'AAPL' }] } },
      { id: 3, test_id: 40, artifact_kind: 'params_json', payload_json: { hold_sessions: 6 } },
      { id: 4, test_id: 40, artifact_kind: 'chart_svg', payload_text: '<svg></svg>' },
    ]);
    expect(slim.map((row) => row.artifact_kind)).toEqual(['summary_json', 'chart_svg']);
    expect(slim[0]?.payload_json).toEqual({ trade_count: 50, verdict: 'survived' });
    expect(slim[0]).not.toHaveProperty('storage_path');
  });

  test('a thesis test sits with the lesson that cites it', () => {
    const tests = [
      { id: 40, cycle_id: 144, status: 'survived', tested_at: AT },
      { id: 39, cycle_id: 143, status: 'queued', tested_at: AT },
      { id: 1, cycle_id: 1, status: 'placeholder', tested_at: AT },
    ];
    const linked = testsForThesis(
      'earnings_gap_structure',
      tests,
      [
        { id: 144, thesis_id: 'earnings_gap_structure' },
        { id: 143, thesis_id: 'earnings_gap_structure' },
      ],
      [{ thesis_id: 'earnings_gap_structure', test_id: 40 }],
    );
    expect(linked.map((row) => row.id)).toEqual([40]);
  });

  test('public desk counts are not zero when the ledger has finished tests', () => {
    const desk = assemblePublicDeskFromRestBag({
      theses: [thesis()],
      symbols: [],
      beliefs: [],
      lessons: [{
        id: 132,
        cycle_id: 144,
        test_id: 40,
        thesis_id: 'earnings_gap_structure',
        lesson_type: 'pattern_confirm',
        summary: 'Test 40 survived the preregistered rule.',
        market_regime: null,
        incorporated: false,
        created_at: AT,
      }],
      accountLatest: [],
      accountFirst: [],
      positions: [],
      exposures: [],
      intents: [],
      fills: [],
      themes: [],
      candidates: [],
      prediction: emptyPredictionMarkets(),
      meme: emptyMemeCoins(),
      team: fallbackTeam(),
      cycles: [{
        id: 144,
        external_key: 'cycle-144',
        thesis_id: 'earnings_gap_structure',
        hypothesis: 'Hold through the print.',
        preregistered_outcome: 'Hold beats the exit.',
        preregistered_at: AT,
        stage: 'tested',
        status: 'complete',
        iteration: 1,
        market_regime: null,
      }],
      tests: finishedLedger(),
      artifacts: [{
        id: 9,
        test_id: 40,
        thesis_id: 'earnings_gap_structure',
        artifact_kind: 'summary_json',
        title: 'summary',
        mime_type: 'application/json',
        payload_json: { trade_count: 50, verdict: 'survived', events: [{ n: 50 }] },
        source: 'robinhood_mcp',
        created_at: AT,
      }],
      scenarios: [],
    });
    expect(desk.counts.tests_survived).toBe(1);
    expect(desk.counts.tests_killed).toBe(8);
    expect(desk.counts.tests_queued).toBe(16);
    expect(desk.counts.tests_survived).not.toBe(0);
    expect(desk.tests.map((row) => row.id)).toContain(40);
    expect(desk.tests.some((row) => row.status === 'placeholder' || row.status === 'lookahead_invalid')).toBe(false);
    expect(desk.tests.every((row) => row.params_json === null)).toBe(true);
    expect(desk.backtest_artifacts).toHaveLength(1);
    expect(desk.backtest_artifacts[0]?.payload_json).toEqual({ trade_count: 50, verdict: 'survived' });
    const lesson = desk.lessons.find((row) => row.id === 132);
    expect(lesson?.test_id).toBe(40);
    const published = toPublicDeskSnapshot({ ...desk, source: 'postgrest' });
    expect(published.source).toBe('snapshot');
    expect(published.tests).toHaveLength(desk.tests.length);
    expect(published.counts).toMatchObject({ tests_survived: 1, tests_killed: 8, tests_queued: 16 });
  });
});
