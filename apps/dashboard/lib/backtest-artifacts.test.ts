import { describe, expect, test } from 'bun:test';

import {
  assembleBacktestView,
  equityCurveSvg,
  formatPriceSourceLabel,
  formatSymbols,
  formatWindow,
  mapBacktestArtifacts,
  parseChartSvg,
  parseEquityCurve,
  parseParams,
  parsePriceSource,
  parseSummaryMetrics,
  parseTrades,
  sanitizeSvgMarkup,
} from './backtest-artifacts';
import { NOT_IN_LEDGER } from './book-performance';
import { mapTests } from './ledger-map';
import type {
  BacktestArtifactRow,
  CycleRow,
  StrategyTestRow,
  ThesisRow,
} from './ledger-types';

const testedAt = '2026-08-26T20:00:00.000Z';

function seedTest(partial: Partial<StrategyTestRow> & Pick<StrategyTestRow, 'id' | 'external_key' | 'variant_label'>): StrategyTestRow {
  return {
    cycle_id: 1,
    status: 'survived',
    total_return: 11.2,
    max_drawdown: -7.4,
    deflated_sharpe: 0.8,
    cost_multiplier: 1,
    stress_regime: 'base',
    failure_reason: null,
    autopsy: null,
    tested_at: testedAt,
    price_source: null,
    window_start: null,
    window_end: null,
    symbols: null,
    params_json: null,
    ...partial,
  };
}

function artifact(partial: Partial<BacktestArtifactRow> & Pick<BacktestArtifactRow, 'id' | 'artifact_kind'>): BacktestArtifactRow {
  return {
    test_id: 10,
    thesis_id: 'ai_power_nuclear',
    title: partial.artifact_kind,
    mime_type: 'application/json',
    payload_json: null,
    payload_items: null,
    payload_text: null,
    storage_bucket: null,
    storage_path: null,
    source: 'financial_datasets_mcp',
    created_at: testedAt,
    ...partial,
  };
}

const cycle: CycleRow = {
  id: 1,
  external_key: 'ai-power',
  thesis_id: 'ai_power_nuclear',
  hypothesis: 'Power bottleneck',
  preregistered_outcome: 'survive',
  preregistered_at: testedAt,
  stage: 'backtest',
  status: 'open',
  iteration: 1,
  market_regime: 'base',
};

const thesis: ThesisRow = {
  id: 'ai_power_nuclear',
  name: 'AI power bottleneck beneficiaries',
  summary: 'Power',
  status: 'hardening',
  confidence: 80,
  time_horizon: 'medium',
  stance: 'bullish',
  variant_perception: null,
  falsifier: null,
  created_at: testedAt,
  updated_at: testedAt,
  symbols: ['VST', 'CEG'],
};

describe('mapTests backtest columns', () => {
  test('keeps seed rows with null window/symbols/price_source', () => {
    const [row] = mapTests([
      {
        id: 1,
        external_key: 'ai-power-base',
        cycle_id: 1,
        variant_label: 'power-breadth-v4',
        status: 'survived',
        total_return: 11.2,
        max_drawdown: -7.4,
        deflated_sharpe: 0.9,
        cost_multiplier: 1,
        stress_regime: 'base',
        failure_reason: null,
        autopsy: null,
        tested_at: testedAt,
        price_source: null,
        window_start: null,
        window_end: null,
        symbols: null,
        params_json: null,
      },
    ]);
    expect(row?.external_key).toBe('ai-power-base');
    expect(row?.price_source).toBeNull();
    expect(row?.window_start).toBeNull();
    expect(row?.symbols).toBeNull();
    expect(row?.params_json).toBeNull();
    expect(row?.total_return).toBe(11.2);
  });
});

