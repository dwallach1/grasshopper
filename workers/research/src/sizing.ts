/**
 * Outcome-driven sizing (PR 2). Size follows results; hard cap 20% of the book per
 * single position. The cap applies to NEW entries and ADDS only — sells, trims,
 * exits, kills and time stops never call into this. Existing oversize positions
 * are grandfathered: headroom is 0, so no adds, but nothing forces a trim.
 *
 * The multiplier itself is computed in Postgres (private.half_kelly_multiplier via
 * public.thesis_sizing()) from trade_outcomes. The functions below mirror that SQL
 * so the worker and tests agree with the ledger.
 */

export const SINGLE_POSITION_CAP_PERCENT = 20;
export const THIN_SAMPLE_N = 5;
export const THIN_MULTIPLIER = 0.5;
export const MIN_MULTIPLIER = 0.25;
export const MAX_MULTIPLIER = 1;

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Mirror of private.half_kelly_multiplier: clamp((kelly / 2) / cap, 0.25, 1); thin (n<5) = 0.5. */
export function halfKellyMultiplier(
  trades: number,
  wins: number,
  avgWin: number | null,
  avgLoss: number | null,
  capPercent = SINGLE_POSITION_CAP_PERCENT,
): number {
  if (!Number.isFinite(trades) || trades < THIN_SAMPLE_N) return THIN_MULTIPLIER;
  if (wins <= 0 || !avgWin || avgWin <= 0) return MIN_MULTIPLIER;
  if (!avgLoss || avgLoss <= 0) return MAX_MULTIPLIER;
  const p = wins / trades;
  const kelly = p - (1 - p) / (avgWin / avgLoss);
  return round4(Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, kelly / 2 / (capPercent / 100))));
}

/**
 * Mirror of private.outcome_posterior_confidence: Beta prior with k pseudo-trades at
 * the stated confidence, updated with wins/trades. n >= 5 with negative summed P/L
 * caps at 60 and demotes hardening -> forming.
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

/** Room left under the single-position cap for a buy that increases a position. */
export function positionCapHeadroom(totalValue: number, currentPositionValue: number): number {
  if (!Number.isFinite(totalValue) || totalValue <= 0) return 0;
  const current = Number.isFinite(currentPositionValue) && currentPositionValue > 0 ? currentPositionValue : 0;
  return Math.max(0, totalValue * SINGLE_POSITION_CAP_PERCENT / 100 - current);
}

/** Dollar size for an entry/add: requested% x multiplier, then cap headroom and buying power. */
export function sizeBuyNotional(input: {
  totalValue: number;
  buyingPower: number;
  requestedPercent: number;
  multiplier: number;
  currentPositionValue?: number;
}): number {
  const { totalValue, buyingPower, requestedPercent, multiplier } = input;
  if (!validMultiplier(multiplier) || !Number.isFinite(requestedPercent) || requestedPercent <= 0) return 0;
  const sized = totalValue * requestedPercent / 100 * multiplier;
  const capped = Math.min(sized, positionCapHeadroom(totalValue, input.currentPositionValue ?? 0), buyingPower);
  return Number.isFinite(capped) && capped > 0 ? Math.floor(capped * 100) / 100 : 0;
}
