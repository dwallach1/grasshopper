import type { Database } from './database';

const PROVIDER = 'financialdatasets.ai';
const BASE_URL = 'https://api.financialdatasets.ai';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1_500];

export type FinancialRequest = {
  endpoint: string;
  params?: Record<string, string | number | boolean>;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown> | null;
  force?: boolean;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(spec: FinancialRequest): Promise<string> {
  return sha256(canonicalJson({ provider: PROVIDER, method: spec.method || 'GET', endpoint: `/${spec.endpoint.replace(/^\/+/, '')}`, params: spec.params || {}, body: spec.body || null }));
}

function ttl(spec: FinancialRequest): { seconds: number; policy: string } {
  const endpoint = `/${spec.endpoint.replace(/^\/+/, '')}`;
  const policies: Array<[string, number, string]> = [
    ['/prices/snapshot', 900, 'market_snapshot_15m'], ['/prices', 21_600, 'daily_prices_6h'],
    ['/news', 3_600, 'news_1h'], ['/earnings', 21_600, 'earnings_6h'], ['/filings', 21_600, 'filings_6h'],
    ['/insider', 43_200, 'insider_12h'], ['/institutional', 86_400, 'institutional_1d'],
    ['/financial-metrics/snapshot', 21_600, 'metrics_snapshot_6h'], ['/financial-metrics', 86_400, 'metrics_1d'],
    ['/financials', 604_800, 'statements_7d'], ['/company/facts', 2_592_000, 'company_facts_30d'],
  ];
  const found = policies.find(([prefix]) => endpoint.startsWith(prefix));
  return found ? { seconds: found[1], policy: found[2] } : { seconds: 86_400, policy: 'default_1d' };
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) throw new Error('Financial response exceeded its size limit');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel('response size limit exceeded');
        throw new Error('Financial response exceeded its size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function providerFetch(url: URL, spec: FinancialRequest, apiKey: string): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: spec.method || 'GET',
      headers: { 'x-api-key': apiKey, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'ThesisForge/1.0 knowledge-pipeline' },
      body: spec.body ? canonicalJson(spec.body) : undefined,
    });
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= RETRY_DELAYS_MS.length) return response;
    await response.body?.cancel('retryable provider response');
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}

function records(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  if (!payload || typeof payload !== 'object') return [];
  const arrays = Object.values(payload).filter((item): item is Array<Record<string, unknown>> => Array.isArray(item) && item.every((row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row)));
  return arrays.sort((left, right) => right.length - left.length)[0] || [payload as Record<string, unknown>];
}

async function normalize(database: Database, spec: FinancialRequest, payload: unknown, requestId: number, fetchedAt: string): Promise<number> {
  const dataset = spec.endpoint.replace(/^\/+|\/+$/g, '').replaceAll('/', '.');
  const fallback = String(spec.params?.ticker || '').toUpperCase() || null;
  const rows = await Promise.all(records(payload).map(async (record, index) => {
    const ticker = String(record.ticker || record.symbol || fallback || '').toUpperCase() || null;
    const identity = Object.fromEntries(['ticker','symbol','cik','accession_number','report_period','report_date','filing_date','date','period','fiscal_period','transaction_date','title','url'].flatMap((key) => record[key] == null ? [] : [[key, record[key]]]));
    const recordKey = await sha256(canonicalJson(Object.keys(identity).length ? identity : { index, query: await fingerprint(spec) }));
    const payloadJson = canonicalJson(record);
    return { provider: PROVIDER, dataset, ticker, record_key: recordKey, period: record.period || spec.params?.period || null, report_period: record.report_period || record.report_date || record.date || null, filing_date: record.filing_date || record.accepted_date || null, fetched_at: fetchedAt, record_sha256: await sha256(payloadJson), payload_json: record, source_request_id: requestId };
  }));
  if (!rows.length) return 0;
  return database.execute(`
    insert into financial_records(provider,dataset,ticker,record_key,period,report_period,filing_date,fetched_at,record_sha256,payload_json,source_request_id)
    select provider,dataset,ticker,record_key,period,report_period,filing_date,fetched_at,record_sha256,payload_json,source_request_id
    from jsonb_to_recordset($1::jsonb) as x(provider text,dataset text,ticker text,record_key text,period text,report_period date,filing_date date,fetched_at timestamptz,record_sha256 text,payload_json jsonb,source_request_id bigint)
    on conflict(provider,dataset,record_key,record_sha256) do nothing
  `, [JSON.stringify(rows)]);
}

