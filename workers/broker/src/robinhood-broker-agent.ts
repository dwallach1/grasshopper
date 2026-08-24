import { Agent, DurableObjectOAuthClientProvider, getAgentByName } from 'agents';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import {
  AutonomousExecutionResultSchema,
  BrokerAccountSnapshotSchema,
  BrokerMarketContextSchema,
  type AutonomousEquityIntent,
  type AutonomousExecutionResult,
  type BrokerAccountSnapshot,
  type BrokerMarketContext,
} from '@thesisforge/contracts/broker';
import { validateBrokerExecutionPolicy } from './broker-execution-policy';

import {
  ROBINHOOD_EXECUTION_TOOL_ALLOWLIST,
  ROBINHOOD_READ_ONLY_TOOL_ALLOWLIST,
  classifyRobinhoodTools,
} from './robinhood-tool-policy';

const ROBINHOOD_SERVER_ID = 'robinhood';
const ROBINHOOD_SERVER_NAME = 'Robinhood Trading';
const ROBINHOOD_MCP_HOST = 'agent.robinhood.com';
const PRIMARY_AGENT_NAME = 'primary';
const THESISFORGE_OAUTH_CLIENT_NAME = 'ThesisForge';
const THESISFORGE_CLIENT_URI = 'https://thesisforge-dashboard.davidwallach2.workers.dev/';

const ToolResultEnvelopeSchema = z.object({
  structuredContent: z.object({
    data: z.record(z.string(), z.unknown()),
  }).passthrough().optional(),
  content: z.array(z.unknown()).optional(),
}).passthrough();

const ToolTextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();

const ToolTextDataSchema = z.object({
  data: z.record(z.string(), z.unknown()),
}).passthrough();

type BrokerConnectionState =
  | 'not_connected'
  | 'authenticating'
  | 'ready'
  | 'connecting'
  | 'failed'
  | 'unknown';

export type BrokerCapabilityStatus = {
  connection: BrokerConnectionState;
  requiredReadToolsPresent: boolean;
  readTools: string[];
  blockedTools: string[];
  unknownTools: string[];
  toolCount: number;
  executionEnabled: boolean;
  lastCheckedAt: string;
};

type BeginConnectionResult =
  | { state: 'ready' }
  | { state: 'authenticating'; authUrl: string };

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function brokerExecutionEnabled(env: Cloudflare.Env): boolean {
  return String(env.BROKER_EXECUTION_ENABLED) === 'true';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is unavailable`);
  return parsed;
}

function dataFromToolResult(result: unknown): Record<string, unknown> {
  const normalized = ToolResultEnvelopeSchema.parse(
    typeof result === 'string' ? JSON.parse(result) : JSON.parse(JSON.stringify(result)),
  );
  if (normalized.structuredContent?.data) return normalized.structuredContent.data;
  for (const item of normalized.content ?? []) {
    const textItem = ToolTextContentSchema.safeParse(item);
    if (!textItem.success) continue;
    try {
      const parsed = ToolTextDataSchema.safeParse(JSON.parse(textItem.data.text) as unknown);
      if (parsed.success) return parsed.data.data;
    } catch {
      // Ignore prose content. A structured data object is required below.
    }
  }
  throw new Error('Robinhood tool result did not include structured data');
}

function storedExecutionResult(text: string): AutonomousExecutionResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Stored autonomous execution result is invalid');
  }
  const parsed = AutonomousExecutionResultSchema.safeParse(value);
  if (!parsed.success) throw new Error('Stored autonomous execution result is invalid');
  return parsed.data;
}

async function stableHash<Value>(value: Value): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function regularExecutionWindow(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(values.weekday || '')) return false;
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  return minutes >= 9 * 60 + 45 && minutes <= 15 * 60 + 45;
}

function isoDayStart(now = new Date()): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  // Robinhood accepts a date-only lower bound. This conservatively includes any
  // orders after UTC midnight while avoiding a hard-coded EDT/EST offset.
  return date;
}

function configuredOrigin(env: Cloudflare.Env): URL {
  const origin = new URL(env.BROKER_PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('BROKER_PUBLIC_ORIGIN must be an HTTPS origin');
  }
  return origin;
}

function configuredMcpUrl(env: Cloudflare.Env): string {
  const url = new URL(env.ROBINHOOD_MCP_URL);
  if (url.protocol !== 'https:' || url.hostname !== ROBINHOOD_MCP_HOST || url.pathname !== '/mcp/trading') {
    throw new Error('ROBINHOOD_MCP_URL is not the approved Robinhood Trading MCP endpoint');
  }
  return url.toString();
}

function configuredOAuthCallbackOrigin(env: Cloudflare.Env): URL {
  const origin = new URL(env.ROBINHOOD_OAUTH_CALLBACK_ORIGIN);
  if (
    origin.protocol !== 'http:'
    || origin.hostname !== '127.0.0.1'
    || origin.port !== '18789'
    || origin.pathname !== '/'
    || origin.search
    || origin.hash
  ) {
    throw new Error('ROBINHOOD_OAUTH_CALLBACK_ORIGIN must be the approved loopback relay origin');
  }
  return origin;
}

function accessIssuer(env: Cloudflare.Env): string {
  const configured = env.CF_ACCESS_TEAM_DOMAIN.trim().replace(/\/$/, '');
  return configured.startsWith('https://') ? configured : `https://${configured}`;
}