describe('backtest artifact parsing', () => {
  test('maps REST rows and prefers latest artifact per kind', () => {
    const rows = mapBacktestArtifacts([
      {
        id: 1,
        test_id: 10,
        thesis_id: 'ai_power_nuclear',
        artifact_kind: 'summary_json',
        title: 'old',
        mime_type: 'application/json',
        payload_json: { total_return: 1 },
        storage_bucket: null,
        storage_path: null,
        source: 'financial_datasets_mcp',
        created_at: '2026-08-26T19:00:00.000Z',
      },
      {
        id: 2,
        test_id: 10,
        thesis_id: 'ai_power_nuclear',
        artifact_kind: 'summary_json',
        title: 'new',
        mime_type: 'application/json',
        payload_json: { total_return: 4.2, max_drawdown: -3.1, trade_count: 6 },
        storage_bucket: null,
        storage_path: null,
        source: 'financial_datasets_mcp',
        created_at: '2026-08-26T21:00:00.000Z',
      },
    ]);
    expect(rows[0]?.id).toBe(2);
    const metrics = parseSummaryMetrics(rows[0] ?? null);
    expect(metrics.find((row) => row.key === 'total_return')?.numeric).toBe(4.2);
    expect(metrics.find((row) => row.key === 'missing')).toBeUndefined();
  });

  test('does not invent equity points or a curve from missing artifacts', () => {
    const empty = parseEquityCurve(null);
    expect(empty).toEqual([]);
    expect(equityCurveSvg([])).toBeNull();
    expect(equityCurveSvg([{ t: '2026-01-02', equity: 100, drawdown: 0 }])).toBeNull();
  });

  test('reads equity_curve arrays as [{t, equity, drawdown}] only', () => {
    const points = parseEquityCurve(
      artifact({
        id: 3,
        artifact_kind: 'equity_curve',
        payload_items: [
          { t: '2026-01-02', equity: 100, drawdown: 0 },
          { t: '2026-01-03', equity: 104, drawdown: -1.2 },
          { t: '2026-01-04', nav: 101 },
        ],
      }),
    );
    expect(points).toEqual([
      { t: '2026-01-02', equity: 100, drawdown: 0 },
      { t: '2026-01-03', equity: 104, drawdown: -1.2 },
      { t: '2026-01-04', equity: 101, drawdown: null },
    ]);
    const svg = equityCurveSvg(points);
    expect(svg).toContain('<polyline');
    expect(svg).toContain('stroke="#ff8a00"');
  });

  test('parses trades without filling missing qty/price', () => {
    const trades = parseTrades(
      artifact({
        id: 4,
        artifact_kind: 'trades',
        payload_json: {
          trades: [
            { t: '2026-01-03T15:00:00.000Z', symbol: 'VST', side: 'buy', qty: 10, price: 12.5, reason: 'signal' },
            { symbol: 'CEG', side: 'sell' },
          ],
        },
      }),
    );
    expect(trades[0]?.qty).toBe(10);
    expect(trades[0]?.price).toBe(12.5);
    expect(trades[1]?.qty).toBeNull();
    expect(trades[1]?.price).toBeNull();
    expect(trades[1]?.t).toBeNull();
  });

  test('strips script handlers from chart_svg payload_json.svg', () => {
    const svg = parseChartSvg(
      artifact({
        id: 5,
        artifact_kind: 'chart_svg',
        payload_json: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><polyline points="0,0 1,1" onclick="alert(2)"/></svg>',
        },
      }),
    );
    expect(svg).toContain('<polyline');
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('onclick');
    expect(sanitizeSvgMarkup('<div>nope</div>')).toBeNull();
  });

  test('price_source exposes tickers, interval, and bar range', () => {
    const parsed = parsePriceSource(
      artifact({
        id: 6,
        artifact_kind: 'price_source',
        payload_json: {
          tickers: ['VST', 'CEG'],
          interval: '1d',
          start: '2024-01-02',
          end: '2026-08-01',
          source: 'financial_datasets_mcp',
        },
      }),
      null,
    );
    expect(parsed?.tickers).toEqual(['VST', 'CEG']);
    expect(parsed?.interval).toBe('1d');
    expect(parsed?.bar_start).toBe('2024-01-02');
    expect(parsed?.bar_end).toBe('2026-08-01');
  });

  test('params come from artifact or column, never invented keys', () => {
    const fromArtifact = parseParams(
      artifact({
        id: 7,
        artifact_kind: 'params_json',
        payload_json: { lookback: 20, cost_bps: 5 },
      }),
      { ignored: 1 },
    );
    expect(fromArtifact.map((row) => row.key)).toEqual(['lookback', 'cost_bps']);
    const fromColumn = parseParams(null, { lookback: 10 });
    expect(fromColumn).toEqual([{ key: 'lookback', value: '10' }]);
    expect(parseParams(null, null)).toEqual([]);
  });
});

describe('assembleBacktestView', () => {
  test('seed rows without artifacts stay listable and say so', () => {
    const view = assembleBacktestView({
      test: seedTest({ id: 1, external_key: 'ai-power-base', variant_label: 'power-breadth-v4' }),
      cycles: [cycle],
      theses: [thesis],
      artifacts: [],
    });
    expect(view.thesis_id).toBe('ai_power_nuclear');
    expect(view.artifact_count).toBe(0);
    expect(view.trade_count).toBeNull();
    expect(view.equity_points).toEqual([]);
    expect(view.chart_svg).toBeNull();
    expect(view.trades).toEqual([]);
    expect(formatWindow(view.window_start, view.window_end)).toBe(NOT_IN_LEDGER);
    expect(formatSymbols(view.symbols)).toBe(NOT_IN_LEDGER);
    expect(formatPriceSourceLabel(view)).toBe(NOT_IN_LEDGER);
    expect(view.total_return).toBe(11.2);
  });

  test('prefers chart_svg over drawing, and trade count from trades artifact', () => {
    const chart = '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,10 10,0"/></svg>';
    const view = assembleBacktestView({
      test: seedTest({
        id: 10,
        external_key: 'ai-power-fd',
        variant_label: 'power-fd',
        total_return: null,
        max_drawdown: null,
        window_start: '2024-01-02',
        window_end: '2026-08-01',
        symbols: ['VST', 'CEG'],
        price_source: 'financial_datasets_mcp',
      }),
      cycles: [cycle],
      theses: [thesis],
      artifacts: [
        artifact({
          id: 1,
          artifact_kind: 'chart_svg',
          payload_json: { svg: chart },
        }),
        artifact({
          id: 2,
          artifact_kind: 'equity_curve',
          payload_items: [
            { t: '2026-01-02', equity: 100 },
            { t: '2026-01-03', equity: 110 },
          ],
        }),
        artifact({
          id: 3,
          artifact_kind: 'trades',
          payload_items: [
            { t: '2026-01-03', symbol: 'VST', side: 'buy', qty: 1, price: 10, reason: 'entry' },
            { t: '2026-01-10', symbol: 'VST', side: 'sell', qty: 1, price: 11, reason: 'exit' },
          ],
        }),
        artifact({
          id: 4,
          artifact_kind: 'summary_json',
          payload_json: { total_return: 8.1, trade_count: 99 },
        }),
      ],
    });
    expect(view.chart_svg).toContain('polyline');
    expect(view.equity_points).toHaveLength(2);
    expect(view.trade_count).toBe(2);
    expect(view.total_return).toBeNull();
    expect(view.summary.find((row) => row.key === 'trade_count')?.numeric).toBe(99);
    expect(formatPriceSourceLabel(view)).toContain('financial_datasets');
  });
});
