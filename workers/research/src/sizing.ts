/**
 * Outcome-driven sizing. Size follows results, with no hard cap per position
 * (David, 2026-09-26; supersedes the 20%-of-book cap from #84).
 *
 *   buy notional = requested % of book x outcome multiplier
 *
 * then only the mechanical limits apply: the order has to be affordable from cash
 * (no margin: the smaller of cash and buying power) and has to be a positive,
 * finite amount. There is no % rail on a single order or on a position.
 *
 * The multiplier is computed in Postgres (private.half_kelly_multiplier via
 * public.thesis_sizing()) from trade_outcomes. The functions below mirror that SQL
 * so the worker and tests agree with the ledger.
 */

/**
 * Half-Kelly scale reference. A half-Kelly fraction of 20% of book maps to
 * multiplier 1.0. It only normalizes the multiplier (0.25..1); it is not a
 * limit on order or position size.
 */
export const KELLY_REFERENCE_PERCENT = 20;
/** A request cannot be more than the whole book. Mechanical sanity bound, not a rail. */
export const MAX_REQUEST_PERCENT = 100;
/** Mechanical: Robinhood's minimum dollar-based order. Not a sizing rail. */
export const MIN_ORDER_NOTIONAL = 1;
export const THIN_SAMPLE_N = 5;
export const THIN_MULTIPLIER = 0.5;
export const MIN_MULTIPLIER = 0.25;
export const MAX_MULTIPLIER = 1;

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Mirror of private.half_kelly_multiplier: clamp((kelly / 2) / reference, 0.25, 1); thin (n<5) = 0.5. */
export function halfKellyMultiplier(
  trades: number,
  wins: number,
  avgWin: number | null,
  avgLoss: number | null,
  referencePercent = KELLY_REFERENCE_PERCENT,
): number {
  if (!Number.isFinite(trades) || trades < THIN_SAMPLE_N) return THIN_MULTIPLIER;
  if (wins <= 0 || !avgWin || avgWin <= 0) return MIN_MULTIPLIER;
  if (!avgLoss || avgLoss <= 0) return MAX_MULTIPLIER;
  const p = wins / trades;
  const kelly = p - (1 - p) / (avgWin / avgLoss);
  return round4(Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, kelly / 2 / (referencePercent / 100))));
}

/**
 * Mirror of private.outcome_posterior_confidence: Beta prior with k pseudo-trades at
 * the stated confidence, updated with wins/trades. n >= 5 with negative summed P/L
 * caps confidence at 60 and demotes hardening -> forming.
 */
export function outcomePosteriorConfidence(
  stated: number,
  trades: number,
  wins: number,
  realizedPnl: number,
  k = 10,
): { confidence: number; capped: boolean; demote: boolean } {
  const base = Math.min(100, Math.max(0, stated));
  const raw = Math.round((100 * (k * base / 100 + wins)) / (k + trades));
  const demote = trades >= 5 && realizedPnl < 0;
  return { confidence: demote ? Math.min(raw, 60) : raw, capped: demote && raw > 60, demote };
}

export function validMultiplier(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_MULTIPLIER && value <= MAX_MULTIPLIER;
}

/** Cash that can fund a buy without margin: the smaller of settled cash and buying power. */
export function spendableCash(buyingPower: number, cash?: number): number {
  const bp = Number.isFinite(buyingPower) ? Math.max(0, buyingPower) : 0;
  if (cash === undefined) return bp;
  return Math.min(bp, Number.isFinite(cash) ? Math.max(0, cash) : 0);
}

/** Dollar size for an entry/add: requested % of book x multiplier, limited only by spendable cash. */
export function sizeBuyNotional(input: {
  totalValue: number;
  buyingPower: number;
  cash?: number;
  requestedPercent: number;
  multiplier: number;
}): number {
  const { totalValue, requestedPercent, multiplier } = input;
  if (!validMultiplier(multiplier)) return 0;
  if (!Number.isFinite(requestedPercent) || requestedPercent <= 0 || requestedPercent > MAX_REQUEST_PERCENT) return 0;
  if (!Number.isFinite(totalValue) || totalValue <= 0) return 0;
  const sized = totalValue * requestedPercent / 100 * multiplier;
  const affordable = Math.min(sized, spendableCash(input.buyingPower, input.cash));
  return Number.isFinite(affordable) && affordable > 0 ? Math.floor(affordable * 100) / 100 : 0;
}
