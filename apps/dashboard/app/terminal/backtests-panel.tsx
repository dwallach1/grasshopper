'use client';

import { useMemo } from 'react';

import {
  assembleBacktestView,
  equityCurveSvg,
  formatPriceSourceLabel,
  formatSymbols,
  formatWindow,
  ledgerOrMissing,
} from '../../lib/backtest-artifacts';
import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { DeskPayload } from '../../lib/ledger-types';
import { plainWords } from '../../lib/steward-books';
import { measuredForTest, perTradeText, strategyTestCounts, type MeasuredTest } from '../../lib/strategy-tests-public';
import {
  ledgerCount,
  ledgerPct,
  moneyPrecise,
  nyStamp,
  titleCase,
  toneForStatus,
} from './format';

export function BacktestsPanel({
  desk,
  selectedId,
  onSelect,
}: {
  desk: DeskPayload;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const views = useMemo(
    () =>
      desk.tests.map((test) =>
        assembleBacktestView({
          test,
          cycles: desk.cycles,
          theses: desk.theses,
          artifacts: desk.backtest_artifacts,
        }),
      ),
    [desk.tests, desk.cycles, desk.theses, desk.backtest_artifacts],
  );
  const measuredById = useMemo(() => {
    const map = new Map<number, MeasuredTest>();
    for (const test of desk.tests) {
      map.set(test.id, measuredForTest(test, desk.backtest_artifacts, desk.cycles));
    }
    return map;
  }, [desk.tests, desk.backtest_artifacts, desk.cycles]);
  const selected = views.find((row) => row.test.id === selectedId) ?? views[0];
  const scenarios = desk.scenarios.filter((row) =>
    selected ? row.test_id === selected.test.id : true,
  );
  const tally = desk.tests.length
    ? strategyTestCounts(desk.tests)
    : {
        tests_survived: desk.counts.tests_survived,
        tests_killed: desk.counts.tests_killed,
        tests_queued: desk.counts.tests_queued ?? 0,
      };

  return (
    <div className="term-grid term-grid-backtests">
      <section className="term-panel">
        <header>
          <b>STRATEGY TESTS</b>
          <span>{tally.tests_survived} survived / {tally.tests_killed} killed / {tally.tests_queued} queued</span>
        </header>
        <div className="term-scroll term-tests-table">
        <table>
          <thead>
            <tr>
              <th>Variant</th>
              <th>Thesis</th>
              <th>Status</th>
              <th>Window</th>
              <th>Symbols</th>
              <th>Price source</th>
              <th>Per trade</th>
              <th>Book drawdown</th>
              <th>Trades</th>
            </tr>
          </thead>
          <tbody>
            {views.map((row) => (
              <tr
                key={row.test.id}
                className={row.test.id === selected?.test.id ? 'sel term-pick' : 'term-pick'}
                onClick={() => onSelect(row.test.id)}
              >
                <td>{plainWords(row.test.variant_label)}</td>
                <td>{ledgerOrMissing(row.thesis_id)}</td>
                <td className={toneForStatus(row.test.status)}>{row.test.status}</td>
                <td>{formatWindow(row.window_start, row.window_end)}</td>
                <td>{formatSymbols(row.symbols)}</td>
                <td>{formatPriceSourceLabel(row)}</td>
                <td className={pnlTone(measuredById.get(row.test.id)?.per_trade?.mean ?? null)}>
                  {perTradeText(measuredById.get(row.test.id)?.per_trade) ?? '—'}
                </td>
                <td className={row.max_drawdown === null ? 'muted' : 'down'}>
                  {bookDrawdown(row.max_drawdown, row.test.status) ?? '—'}
                </td>
                <td>{ledgerCount(row.trade_count)}</td>
              </tr>
            ))}
            {!views.length && (
              <tr><td colSpan={9} className="empty">No strategy tests in ledger</td></tr>
            )}
          </tbody>
        </table>
        </div>
        <div className="term-tests-cards">
          {views.map((row) => (
            <button
              key={row.test.id}
              type="button"
              className={row.test.id === selected?.test.id ? 'term-test-card sel' : 'term-test-card'}
              onClick={() => onSelect(row.test.id)}
            >
              <div className="term-test-card-head">
                <b>{plainWords(row.test.variant_label)}</b>
                <i className={toneForStatus(row.test.status)}>{row.test.status}</i>
              </div>
              {measuredById.get(row.test.id)?.result ? (
                <p className="term-test-measured">{measuredById.get(row.test.id)?.result}</p>
              ) : null}
              {measuredById.get(row.test.id)?.book ? (
                <p className="term-test-book">{measuredById.get(row.test.id)?.book}</p>
              ) : null}
              {row.thesis_id ? <p>{row.thesis_id}</p> : null}
            </button>
          ))}
          {!views.length && <p className="empty">No strategy tests in ledger</p>}
        </div>
      </section>
      <section className="term-panel">
        {selected ? (
          <BacktestDetail view={selected} measured={measuredById.get(selected.test.id) ?? { result: null, per_trade: null, book: null }} />
        ) : <p className="empty">No test selected</p>}
      </section>
      <section className="term-panel">
        <header><b>CYCLES</b></header>
        {desk.cycles.map((cycle) => (
          <div key={cycle.id} className="term-line">
            <b>{cycle.thesis_id}</b>
            <span>{cycle.stage} · {cycle.status} · {cycle.market_regime}</span>
            <p>{cycle.hypothesis}</p>
            <p className="dim">Preregistered: {cycle.preregistered_outcome}</p>
          </div>
        ))}
        {!desk.cycles.length && <p className="empty">No research cycles in ledger</p>}
      </section>
      <section className="term-panel">
        <header>
          <b>SCENARIOS</b>
          <span>{selected ? `${scenarios.length} for variant` : desk.counts.scenario_cells}</span>
        </header>
        {scenarios.slice(0, 18).map((row) => (
          <div key={row.id} className="term-line">
            <b className={toneForStatus(row.outcome)}>{row.outcome}</b>
            <span>{row.scenario_key} · {row.market_regime} · {row.cost_multiplier}x</span>
            <i>{ledgerPct(row.metric_value)}</i>
          </div>
        ))}
        {!scenarios.length && <p className="empty">No scenarios in ledger</p>}
      </section>
    </div>
  );
}

function BacktestDetail({
  view,
  measured,
}: {
  view: ReturnType<typeof assembleBacktestView>;
  measured: MeasuredTest;
}) {
  const chart = view.chart_svg ?? equityCurveSvg(view.equity_points);
  const price = view.price_source;
  const hasArtifacts = view.artifact_count > 0;
  return (
    <>
      <header>
        <b>{plainWords(view.test.variant_label)}</b>
        <span className={toneForStatus(view.test.status)}>
          {view.test.status} · {ledgerOrMissing(view.thesis_id)}
        </span>
      </header>
      {measured.result ? <p className="term-test-measured">{measured.result}</p> : null}
      {measured.book ? <p className="term-test-book">{measured.book}</p> : null}
      {!hasArtifacts && !measured.result ? (
        <p className="empty">No per-trade result in the ledger</p>
      ) : null}
      {hasArtifacts ? (
      <>
      <p className="term-prose dim">
        {view.test.external_key}
        {view.test.failure_reason ? ` · ${view.test.failure_reason}` : ''}
      </p>
      <header>
        <b>SUMMARY</b>
        <span>summary_json</span>
      </header>
      {view.summary.length ? (
        <div className="term-kpis term-kpis-metrics">
          {view.summary.map((metric) => (
            <div key={metric.key}>
              <i>{titleCase(metric.key)}</i>
              <b>{formatMetric(metric.numeric, metric.text)}</b>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty">{NOT_IN_LEDGER}</p>
      )}
      <header>
        <b>EQUITY CURVE</b>
        <span>{view.chart_svg ? 'chart_svg' : view.equity_points.length ? 'equity_curve' : NOT_IN_LEDGER}</span>
      </header>
      {chart ? (
        <div
          className="term-chart"
          // SAFETY: markup is sanitizeSvgMarkup output or an SVG built from ledger equity points.
          dangerouslySetInnerHTML={{ __html: chart }}
        />
      ) : (
        <p className="empty">{view.artifact_count === 0 ? 'no artifacts in ledger' : NOT_IN_LEDGER}</p>
      )}
      <header>
        <b>TRADES</b>
        <span>{view.trades.length ? `${view.trades.length} in ledger` : NOT_IN_LEDGER}</span>
      </header>
      {view.trades.length ? (
        <>
          <div className="term-scroll term-test-trades-table">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Sym</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {view.trades.map((row, index) => (
                  <tr key={`${row.t ?? 't'}-${row.symbol ?? 'sym'}-${index}`}>
                    <td>{row.t ? nyStamp(row.t) : NOT_IN_LEDGER}</td>
                    <td className="sym">{ledgerOrMissing(row.symbol)}</td>
                    <td>{ledgerOrMissing(row.side)}</td>
                    <td>{row.qty === null ? NOT_IN_LEDGER : row.qty}</td>
                    <td>{row.price === null ? NOT_IN_LEDGER : moneyPrecise(row.price)}</td>
                    <td>{ledgerOrMissing(row.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="term-test-trades-cards">
            {view.trades.map((row, index) => (
              <div
                key={`${row.t ?? 't'}-${row.symbol ?? 'sym'}-${index}`}
                className="term-test-trade"
              >
                <b className="sym">{ledgerOrMissing(row.symbol)}</b>
                <span>
                  {ledgerOrMissing(row.side)}
                  {' · '}
                  {row.qty === null ? NOT_IN_LEDGER : row.qty}
                </span>
                <i>{row.price === null ? NOT_IN_LEDGER : moneyPrecise(row.price)}</i>
                <p>
                  {row.t ? nyStamp(row.t) : NOT_IN_LEDGER}
                  {row.reason ? ` · ${ledgerOrMissing(row.reason)}` : ''}
                </p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="empty">{NOT_IN_LEDGER}</p>
      )}
      <header>
        <b>PARAMS</b>
        <span>params_json</span>
      </header>
      {view.params.length ? (
        <table>
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>
            {view.params.map((row) => (
              <tr key={row.key}>
                <td>{row.key}</td>
                <td>{ledgerOrMissing(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">{NOT_IN_LEDGER}</p>
      )}
      <header>
        <b>PRICE SOURCE</b>
        <span>Financial Datasets</span>
      </header>
      {price && (price.tickers || price.interval || price.bar_start || price.bar_end || price.source) ? (
        <div className="term-line">
          <b>{price.tickers?.join(' ') || NOT_IN_LEDGER}</b>
          <span>{price.interval || NOT_IN_LEDGER}</span>
          <i>{price.source || 'financial_datasets_mcp'}</i>
          <p>
            Bar range {formatWindow(price.bar_start, price.bar_end)}
            {price.label && price.label !== price.source ? ` · ${price.label}` : ''}
          </p>
        </div>
      ) : (
        <p className="empty">{NOT_IN_LEDGER}</p>
      )}
      </>
      ) : null}
    </>
  );
}

function bookDrawdown(value: number | null, status: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (status !== 'survived' && status !== 'killed') return null;
  const points = value * 100;
  const text = points.toFixed(1);
  return `${text}%`;
}

function formatMetric(numeric: number | null, text: string | null): string {
  if (numeric !== null) {
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(4).replace(/\.?0+$/, '');
  }
  return ledgerOrMissing(text);
}

function pnlTone(value: number | null): string {
  if (value === null) return 'muted';
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'muted';
}