async function isOwnerRequest(request: Request, env: Cloudflare.Env): Promise<boolean> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return false;
  const issuer = accessIssuer(env);
  try {
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      audience: env.CF_ACCESS_AUD,
      issuer,
    });
    const email = z.string().email().safeParse(payload.email);
    return email.success
      && normalizeIdentity(email.data) === normalizeIdentity(env.BROKER_OWNER_EMAIL);
  } catch {
    return false;
  }
}

function safeState(value: string | undefined): BrokerConnectionState {
  if (!value) return 'not_connected';
  if (value === 'authenticating' || value === 'ready' || value === 'connecting' || value === 'failed') return value;
  return 'unknown';
}

class ThesisForgeOAuthClientProvider extends DurableObjectOAuthClientProvider {
  override get clientUri(): string {
    return THESISFORGE_CLIENT_URI;
  }
}

export class RobinhoodBrokerAgent extends Agent<Cloudflare.Env> {
  override createMcpOAuthProvider(callbackUrl: string): DurableObjectOAuthClientProvider {
    return new ThesisForgeOAuthClientProvider(
      this.ctx.storage,
      THESISFORGE_OAUTH_CLIENT_NAME,
      callbackUrl,
    );
  }

  onStart(): void {
    void this.sql`CREATE TABLE IF NOT EXISTS autonomous_orders (
      ref_id TEXT PRIMARY KEY,
      request_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    const origin = configuredOrigin(this.env).origin;
    this.mcp.configureOAuthCallback({
      successRedirect: `${origin}/?connected=1`,
      errorRedirect: `${origin}/?connection_error=1`,
    });
  }

  async beginConnection(): Promise<BeginConnectionResult> {
    const existing = this.getMcpServers().servers[ROBINHOOD_SERVER_ID];
    if (existing?.state === 'ready') return { state: 'ready' };
    if (existing) {
      await this.removeMcpServer(ROBINHOOD_SERVER_ID);
      console.log(JSON.stringify({
        event: 'robinhood_stale_connection_reset',
        previous_state: safeState(existing.state),
        execution_enabled: brokerExecutionEnabled(this.env),
      }));
    }

    const result = await this.addMcpServer(
      ROBINHOOD_SERVER_NAME,
      configuredMcpUrl(this.env),
      {
        id: ROBINHOOD_SERVER_ID,
        callbackHost: configuredOAuthCallbackOrigin(this.env).origin,
        callbackPath: '/callback',
        transport: { type: 'streamable-http' },
        retry: { maxAttempts: 3, baseDelayMs: 500 },
      },
    );
    return result.state === 'authenticating'
      ? { state: 'authenticating', authUrl: result.authUrl }
      : { state: 'ready' };
  }

  async connectionStatus(): Promise<BrokerCapabilityStatus> {
    await this.mcp.waitForConnections({ timeout: 10_000 });
    const state = this.getMcpServers();
    const server = state.servers[ROBINHOOD_SERVER_ID];
    const names = state.tools
      .filter((tool) => tool.serverId === ROBINHOOD_SERVER_ID)
      .map((tool) => tool.name);
    return {
      connection: safeState(server?.state),
      ...classifyRobinhoodTools(names, brokerExecutionEnabled(this.env)),
      lastCheckedAt: new Date().toISOString(),
    };
  }

  private async callRobinhoodTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const permitted = ROBINHOOD_READ_ONLY_TOOL_ALLOWLIST.has(name)
      || (brokerExecutionEnabled(this.env) && ROBINHOOD_EXECUTION_TOOL_ALLOWLIST.has(name));
    if (!permitted) throw new Error('Robinhood tool is not permitted by the gateway policy');
    await this.mcp.restoreConnectionsFromStorage(this.name);
    await this.mcp.waitForConnections({ timeout: 10_000 });
    let state = this.getMcpServers();
    if (state.servers[ROBINHOOD_SERVER_ID] && state.servers[ROBINHOOD_SERVER_ID]?.state !== 'ready') {
      if (state.servers[ROBINHOOD_SERVER_ID]?.state === 'connected') {
        await this.mcp.discoverIfConnected(ROBINHOOD_SERVER_ID, { timeoutMs: 20_000 });
      } else {
        await this.mcp.establishConnection(ROBINHOOD_SERVER_ID);
      }
      await this.mcp.waitForConnections({ timeout: 20_000 });
      state = this.getMcpServers();
      if (state.servers[ROBINHOOD_SERVER_ID]?.state === 'connected') {
        await this.mcp.discoverIfConnected(ROBINHOOD_SERVER_ID, { timeoutMs: 20_000 });
        state = this.getMcpServers();
      }
    }
    if (state.servers[ROBINHOOD_SERVER_ID]?.state !== 'ready') {
      throw new Error(`Robinhood connection is not ready (${String(state.servers[ROBINHOOD_SERVER_ID]?.state || 'not_connected')})`);
    }
    if (!state.tools.some((tool) => tool.serverId === ROBINHOOD_SERVER_ID && tool.name === name)) {
      throw new Error('Required Robinhood capability is unavailable');
    }
    const tool = this.mcp.getAITools()[`tool_robinhood_${name}`];
    if (!tool) throw new Error('Required Robinhood capability could not be loaded');
    return dataFromToolResult(await tool.execute(args));
  }

  private async agenticAccount(): Promise<Record<string, unknown>> {
    const data = await this.callRobinhoodTool('get_accounts', {});
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const eligible = accounts.filter((account): account is Record<string, unknown> => {
      if (!account || typeof account !== 'object' || Array.isArray(account)) return false;
      const row = account as Record<string, unknown>;
      return row.agentic_allowed === true
        && row.state === 'active'
        && row.deactivated !== true
        && row.permanently_deactivated !== true
        && typeof row.account_number === 'string';
    });
    if (eligible.length !== 1) throw new Error('Exactly one active Agentic account is required');
    return eligible[0];
  }

  async readAccountSnapshot(): Promise<BrokerAccountSnapshot> {
    const account = await this.agenticAccount();
    const accountNumber = String(account.account_number);
    const [portfolio, positions, orders] = await Promise.all([
      this.callRobinhoodTool('get_portfolio', { account_number: accountNumber }),
      this.callRobinhoodTool('get_equity_positions', { account_number: accountNumber }),
      this.callRobinhoodTool('get_equity_orders', {
        account_number: accountNumber,
        created_at_gte: isoDayStart(),
        placed_agent: 'agentic',
      }),
    ]);
    const buyingPowerObject = portfolio.buying_power;
    const buyingPower = buyingPowerObject && typeof buyingPowerObject === 'object' && !Array.isArray(buyingPowerObject)
      ? finiteNumber((buyingPowerObject as Record<string, unknown>).buying_power, 'buying power')
      : NaN;
    if (!Number.isFinite(buyingPower)) throw new Error('buying power is unavailable');
    const positionRows = Array.isArray(positions.positions) ? positions.positions : [];
    const normalizedPositions = positionRows
      .filter((position): position is Record<string, unknown> =>
        Boolean(position) && typeof position === 'object' && !Array.isArray(position))
      .map((position) => ({
        symbol: String(position.symbol || '').toUpperCase(),
        quantity: finiteNumber(position.quantity, 'position quantity'),
        sharesAvailableForSells: finiteNumber(position.shares_available_for_sells, 'sellable shares'),
        averageBuyPrice: position.average_buy_price == null
          ? null
          : finiteNumber(position.average_buy_price, 'average buy price'),
      }))
      .filter((position) => /^[A-Z][A-Z0-9.]{0,9}$/.test(position.symbol));
    const todayOrders = (Array.isArray(orders.orders) ? orders.orders : [])
      .filter((order): order is Record<string, unknown> =>
        Boolean(order) && typeof order === 'object' && !Array.isArray(order));
    const todayBuyOrders = todayOrders.filter((order) => order.side === 'buy');
    const pendingStates = new Set(['queued', 'unconfirmed', 'confirmed', 'partially_filled', 'pending']);
    const pendingOrderSymbols = [...new Set(todayOrders
      .filter((order) => pendingStates.has(String(order.state || '').toLowerCase()))
      .map((order) => String(order.symbol || '').toUpperCase())
      .filter((symbol) => /^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)))];
    let todayNotional = 0;
    for (const order of todayBuyOrders) {
      const dollarBased = order.dollar_based_amount;
      if (dollarBased && typeof dollarBased === 'object' && !Array.isArray(dollarBased)) {
        todayNotional += finiteNumber((dollarBased as Record<string, unknown>).amount, 'daily order notional');
      } else {
        const quantity = finiteNumber(order.quantity ?? order.cumulative_quantity, 'daily order quantity');
        const price = finiteNumber(order.average_price ?? order.price, 'daily order price');
        todayNotional += Math.abs(quantity * price);
      }
    }
    const accountHash = await stableHash({ accountNumber });
    return BrokerAccountSnapshotSchema.parse({
      accountKey: `rh:${accountHash.slice(0, 24)}`,
      accountLast4: accountNumber.slice(-4),
      observedAt: new Date().toISOString(),
      totalValue: finiteNumber(portfolio.total_value, 'portfolio value'),
      equityValue: finiteNumber(portfolio.equity_value, 'equity value'),
      cash: finiteNumber(portfolio.cash, 'cash'),
      buyingPower,
      positions: normalizedPositions,
      todayAgenticOrderCount: todayBuyOrders.length,
      todayAgenticOrderNotional: todayNotional,
      pendingOrderSymbols,
    });
  }

  async readEquityMarketContext(inputSymbols: string[]): Promise<BrokerMarketContext> {
    const symbols = [...new Set(inputSymbols.map((symbol) => symbol.trim().toUpperCase()))]
      .filter((symbol) => /^[A-Z][A-Z0-9.]{0,9}$/.test(symbol))
      .slice(0, 10);
    if (symbols.length === 0) return { observedAt: new Date().toISOString(), symbols: [] };
    const account = await this.agenticAccount();
    const accountNumber = String(account.account_number);
    const [tradability, quotes] = await Promise.all([
      this.callRobinhoodTool('get_equity_tradability', { account_number: accountNumber, symbols }),
      this.callRobinhoodTool('get_equity_quotes', { symbols }),
    ]);
    const tradabilityRows = recordRows(tradability.results);
    const quoteRows = recordRows(quotes.results);
    const normalized = [];
    for (const symbol of symbols) {
      const tradable = tradabilityRows.find((row) => row.symbol === symbol);
      const quoteResult = quoteRows.find((row) => isRecord(row.quote) && row.quote.symbol === symbol);
      const quote = quoteResult && isRecord(quoteResult.quote) ? quoteResult.quote : null;
      if (!tradable || !quote) continue;
      const bid = finiteNumber(quote.bid_price, 'bid price');
      const ask = finiteNumber(quote.ask_price, 'ask price');
      const last = finiteNumber(quote.last_trade_price, 'last price');
      const previousClose = finiteNumber(quote.adjusted_previous_close ?? quote.previous_close, 'previous close');
      normalized.push({
        symbol,
        tradable: tradable.tradeable === true,
        state: String(tradable.state || quote.state || 'unknown'),
        fractionalTradable: tradable.fractional_tradability === 'tradable',
        bid,
        ask,
        last,
        previousClose,
        quoteAt: String(quote.venue_ask_time || quote.venue_last_trade_time || ''),
        spreadBps: bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : Number.POSITIVE_INFINITY,
      });
    }
    return BrokerMarketContextSchema.parse({ observedAt: new Date().toISOString(), symbols: normalized });
  }

  async readEquityResearchContext(inputSymbols: string[]): Promise<string> {
    const symbols = [...new Set(inputSymbols.map((symbol) => symbol.trim().toUpperCase()))]
      .filter((symbol) => /^[A-Z][A-Z0-9.]{0,9}$/.test(symbol))
      .slice(0, 3);
    const market = await this.readEquityMarketContext(symbols);
    if (symbols.length === 0) return JSON.stringify({ market, fundamentals: [], earnings: [], historicals: [] });
    const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1_000).toISOString();
    const [fundamentals, historicals, earnings] = await Promise.all([
      this.callRobinhoodTool('get_equity_fundamentals', { symbols, bounds: 'regular' }),
      this.callRobinhoodTool('get_equity_historicals', {
        symbols,
        start_time: start,
        interval: 'day',
        bounds: 'regular',
        adjustment_type: 'split',
      }),
      Promise.all(symbols.map(async (symbol) => ({
        symbol,
        data: await this.callRobinhoodTool('get_earnings_results', { symbol }),
      }))),
    ]);
    const output = JSON.stringify({
      observedAt: new Date().toISOString(),
      market,
      fundamentals,
      historicals,
      earnings,
    });
    if (new TextEncoder().encode(output).byteLength > 512 * 1024) throw new Error('Broker research context exceeded its size limit');
    return output;
  }

  async executeAutonomousEquityIntent(intent: AutonomousEquityIntent): Promise<AutonomousExecutionResult> {
    if (!brokerExecutionEnabled(this.env)) throw new Error('Broker execution is disabled');
    if (!regularExecutionWindow()) throw new Error('Autonomous execution is outside the regular-session safety window');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.refId)) {
      throw new Error('A version-4 UUID refId is required');
    }
    const symbol = intent.symbol.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw new Error('Invalid equity symbol');
    if (!/^[0-9a-f]{64}$/.test(intent.rationaleSha256)) throw new Error('A rationale hash is required');
    if (intent.maxTradePercent <= 0 || intent.maxTradePercent > 5) throw new Error('Trade cap exceeds the gateway maximum');
    if (intent.maxDailyNotionalPercent <= 0 || intent.maxDailyNotionalPercent > 20) throw new Error('Daily cap exceeds the gateway maximum');
    if (!Number.isInteger(intent.maxTradesPerDay) || intent.maxTradesPerDay < 1 || intent.maxTradesPerDay > 3) {
      throw new Error('Daily trade-count cap exceeds the gateway maximum');
    }
    if (intent.maxSpreadBps <= 0 || intent.maxSpreadBps > 80) throw new Error('Spread cap exceeds the gateway maximum');
    if (!['open', 'add', 'reduce', 'exit'].includes(intent.positionAction)) throw new Error('A supported position action is required');
    const hasDollarAmount = Number.isFinite(intent.dollarAmount);
    const hasQuantity = Number.isFinite(intent.quantity);
    if (hasDollarAmount === hasQuantity) throw new Error('Exactly one sizing field is required');
    if (intent.side === 'buy' && !hasDollarAmount) throw new Error('Autonomous buys must be dollar-based');
    if (intent.side === 'sell' && !hasQuantity) throw new Error('Autonomous sells must be share-based');
    if (intent.side === 'buy' && !['open', 'add'].includes(intent.positionAction)) throw new Error('Invalid buy position action');
    if (intent.side === 'sell' && !['reduce', 'exit'].includes(intent.positionAction)) throw new Error('Invalid sell position action');

    const requestSha256 = await stableHash({ ...intent, symbol });
    const existing = this.sql<{ request_sha256: string; status: string; result_json: string | null }>`
      SELECT request_sha256, status, result_json FROM autonomous_orders WHERE ref_id = ${intent.refId}
    `[0];
    if (existing) {
      if (existing.request_sha256 !== requestSha256) throw new Error('refId was reused with a different order');
      if (existing.status === 'submitted' && existing.result_json) {
        return { ...storedExecutionResult(existing.result_json), status: 'duplicate' };
      }
      throw new Error('An execution with this refId is already in progress or failed closed');
    }
    const now = new Date().toISOString();
    void this.sql`INSERT INTO autonomous_orders(ref_id, request_sha256, status, created_at, updated_at)
      VALUES (${intent.refId}, ${requestSha256}, 'reserved', ${now}, ${now})`;

    try {
      const account = await this.agenticAccount();
      const accountNumber = String(account.account_number);
      const snapshot = await this.readAccountSnapshot();
      const requestedNotional = hasDollarAmount
        ? finiteNumber(intent.dollarAmount, 'order notional')
        : finiteNumber(intent.quantity, 'order quantity');
      validateBrokerExecutionPolicy({ ...intent, symbol }, snapshot);

      const [tradability, quotes] = await Promise.all([
        this.callRobinhoodTool('get_equity_tradability', { account_number: accountNumber, symbols: [symbol] }),
        this.callRobinhoodTool('get_equity_quotes', { symbols: [symbol] }),
      ]);
      const tradabilityRows = recordRows(tradability.results);
      const tradable = tradabilityRows.find((row) => row.symbol === symbol);
      if (!tradable || tradable.tradeable !== true || tradable.state !== 'active') throw new Error('Symbol is not currently tradable');
      const quoteRows = recordRows(quotes.results);
      const quoteResult = quoteRows.find((row) => isRecord(row.quote) && row.quote.symbol === symbol);
      const quote = quoteResult && isRecord(quoteResult.quote) ? quoteResult.quote : null;
      if (!quote || quote.has_traded !== true || quote.state !== 'active') throw new Error('A valid live quote is unavailable');
      const ask = finiteNumber(quote.ask_price, 'ask price');
      const bid = finiteNumber(quote.bid_price, 'bid price');
      if (ask <= 0 || bid <= 0) throw new Error('A valid bid/ask is unavailable');
      const spreadBps = ((ask - bid) / ((ask + bid) / 2)) * 10_000;
      if (spreadBps < 0 || spreadBps > intent.maxSpreadBps) throw new Error('Bid/ask spread exceeds the configured limit');
      validateBrokerExecutionPolicy({ ...intent, symbol }, snapshot, intent.side === 'buy' ? ask : bid);
      const sideQuoteTime = Date.parse(String(intent.side === 'buy'
        ? quote.venue_ask_time || quote.venue_last_trade_time || ''
        : quote.venue_bid_time || quote.venue_last_trade_time || ''));
      if (!Number.isFinite(sideQuoteTime) || Date.now() - sideQuoteTime > 120_000) throw new Error('Quote is stale');

      const orderArgs = {
        account_number: accountNumber,
        symbol,
        side: intent.side,
        type: 'market',
        market_hours: 'regular_hours',
        time_in_force: 'gfd',
        ...(hasDollarAmount
          ? { dollar_amount: requestedNotional.toFixed(2) }
          : { quantity: requestedNotional.toFixed(6).replace(/\.?0+$/, '') }),
      };
      const review = await this.callRobinhoodTool('review_equity_order', orderArgs);
      if (!isRecord(review.order_checks) || Object.keys(review.order_checks).length > 0) {
        throw new Error('Robinhood pre-trade review returned an alert');
      }
      if (!isRecord(review.quote_data)) throw new Error('Robinhood pre-trade review did not return a quote');
      const reviewedAt = Date.parse(String(intent.side === 'buy'
        ? review.quote_data.venue_ask_time || review.quote_data.venue_last_trade_time || ''
        : review.quote_data.venue_bid_time || review.quote_data.venue_last_trade_time || ''));
      if (!Number.isFinite(reviewedAt) || Date.now() - reviewedAt > 120_000) throw new Error('Reviewed quote is stale');

      const placed = await this.callRobinhoodTool('place_equity_order', { ...orderArgs, ref_id: intent.refId });
      if (!isRecord(placed.order) || typeof placed.order.id !== 'string') throw new Error('Broker did not return an order id');
      const result: AutonomousExecutionResult = {
        refId: intent.refId,
        status: 'submitted',
        accountKey: snapshot.accountKey,
        brokerOrderId: placed.order.id,
        orderJson: JSON.stringify(placed.order),
        reviewJson: JSON.stringify(review),
        submittedAt: new Date().toISOString(),
      };
      const resultJson = JSON.stringify(result);
      void this.sql`UPDATE autonomous_orders SET status = 'submitted', result_json = ${resultJson}, updated_at = ${result.submittedAt}
        WHERE ref_id = ${intent.refId}`;
      return result;
    } catch (error) {
      const failedAt = new Date().toISOString();
      void this.sql`UPDATE autonomous_orders SET status = 'blocked', updated_at = ${failedAt} WHERE ref_id = ${intent.refId}`;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const server = this.getMcpServers().servers[ROBINHOOD_SERVER_ID];
    if (server) await this.removeMcpServer(ROBINHOOD_SERVER_ID);
  }
}

function securityHeaders(contentType: string): HeadersInit {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

function statusPage(status: BrokerCapabilityStatus, notice: string | null, csrfToken: string): Response {
  const connected = status.connection === 'ready';
  const pending = status.connection === 'authenticating' || status.connection === 'failed';
  const noticeHtml = notice ? `<p class="notice">${notice}</p>` : '';
  const action = connected
    ? `<form method="post" action="/broker/disconnect"><input type="hidden" name="csrf" value="${csrfToken}"><button class="secondary" type="submit">Disconnect Robinhood</button></form>`
    : `<form method="post" action="/broker/connect"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">${pending ? 'Restart Robinhood connection' : 'Connect Robinhood'}</button></form>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ThesisForge Broker Connection</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#08110d;color:#e8f5ee;margin:0;padding:3rem 1rem}main{max-width:720px;margin:auto;background:#101b16;border:1px solid #294438;border-radius:18px;padding:2rem}h1{margin-top:0}code{color:#8de3b5}.status{padding:1rem;background:#0a1410;border-radius:10px;margin:1.5rem 0}.notice{color:#a9e8c6}button{background:#43d17d;color:#06110a;border:0;border-radius:9px;padding:.8rem 1rem;font-weight:700;cursor:pointer}.secondary{background:#263d33;color:#e8f5ee}li{margin:.4rem 0}a{color:#8de3b5}</style></head>
<body><main><h1>Robinhood cloud connection</h1>${noticeHtml}
<p>This OAuth connection is stored by a Cloudflare Durable Object. No Codex session or local computer is involved after authorization.</p>
<div class="status"><strong>Connection:</strong> <code>${status.connection}</code><br><strong>Discovered tools:</strong> ${status.toolCount}<br><strong>Required read tools present:</strong> ${status.requiredReadToolsPresent ? 'yes' : 'no'}<br><strong>Trade execution:</strong> ${status.executionEnabled ? 'autonomous, policy-gated' : 'disabled'}</div>
${action}
<ul><li>OAuth tokens remain in the account Durable Object</li><li>Orders require fresh account, quote, tradability, spread, sizing, and broker-review gates</li><li>Duplicate intent IDs are rejected or returned idempotently</li></ul>
<p><a href="https://thesisforge-dashboard.davidwallach2.workers.dev/">Back to ThesisForge</a></p></main></body></html>`;
  const headers = new Headers(securityHeaders('text/html; charset=utf-8'));
  headers.set('set-cookie', `__Host-thesisforge_csrf=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=600`);
  return new Response(html, { headers });
}

function robinhoodAuthorizationPage(authUrl: string): Response {
  const target = new URL(authUrl);
  if (target.protocol !== 'https:' || (target.hostname !== 'robinhood.com' && !target.hostname.endsWith('.robinhood.com'))) {
    throw new Error('Robinhood returned an unexpected authorization URL');
  }
  const escapedTarget = target.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Continue to Robinhood</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#08110d;color:#e8f5ee;margin:0;padding:3rem 1rem}main{max-width:620px;margin:auto;background:#101b16;border:1px solid #294438;border-radius:18px;padding:2rem}a.button{display:inline-block;background:#43d17d;color:#06110a;text-decoration:none;border-radius:9px;padding:.8rem 1rem;font-weight:700}p{line-height:1.5}
</style></head><body><main><h1>Continue to Robinhood</h1>
<p>Robinhood will ask you to sign in and approve the connection. Once connected, ThesisForge can operate under its deployed autonomous risk policy.</p>
<p><a class="button" href="${escapedTarget}">Continue to Robinhood</a></p>
</main></body></html>`;
  return new Response(html, { headers: securityHeaders('text/html; charset=utf-8') });
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get('cookie') || '';
  for (const part of cookies.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function validCsrf(request: Request): Promise<boolean> {
  const cookie = cookieValue(request, '__Host-thesisforge_csrf');
  if (!cookie) return false;
  const form = await request.formData();
  const submitted = form.get('csrf');
  return submitted === cookie;
}

const worker = {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const healthAgent = await getAgentByName(env.ROBINHOOD_BROKER_AGENT, PRIMARY_AGENT_NAME);
      const status = await healthAgent.connectionStatus();
      return Response.json({
        ok: status.connection === 'ready',
        connection: status.connection,
        requiredReadToolsPresent: status.requiredReadToolsPresent,
        executionEnabled: status.executionEnabled,
        toolCount: status.toolCount,
      }, { headers: { 'cache-control': 'no-store' } });
    }
    if (!await isOwnerRequest(request, env)) return new Response('Forbidden', { status: 403 });

    const agent = await getAgentByName(env.ROBINHOOD_BROKER_AGENT, PRIMARY_AGENT_NAME);
    if (url.pathname === '/broker/oauth/callback' && request.method === 'GET') {
      const agentCallbackUrl = new URL('/callback', configuredOAuthCallbackOrigin(env));
      agentCallbackUrl.search = url.search;
      console.log(JSON.stringify({
        event: 'robinhood_oauth_callback_relayed',
        execution_enabled: brokerExecutionEnabled(env),
      }));
      return agent.fetch(new Request(agentCallbackUrl, request));
    }
    if (url.pathname === '/broker/status' && request.method === 'GET') {
      return Response.json(await agent.connectionStatus(), { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/broker/connect' && request.method === 'POST') {
      if (!await validCsrf(request)) return new Response('Invalid CSRF token', { status: 403 });
      const result = await agent.beginConnection();
      console.log(JSON.stringify({
        event: 'robinhood_oauth_connection_started',
        state: result.state,
        has_authorization_url: result.state === 'authenticating',
        execution_enabled: brokerExecutionEnabled(env),
      }));
      if (result.state === 'authenticating') return robinhoodAuthorizationPage(result.authUrl);
      return Response.redirect(`${configuredOrigin(env).origin}/?connected=1`, 303);
    }
    if (url.pathname === '/broker/disconnect' && request.method === 'POST') {
      if (!await validCsrf(request)) return new Response('Invalid CSRF token', { status: 403 });
      await agent.disconnect();
      return Response.redirect(`${configuredOrigin(env).origin}/?disconnected=1`, 303);
    }
    if (url.pathname === '/' && request.method === 'GET') {
      const notice = url.searchParams.has('connected')
        ? 'Robinhood authorization completed.'
        : url.searchParams.has('disconnected')
          ? 'Robinhood was disconnected from ThesisForge.'
          : url.searchParams.has('connection_error')
            ? 'Robinhood authorization failed. No broker capability was enabled.'
            : null;
      return statusPage(await agent.connectionStatus(), notice, crypto.randomUUID());
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export default worker;
