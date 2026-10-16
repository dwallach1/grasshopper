import { describe, expect, test } from 'bun:test';

import { emptyMemeCoins } from './meme-book';
import { emptyPredictionMarkets } from './prediction-book';
import { fallbackTeam } from './desk-team';
import { assemblePublicDeskFromRestBag } from './ledger-live';
import { toPublicDeskSnapshot } from '@quantanamo/contracts/desk-snapshot';
import {
  measureStrategyTest,
  perTradeText,
  projectPublicTests,
  PUBLIC_SUMMARY_COLUMNS,
  PUBLIC_SUMMARY_QUERY,
  PUBLIC_TEST_QUERY,
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

  test('leads with the per-trade measurement and labels the book as secondary', () => {
    const held = measureStrategyTest({
      mean_diff_a_minus_b: 0.019635894872020693,
      bootstrap90_diff: [0.005222170077015214, 0.03414937865245927],
      hit_a: 0.7,
      hit_b: 0.5,
      trade_count: 50,
      total_return_a_book: 0.9322635607284417,
      spy_same_dates_book: 0.09744632442763934,
      events: [{ symbol: 'NFLX' }],
    }, {
      variant: 'serial-negative-reactor-hold-vs-exit-v1',
      windowStart: '2025-10-06',
      windowEnd: '2026-10-15',
    });
    expect(held.result).toBe('hold-through beat selling before by +1.96 pts/trade (90% CI +0.52 to +3.41), hit 70% vs 50%, n=50');
    expect(held.book).toBe('1-yr compounded book +93.2% (SPY +9.7%)');
    expect(held.per_trade).toMatchObject({ n: 50, unit: 'pts', mean: 1.96, hit: 0.7, hit_other: 0.5 });

    const serial = measureStrategyTest({
      mean30: 0.0023655073555425526,
      ci90: [-0.0061863714649018535, 0.011111310020344125],
      hit_rate: 0.497131931166348,
      trade_count: 523,
      total_return_book: -0.7102959919094324,
      spy_book_same_dates: -0.013363464795873248,
    }, { windowStart: '2025-10-06', windowEnd: '2026-10-06' });
    expect(serial.result).toBe('mean +0.24%/trade (90% CI -0.62 to +1.11), hit 49.7%, n=523');
    expect(serial.book).toBe('1-yr compounded book -71.0% (SPY -1.3%)');
    expect(serial.result).not.toContain('-71');
  });

  test('queued rows omit a return when the unit is not explicit', () => {
    const percentPoints = measureStrategyTest({ hit_rate: 0.5, n_trades: 2, total_return: -1.772, total_return_frac: -0.01772 });
    expect(percentPoints.result).toBe('hit 50%, n=2');
    expect(percentPoints.book).toBeNull();
    expect(percentPoints.result).not.toContain('1.8');
    expect(percentPoints.result).not.toContain('177');

    const ambiguous = measureStrategyTest({ hit_rate: 1, trade_count: 2, total_return: 0.929116 });
    expect(ambiguous.result).toBe('hit 100%, n=2');
    expect(ambiguous.result).not.toContain('92');
    expect(measureStrategyTest({ total_return: 0.929116 }).result).toBeNull();
    expect(perTradeText({ n: 2, unit: null, mean: null, ci90: null, hit: 0.5, hit_other: null })).toBeNull();
    expect(perTradeText({ n: 2, hit: 0.5 } as never)).toBeNull();
    expect(perTradeText({ n: 50, unit: 'pts', mean: 1.96, ci90: [0.52, 3.41], hit: 0.7, hit_other: 0.5 })).toBe('+1.96 pts');
  });

  test('test 16 reads the 10 bps object key, and a bare n stays n=', () => {
    const summarySelect = PUBLIC_SUMMARY_COLUMNS;
    expect(summarySelect).toContain('payload_json->by_cost->"10"->mean_net_pct');
    expect(summarySelect).not.toContain('->10->');
    const stored = {
      n: 4,
      by_cost: {
        '10': { n: 4, win: 2, mean_net_pct: -5.645, total_return: -0.2323 },
        '30': { mean_net_pct: -5.845 },
      },
    };
    const fromPayload = measureStrategyTest(stored);
    expect(fromPayload.result).toBe('mean -5.65%/trade, hit 50%, n=4');
    expect(fromPayload.per_trade).toMatchObject({ n: 4, unit: 'percent', mean: -5.65, hit: 0.5 });
    const fromSelect = measureStrategyTest({ n: 4, mean10: -5.645, win10: 2, n10: 4 });
    expect(fromSelect.result).toBe('mean -5.65%/trade, hit 50%, n=4');
    const projected = projectPublicTests(
      [{ id: 16, external_key: 'serial-gap-dump-v1-20260903', cycle_id: 25, variant_label: 'serial-gap-dump-v1', status: 'killed', tested_at: AT }],
      [{ id: 111, test_id: 16, n: 4, mean10: -5.645, win10: 2, n10: 4 }],
    );
    expect(projected[0]?.result).toBe('mean -5.65%/trade, hit 50%, n=4');
    expect(projected[0]?.per_trade).toMatchObject({ n: 4, unit: 'percent', mean: -5.65, hit: 0.5 });
    expect(measureStrategyTest({ n: 4 }).result).toBe('n=4');
    expect(measureStrategyTest({ n: 4 }).per_trade).toMatchObject({ mean: null, hit: null, unit: null });
  });

  test('public artifacts drop curves, charts, price lists, and non-results', () => {
    const slim = slimPublicArtifacts([
      {
        id: 1,
        test_id: 40,
        artifact_kind: 'summary_json',
        payload_json: { trade_count: 50, events: [{ symbol: 'NFLX' }] },
        storage_bucket: 'private',
        storage_path: 'secret/path',
      },
      { id: 2, test_id: 40, artifact_kind: 'equity_curve', payload_json: { points: [1] } },
      { id: 3, test_id: 40, artifact_kind: 'chart_svg', payload_text: '<svg></svg>' },
      { id: 4, test_id: 40, artifact_kind: 'price_source', payload_json: { tickers: ['AAPL'] } },
      { id: 5, test_id: 15, artifact_kind: 'summary_json', payload_json: { trade_count: 9 } },
      { id: 6, test_id: 1, artifact_kind: 'summary_json', payload_json: { trade_count: 1 } },
    ], [
      { id: 40, status: 'survived' },
      { id: 15, status: 'lookahead_invalid' },
      { id: 1, status: 'placeholder' },
    ]);
    expect(slim).toEqual([]);
    const byStatus = slimPublicArtifacts([
      { id: 7, test_id: 40, artifact_kind: 'note', title: 'kept' },
      { id: 8, test_id: 15, artifact_kind: 'note', title: 'lookahead leak' },
      { id: 9, test_id: 1, artifact_kind: 'note', title: 'placeholder leak' },
      { id: 10, test_id: 40, artifact_kind: 'note', title: 'path leak', storage_path: 'secret/path' },
    ], [
      { id: 40, status: 'survived' },
      { id: 15, status: 'lookahead_invalid' },
      { id: 1, status: 'placeholder' },
    ], new Set(['note']));
    expect(byStatus).toEqual([{ id: 7, test_id: 40, artifact_kind: 'note', title: 'kept' }]);
    expect(PUBLIC_SUMMARY_QUERY).toContain('artifact_kind=eq.summary_json');
    expect(PUBLIC_SUMMARY_QUERY).not.toContain('equity_curve');
    expect(PUBLIC_SUMMARY_QUERY).not.toContain('chart_svg');
    expect(PUBLIC_SUMMARY_QUERY).not.toContain('price_source');
    expect(PUBLIC_SUMMARY_COLUMNS).not.toMatch(/(^|,)payload_json(,|&|$)/);
    expect(PUBLIC_TEST_QUERY).not.toContain('params_json');
    expect(PUBLIC_TEST_QUERY).not.toContain('failure_reason');
    expect(PUBLIC_TEST_QUERY).not.toContain('autopsy');
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
        payload_json: {
          mean_diff_a_minus_b: 0.019635894872020693,
          bootstrap90_diff: [0.005222170077015214, 0.03414937865245927],
          hit_a: 0.7,
          hit_b: 0.5,
          trade_count: 50,
          total_return_a_book: 0.9322635607284417,
          spy_same_dates_book: 0.09744632442763934,
          events: [{ symbol: 'NFLX' }],
        },
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
    expect(desk.tests.find((row) => row.id === 40)?.result).toBe(
      'hold-through beat selling before by +1.96 pts/trade (90% CI +0.52 to +3.41), hit 70% vs 50%, n=50',
    );
    expect(desk.backtest_artifacts).toEqual([]);
    expect(JSON.stringify(desk.tests)).not.toContain('NFLX');
    const lesson = desk.lessons.find((row) => row.id === 132);
    expect(lesson?.test_id).toBe(40);
    const published = toPublicDeskSnapshot({ ...desk, source: 'postgrest' });
    expect(published.source).toBe('snapshot');
    expect(published.tests).toHaveLength(desk.tests.length);
    expect(published.counts).toMatchObject({ tests_survived: 1, tests_killed: 8, tests_queued: 16 });
    expect(published.backtest_artifacts).toEqual([]);
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('params_json');
    expect(wire).not.toContain('do not publish');
    expect(wire).not.toContain('events');
    expect(wire).toContain('hold-through beat selling before');
  });

  test('the public slice stays under 25 KB for the live week shape', () => {
    const summaries = [{
      id: 143,
      test_id: 40,
      mean_diff: 0.019635894872020693,
      ci_diff: [0.005222170077015214, 0.03414937865245927],
      hit_a: 0.7,
      hit_b: 0.5,
      trade_count: 50,
      book_a: 0.9322635607284417,
      spy_a: 0.09744632442763934,
      events: Array.from({ length: 50 }, () => ({ symbol: 'NFLX', path: 's3://private/blotter' })),
    }];
    const projected = projectPublicTests(finishedLedger(), summaries);
    projected.forEach((row, index) => {
      row.cycle_id = 1000 + (index % 22);
    });
    const cycles = Array.from({ length: 22 }, (_, index) => ({
      id: index === 0 ? 144 : 1000 + index,
      thesis_id: 'earnings_gap_structure',
      hypothesis: 'h'.repeat(800),
      preregistered_outcome: 'p'.repeat(800),
      stage: 'tested',
      status: 'complete',
      market_regime: null,
    }));
    const scenarios = Array.from({ length: 62 }, (_, index) => ({
      id: index + 1,
      test_id: projected[index % projected.length]?.id,
      scenario_key: 'cost',
      market_regime: 'base',
      cost_multiplier: 1,
      outcome: 'killed',
      metric_value: -0.01,
      breach_type: null,
    }));
    const published = toPublicDeskSnapshot({
      generated_at: AT,
      source: 'postgrest',
      theses: [thesis()],
      book: { current_nav: null, starting_nav: null, observed_at: null },
      routines: [],
      tests: projected,
      cycles,
      scenarios,
      backtest_artifacts: [{ id: 1, test_id: 15, artifact_kind: 'summary_json', storage_path: 'secret' }],
      counts: { sources: 0, symbols: 0, open_research: 0, tests_killed: 0, tests_survived: 0, scenario_cells: 0, open_positions: 0, queued_tasks: 0 },
    });
    const slice = JSON.stringify({
      tests: published.tests,
      cycles: published.cycles,
      scenarios: published.scenarios,
      backtest_artifacts: published.backtest_artifacts,
    });
    expect(slice.length).toBeLessThan(25_000);
    expect(published.backtest_artifacts).toEqual([]);
    expect(slice).not.toContain('s3://private');
    const hypothesis = (published.cycles as { hypothesis?: string }[])[0]?.hypothesis ?? '';
    expect(hypothesis.length).toBeLessThanOrEqual(160);
  });
});
