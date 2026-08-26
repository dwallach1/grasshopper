import { z } from 'zod';

import { NOT_IN_LEDGER } from './book-performance';
import { requireIso } from './numbers';
import type { JsonObjectRow } from './ledger-map';
import type {
  BacktestArtifactKind,
  BacktestArtifactRow,
  BacktestMetric,
  BacktestParam,
  BacktestPriceSource,
  BacktestTrade,
  BacktestView,
  CycleRow,
  EquityPoint,
  JsonBag,
  StrategyTestRow,
  ThesisRow,
} from './ledger-types';

export const BACKTEST_ARTIFACT_KINDS = [
  'summary_json',
  'equity_curve',
  'trades',
  'daily_returns',
  'params_json',
  'price_source',
  'chart_svg',
] as const;

const ArtifactKindSchema = z.enum(BACKTEST_ARTIFACT_KINDS);

const Id = z.union([z.string(), z.number()]).transform((value) => Number(value));
const Timestamp = z.union([z.string(), z.date()]).transform((value) => requireIso(value, 'timestamp'));
const OptionalText = z.union([z.string(), z.null()]).optional().transform((value) => value ?? null);
const JsonObject = z.object({}).passthrough();
const JsonObjectArray = z.array(JsonObject);

const PayloadSchema = z.union([JsonObject, JsonObjectArray, z.string(), z.null()]).optional();

const ArtifactSchema = z
  .object({
    id: Id,
    test_id: Id,
    thesis_id: OptionalText,
    artifact_kind: ArtifactKindSchema,
    title: z.string(),
    mime_type: z.string().optional().default('application/json'),
    payload_json: PayloadSchema,
    storage_bucket: OptionalText,
    storage_path: OptionalText,
    source: z.string().optional().default('financial_datasets_mcp'),
    created_at: Timestamp,
  })
  .passthrough();

export function mapBacktestArtifacts(rows: JsonObjectRow[]): BacktestArtifactRow[] {
  const mapped = z.array(ArtifactSchema).parse(rows).map((row) => {
    const payload = splitPayload(row.payload_json ?? null);
    return {
      id: row.id,
      test_id: row.test_id,
      thesis_id: row.thesis_id,
      artifact_kind: row.artifact_kind,
      title: row.title,
      mime_type: row.mime_type,
      payload_json: payload.object,
      payload_items: payload.items,
      payload_text: payload.text,
      storage_bucket: row.storage_bucket,
      storage_path: row.storage_path,
      source: row.source,
      created_at: row.created_at,
    };
  });
  return mapped.sort((a, b) => {
    const byTime = b.created_at.localeCompare(a.created_at);
    return byTime !== 0 ? byTime : b.id - a.id;
  });
}

type PayloadSplit = {
  object: JsonBag | null;
  items: JsonBag[] | null;
  text: string | null;
};

function splitPayload(raw: z.infer<typeof PayloadSchema> | null): PayloadSplit {
  if (raw === null || raw === undefined) {
    return { object: null, items: null, text: null };
  }
  const asText = z.string().safeParse(raw);
  if (asText.success) {
    const parsedJson = parseJsonText(asText.data);
    if (parsedJson) return parsedJson;
    return { object: null, items: null, text: asText.data };
  }
  const asArray = JsonObjectArray.safeParse(raw);
  if (asArray.success) {
    return { object: null, items: asArray.data.map(asJsonBag), text: null };
  }
  const asObject = JsonObject.safeParse(raw);
  if (asObject.success) {
    return { object: asJsonBag(asObject.data), items: null, text: null };
  }
  return { object: null, items: null, text: null };
}

function parseJsonText(raw: string): PayloadSplit | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return splitPayload(PayloadSchema.parse(JSON.parse(trimmed)));
  } catch {
    return null;
  }
}

function asJsonBag(row: JsonObjectRow): JsonBag {
  // SAFETY: jsonb from PostgREST/postgres is a JSON object; kind parsers re-decode fields.
  return row as JsonBag;
}

function latestOfKind(
  artifacts: BacktestArtifactRow[],
  testId: number,
  kind: BacktestArtifactKind,
): BacktestArtifactRow | null {
  const matches = artifacts.filter((row) => row.test_id === testId && row.artifact_kind === kind);
  return matches[0] ?? null;
}

const TimeField = z.union([z.string(), z.number(), z.date()]).transform((value) => {
  if (value instanceof Date) return value.toISOString();
  const numeric = z.number().safeParse(value);
  if (numeric.success) {
    const millis = numeric.data > 1e12 ? numeric.data : numeric.data * 1000;
    const parsed = new Date(millis);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return String(numeric.data);
  }
  return String(value);
});