async function decodeStored(body: Uint8Array, encoding: string): Promise<unknown> {
  let bytes = Uint8Array.from(body);
  if (encoding === 'gzip') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function fetchFinancialData(database: Database, apiKey: string, spec: FinancialRequest): Promise<{ payload: unknown; source: 'cache' | 'network'; requestId: number; normalized: number; status: number }> {
  const requestFingerprint = await fingerprint(spec);
  if (!spec.force) {
    const cached = await database.query<{ id: number; response_body: Uint8Array; response_encoding: string; status_code: number }>(`
      select r.id,r.response_body,r.response_encoding,r.status_code from financial_request_cache c join financial_api_requests r on r.id=c.request_id
      where c.request_fingerprint=$1 and c.expires_at>now() and r.status_code between 200 and 299
    `, [requestFingerprint]);
    if (cached[0]) {
      await database.execute("insert into financial_access_log(request_fingerprint,request_id,access_type,accessed_at,detail) values ($1,$2,'cache',now(),'fresh worker response')", [requestFingerprint, cached[0].id]);
      return { payload: await decodeStored(cached[0].response_body, cached[0].response_encoding), source: 'cache', requestId: Number(cached[0].id), normalized: 0, status: Number(cached[0].status_code) };
    }
  }
  if (!apiKey) throw new Error('Financial Datasets API key is unavailable');
  const endpoint = `/${spec.endpoint.replace(/^\/+/, '')}`;
  const url = new URL(endpoint, BASE_URL);
  for (const [key, value] of Object.entries(spec.params || {}).sort()) url.searchParams.set(key, String(value));
  const startedAt = new Date().toISOString();
  const response = await providerFetch(url, spec, apiKey);
  const bytes = await readBounded(response);
  const completedAt = new Date().toISOString();
  const text = new TextDecoder().decode(bytes);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { payload = { raw_text: text }; }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });
  const inserted = await database.query<{ id: number }>(`
    insert into financial_api_requests(provider,request_fingerprint,method,endpoint,params_json,body_json,requested_at,completed_at,status_code,response_headers_json,response_sha256,response_encoding,response_body,error_text)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'identity',$12,$13) returning id
  `, [PROVIDER, requestFingerprint, spec.method || 'GET', endpoint, JSON.stringify(spec.params || {}), spec.body ? JSON.stringify(spec.body) : null, startedAt, completedAt, response.status, JSON.stringify(responseHeaders), await sha256(bytes), bytes, response.ok ? null : `HTTP ${response.status}`]);
  const requestId = Number(inserted[0].id);
  await database.execute("insert into financial_access_log(request_fingerprint,request_id,access_type,accessed_at,detail) values ($1,$2,'network',now(),$3)", [requestFingerprint, requestId, `HTTP ${response.status}`]);
  if (!response.ok) return { payload, source: 'network', requestId, normalized: 0, status: response.status };
  const policy = ttl(spec);
  await database.execute(`
    insert into financial_request_cache(request_fingerprint,request_id,cached_at,expires_at,freshness_policy)
    values ($1,$2,now(),now()+($3 * interval '1 second'),$4)
    on conflict(request_fingerprint) do update set request_id=excluded.request_id,cached_at=excluded.cached_at,expires_at=excluded.expires_at,freshness_policy=excluded.freshness_policy
  `, [requestFingerprint, requestId, policy.seconds, policy.policy]);
  const normalized = await normalize(database, spec, payload, requestId, completedAt);
  return { payload, source: 'network', requestId, normalized, status: response.status };
}