const OptionalTime = z.union([TimeField, z.null()]).optional().transform((value) => value ?? null);

const EquityPointSchema = z
  .object({
    t: OptionalTime,
    time: OptionalTime,
    timestamp: OptionalTime,
    date: OptionalTime,
    equity: z.union([z.string(), z.number(), z.null()]).optional(),
    nav: z.union([z.string(), z.number(), z.null()]).optional(),
    drawdown: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .passthrough();

export function parseEquityCurve(artifact: BacktestArtifactRow | null): EquityPoint[] {
  if (!artifact) return [];
  const rows = rowsFromArtifact(artifact, ['points', 'curve', 'equity_curve', 'items', 'data']);
  const points: EquityPoint[] = [];
  for (const row of rows) {
    const parsed = EquityPointSchema.safeParse(row);
    if (!parsed.success) continue;
    const equity = firstNumber([parsed.data.equity, parsed.data.nav]);
    if (equity === null) continue;
    points.push({
      t: parsed.data.t ?? parsed.data.time ?? parsed.data.timestamp ?? parsed.data.date,
      equity,
      drawdown: optionalFinite(parsed.data.drawdown ?? null),
    });
  }
  return points;
}

const TradeSchema = z
  .object({
    t: OptionalTime,
    time: OptionalTime,
    timestamp: OptionalTime,
    symbol: OptionalText,
    side: OptionalText,
    qty: z.union([z.string(), z.number(), z.null()]).optional(),
    quantity: z.union([z.string(), z.number(), z.null()]).optional(),
    price: z.union([z.string(), z.number(), z.null()]).optional(),
    reason: OptionalText,
    note: OptionalText,
  })
  .passthrough();

export function parseTrades(artifact: BacktestArtifactRow | null): BacktestTrade[] {
  if (!artifact) return [];
  const rows = rowsFromArtifact(artifact, ['trades', 'fills', 'items', 'data']);
  const trades: BacktestTrade[] = [];
  for (const row of rows) {
    const parsed = TradeSchema.safeParse(row);
    if (!parsed.success) continue;
    trades.push({
      t: parsed.data.t ?? parsed.data.time ?? parsed.data.timestamp,
      symbol: emptyToNull(parsed.data.symbol),
      side: emptyToNull(parsed.data.side),
      qty: firstNumber([parsed.data.qty, parsed.data.quantity]),
      price: optionalFinite(parsed.data.price ?? null),
      reason: emptyToNull(parsed.data.reason ?? parsed.data.note),
    });
  }
  return trades;
}

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function parseSummaryMetrics(artifact: BacktestArtifactRow | null): BacktestMetric[] {
  const object = summaryObject(artifact);
  if (!object) return [];
  const metrics: BacktestMetric[] = [];
  for (const key of Object.keys(object)) {
    const raw = object[key];
    const scalar = Scalar.safeParse(raw);
    if (!scalar.success) continue;
    if (scalar.data === null) {
      metrics.push({ key, numeric: null, text: null });
      continue;
    }
    const asNumber = z.number().safeParse(scalar.data);
    if (asNumber.success) {
      metrics.push({ key, numeric: asNumber.data, text: null });
      continue;
    }
    const asBool = z.boolean().safeParse(scalar.data);
    if (asBool.success) {
      metrics.push({ key, numeric: null, text: asBool.data ? 'true' : 'false' });
      continue;
    }
    const text = String(scalar.data);
    metrics.push({
      key,
      numeric: optionalFinite(text),
      text,
    });
  }
  return metrics;
}

function summaryObject(artifact: BacktestArtifactRow | null): JsonBag | null {
  if (!artifact) return null;
  if (artifact.payload_json) {
    const nested = JsonObject.safeParse(artifact.payload_json.metrics ?? artifact.payload_json.summary);
    if (nested.success) return asJsonBag(nested.data);
    return artifact.payload_json;
  }
  return null;
}

export function parseParams(artifact: BacktestArtifactRow | null, column: JsonBag | null): BacktestParam[] {
  const object = artifact?.payload_json ?? (artifact ? objectFromItems(artifact) : null) ?? column;
  if (!object) return [];
  const nested = JsonObject.safeParse(object.params ?? object.parameters);
  const source = nested.success ? asJsonBag(nested.data) : object;
  const params: BacktestParam[] = [];
  for (const key of Object.keys(source)) {
    const raw = source[key];
    const scalar = Scalar.safeParse(raw);
    if (scalar.success) {
      params.push({
        key,
        value: scalar.data === null ? null : String(scalar.data),
      });
      continue;
    }
    const array = z.array(Scalar).safeParse(raw);
    if (array.success) {
      params.push({
        key,
        value: array.data.map((item) => (item === null ? '' : String(item))).join(', '),
      });
    }
  }
  return params;
}

const StringList = z.union([
  z.array(z.string()),
  z.string().transform((value) => value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)),
]);

export function parsePriceSource(
  artifact: BacktestArtifactRow | null,
  column: string | null,
): BacktestPriceSource | null {
  const object = artifact?.payload_json;
  if (!object && !column) return null;
  const tickersParsed = StringList.safeParse(
    object?.tickers ?? object?.symbols ?? object?.ticker,
  );
  const intervalParsed = z.string().min(1).safeParse(
    object?.interval ?? object?.timeframe ?? object?.bar_interval ?? object?.resolution,
  );
  const startParsed = z.union([z.string(), z.date()]).safeParse(
    object?.bar_start ?? object?.window_start ?? object?.start ?? object?.from ?? object?.start_date,
  );
  const endParsed = z.union([z.string(), z.date()]).safeParse(
    object?.bar_end ?? object?.window_end ?? object?.end ?? object?.to ?? object?.end_date,
  );
  const sourceParsed = z.string().min(1).safeParse(object?.source ?? object?.provider);
  return {
    tickers: tickersParsed.success && tickersParsed.data.length ? tickersParsed.data : null,
    interval: intervalParsed.success ? intervalParsed.data : null,
    bar_start: startParsed.success ? dateOnly(startParsed.data) : null,
    bar_end: endParsed.success ? dateOnly(endParsed.data) : null,
    source: sourceParsed.success ? sourceParsed.data : column,
    label: column,
  };
}

export function parseChartSvg(artifact: BacktestArtifactRow | null): string | null {
  if (!artifact) return null;
  const candidates = [
    artifact.payload_text,
    stringField(artifact.payload_json, 'svg'),
    stringField(artifact.payload_json, 'markup'),
    stringField(artifact.payload_json, 'chart'),
    stringField(artifact.payload_json, 'svg_markup'),
  ];
  for (const candidate of candidates) {
    const sanitized = sanitizeSvgMarkup(candidate);
    if (sanitized) return sanitized;
  }
  return null;
}

export function sanitizeSvgMarkup(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/<svg[\s>]/i.test(trimmed)) return null;
  const withoutBlocked = trimmed
    .replace(/<(script|iframe|object|embed|foreignObject|link|meta|base|applet)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|object|embed|foreignObject|link|meta|base|applet)\b[^>]*\/?>/gi, '');
  const withoutHandlers = withoutBlocked.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  const withoutJsUrls = withoutHandlers.replace(
    /\s(href|src|xlink:href)\s*=\s*(['"])\s*(javascript:|data:text\/html)[\s\S]*?\2/gi,
    '',
  );
  if (!/<svg[\s>]/i.test(withoutJsUrls)) return null;
  return withoutJsUrls;
}

export function equityCurveSvg(points: EquityPoint[]): string | null {
  if (points.length < 2) return null;
  const equities = points.map((point) => point.equity);
  const min = Math.min(...equities);
  const max = Math.max(...equities);
  const span = max - min;
  const ySpan = span === 0 ? 1 : span;
  const times = points.map((point) => Date.parse(point.t ?? ''));
  const useTime = times.every((value) => !Number.isNaN(value));
  const xs = useTime ? times : points.map((_, index) => index);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const xSpan = maxX - minX === 0 ? 1 : maxX - minX;
  const width = 640;
  const height = 180;
  const pad = 8;
  const coords = points.map((point, index) => {
    const x = pad + ((xs[index]! - minX) / xSpan) * (width - pad * 2);
    const y = height - pad - ((point.equity - min) / ySpan) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Equity curve from ledger">
    <polyline fill="none" stroke="#ff8a00" stroke-width="1.6" points="${coords.join(' ')}" />
  </svg>`;
}

export function assembleBacktestView(input: {
  test: StrategyTestRow;
  cycles: CycleRow[];
  theses: ThesisRow[];
  artifacts: BacktestArtifactRow[];
}): BacktestView {
  const { test, cycles, theses, artifacts } = input;
  const forTest = artifacts.filter((row) => row.test_id === test.id);
  const cycle = cycles.find((row) => row.id === test.cycle_id);
  const thesisId = cycle?.thesis_id ?? latestOfKind(forTest, test.id, 'summary_json')?.thesis_id ?? null;
  const thesis = theses.find((row) => row.id === thesisId);
  const summaryArtifact = latestOfKind(forTest, test.id, 'summary_json');
  const equityArtifact = latestOfKind(forTest, test.id, 'equity_curve');
  const tradesArtifact = latestOfKind(forTest, test.id, 'trades');
  const paramsArtifact = latestOfKind(forTest, test.id, 'params_json');
  const priceArtifact = latestOfKind(forTest, test.id, 'price_source');
  const chartArtifact = latestOfKind(forTest, test.id, 'chart_svg');
  const summary = parseSummaryMetrics(summaryArtifact);
  const trades = parseTrades(tradesArtifact);
  const equity_points = parseEquityCurve(equityArtifact);
  const tradeCountFromSummary = metricNumber(summary, 'trade_count') ?? metricNumber(summary, 'trades');
  const trade_count = tradesArtifact ? trades.length : tradeCountFromSummary;
  return {
    test,
    thesis_id: thesisId,
    thesis_name: thesis?.name ?? thesisId,
    artifact_kinds: [...new Set(forTest.map((row) => row.artifact_kind))],
    artifact_count: forTest.length,
    window_start: test.window_start,
    window_end: test.window_end,
    symbols: nonempty(test.symbols),
    price_source_column: emptyToNull(test.price_source),
    total_return: test.total_return,
    max_drawdown: test.max_drawdown,
    trade_count,
    summary,
    equity_points,
    chart_svg: parseChartSvg(chartArtifact),
    trades,
    params: parseParams(paramsArtifact, test.params_json),
    price_source: parsePriceSource(priceArtifact, emptyToNull(test.price_source)),
  };
}

export function missingLedger(value: string | number | null | undefined): boolean {
  return value === null || value === undefined || value === '';
}

export function ledgerOrMissing(value: string | null | undefined): string {
  return emptyToNull(value) ?? NOT_IN_LEDGER;
}

export function formatWindow(start: string | null, end: string | null): string {
  if (!start && !end) return NOT_IN_LEDGER;
  if (start && end) return `${start} → ${end}`;
  return start ?? end ?? NOT_IN_LEDGER;
}

export function formatSymbols(symbols: string[] | null): string {
  if (!symbols || symbols.length === 0) return NOT_IN_LEDGER;
  return symbols.join(' ');
}

export function formatPriceSourceLabel(view: BacktestView): string {
  const detail = view.price_source;
  if (detail?.tickers?.length) {
    const interval = detail.interval ? ` ${detail.interval}` : '';
    return `${detail.tickers.join(' ')}${interval}`;
  }
  if (detail?.source) return detail.source;
  return ledgerOrMissing(view.price_source_column);
}

function rowsFromArtifact(artifact: BacktestArtifactRow, keys: readonly string[]): JsonBag[] {
  if (artifact.payload_items) return artifact.payload_items;
  if (!artifact.payload_json) return [];
  for (const key of keys) {
    const parsed = JsonObjectArray.safeParse(artifact.payload_json[key]);
    if (parsed.success) return parsed.data.map(asJsonBag);
  }
  return [];
}

function objectFromItems(artifact: BacktestArtifactRow): JsonBag | null {
  if (artifact.payload_json) return artifact.payload_json;
  if (artifact.payload_items?.[0]) return artifact.payload_items[0];
  return null;
}

function optionalFinite(value: string | number | boolean | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = z.union([z.string(), z.number()]).safeParse(value);
  if (!parsed.success) return null;
  const n = Number(parsed.data);
  if (!Number.isFinite(n)) return null;
  return n;
}

function firstNumber(values: Array<string | number | null | undefined>): number | null {
  for (const value of values) {
    const parsed = optionalFinite(value ?? null);
    if (parsed !== null) return parsed;
  }
  return null;
}

function metricNumber(metrics: BacktestMetric[], key: string): number | null {
  return metrics.find((row) => row.key === key)?.numeric ?? null;
}

function stringField(object: JsonBag | null, key: string): string | null {
  if (!object) return null;
  const parsed = z.string().safeParse(object[key]);
  return parsed.success ? parsed.data : null;
}

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nonempty(values: string[] | null): string[] | null {
  if (!values || values.length === 0) return null;
  return values;
}
