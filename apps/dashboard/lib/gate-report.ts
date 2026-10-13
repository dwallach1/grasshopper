/**
 * Gate report card. The ledger (public.decision_outcome_pct, decision_gate_key,
 * gate_outcome_verdict, gate_belief_due) is the source of the numbers. These
 * functions are the same rules, so a skip's percent, its gate, and whether a
 * belief is due can be tested without a database. The desk prints the view's
 * verdict; it does not re-score.
 *
 * Percent is a fraction: 0.031 is +3.1%. Prediction NO in YES terms divides by
 * the NO price (1 - the YES price), matching decision_in_side_terms.
 */
import type { MoneyUnit } from './money-units';
import { signedAmount } from './money-units';

/** Below this many scored skips a gate never gets a protecting / costing-growth verdict. */
export const GATE_MIN_SCORED = 8;
/** Lines shown before the rest sit behind a tap. */
export const GATE_REPORT_OPEN = 3;

export type GateVerdict = 'protecting' | 'costing growth' | 'too few to tell';

export type GateReportRow = {
  steward: string;
  gate: string;
  skips: number;
  scored: number;
  would_have_won: number;
  would_have_won_rate: number | null;
  /** Fraction of the decision price. Null when nothing is scored. */
  mean_outcome_pct: number | null;
  verdict: GateVerdict;
  thesis_id: string | null;
  /** Percent times a size the rows stored. Null when no size was logged. */
  at_stake_pnl: number | null;
  unit: MoneyUnit;
};

const VERDICTS = new Set<GateVerdict>(['protecting', 'costing growth', 'too few to tell']);

export function gateVerdict(value: string | null | undefined): GateVerdict {
  return value && VERDICTS.has(value as GateVerdict) ? (value as GateVerdict) : 'too few to tell';
}

/** Resolved price terms. Same cases as public.decision_price_terms. */
export function decisionPriceTerms(meta: { price_terms?: string | null; origin?: string | null } | null): 'yes' | 'side' {
  const set = (meta?.price_terms ?? '').toLowerCase();
  if (set === 'yes' || set === 'side') return set;
  if ((meta?.origin ?? '') === 'steward_log_decision') return 'side';
  return 'yes';
}

/** Price of the named side. NO logged in YES terms costs 1 - the YES price. */
export function decisionSidePrice(
  side: string | null,
  bookPrice: number | null,
  terms: 'yes' | 'side',
): number | null {
  if (bookPrice === null || !(bookPrice > 0)) return null;
  if ((side ?? '').toLowerCase() === 'no' && terms === 'yes') {
    const px = 1 - bookPrice;
    return px > 0 ? px : null;
  }
  return bookPrice;
}

/**
 * Signed fraction from the decision price to the mark, for the side that was skipped.
 * Long / YES-style equity: (mark - book) / book. Short: (book - mark) / book.
 * Prediction: (payoff - side price) / side price, payoff 1 when the outcome is that side.
 * Null when the mark or the resolution is missing. A per-token SOL move uses the same fraction.
 */
export function decisionOutcomePct(input: {
  venue: string;
  side: string | null;
  bookPrice: number | null;
  mark: number | null;
  outcome: string | null;
  priceTerms: 'yes' | 'side';
}): number | null {
  const side = (input.side ?? '').toLowerCase();
  if (input.venue === 'prediction') {
    const outcome = (input.outcome ?? '').toLowerCase();
    if (outcome !== 'yes' && outcome !== 'no') return null;
    if (side !== 'yes' && side !== 'no') return null;
    const px = decisionSidePrice(side, input.bookPrice, input.priceTerms);
    if (px === null || px <= 0) return null;
    const payoff = outcome === side ? 1 : 0;
    return (payoff - px) / px;
  }
  if (input.bookPrice === null || !(input.bookPrice > 0) || input.mark === null || !(input.mark > 0)) return null;
  if (side === 'short') return (input.bookPrice - input.mark) / input.bookPrice;
  if (side === 'long') return (input.mark - input.bookPrice) / input.bookPrice;
  return null;
}

/** Gate key. A written blocked_by wins. ODDSBORNE otherwise derives one. Unknown is unlabeled. */
export function decisionGateKey(
  steward: string,
  reason: string | null,
  meta: { blocked_by?: string | null; pattern?: string | null } | null,
): string {
  const given = (meta?.blocked_by ?? '').trim();
  if (given) return given;
  if (steward.trim().toLowerCase() !== 'oddsborne') return 'unlabeled';
  const text = reason ?? '';
  if (/^morning skips/i.test(text)) return 'morning_rollup';
  if (/^afternoon (skips|sports)/i.test(text)) return 'afternoon_rollup';
  if (/^wx pass/i.test(text) || (meta?.pattern ?? '') === 'fav_vs_forecast') return 'weather_forecast_gate';
  if (/same_game|same game/i.test(text)) return 'same_game';
  if (/guidance_cap/i.test(text)) return 'guidance_cap';
  if (/not_live/i.test(text)) return 'not_live';
  if (/not_placed/i.test(text)) return 'not_placed';
  if (/cancelled resting/i.test(text)) return 'cancelled_resting';
  if (/no two-way|devig fail|methods disagree/i.test(text)) return 'devig_gate';
  if (/post-fee|makerΔ|bovada fair|^fair | pass:|^pm |fair=/i.test(text)) return 'edge_below_gate';
  return 'unlabeled';
}

export function gateOutcomeVerdict(scored: number, mean: number | null): GateVerdict {
  if (scored < GATE_MIN_SCORED || mean === null || mean === 0) return 'too few to tell';
  return mean > 0 ? 'costing growth' : 'protecting';
}

/** True only when the sample bar is met and the verdict is not already the latest belief. */
export function gateBeliefDue(latest: string | null, scored: number, verdict: GateVerdict): boolean {
  return scored >= GATE_MIN_SCORED && verdict !== 'too few to tell' && latest !== verdict;
}

export function formatOutcomePct(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return '';
  const points = fraction * 100;
  const digits = Math.abs(points) >= 100 ? 0 : 1;
  const text = Math.abs(points).toFixed(digits);
  if (points > 0) return `+${text}%`;
  if (points < 0) return `-${text}%`;
  return '0%';
}

function verdictSentence(verdict: GateVerdict): string {
  if (verdict === 'protecting') return 'Protecting the book.';
  if (verdict === 'costing growth') return 'Costing growth.';
  return 'Too few to tell yet.';
}

export type GateReportParts = {
  before: string;
  pct: number | null;
  pctText: string | null;
  after: string;
};

/** One parchment line. The percent is split out so the desk can color it by sign. */
export function gateReportParts(row: Pick<
  GateReportRow,
  'gate' | 'skips' | 'scored' | 'would_have_won' | 'mean_outcome_pct' | 'verdict' | 'at_stake_pnl' | 'unit'
>): GateReportParts {
  if (row.scored <= 0 || row.mean_outcome_pct === null) {
    const n = row.skips;
    return {
      before: `Kept us out of ${n} ${n === 1 ? 'trade' : 'trades'} on ${row.gate}. None scored yet.`,
      pct: null,
      pctText: null,
      after: '',
    };
  }
  const n = row.scored;
  const stake = row.at_stake_pnl === null
    ? ''
    : ` At the logged size, ${signedAmount(row.at_stake_pnl, row.unit)}.`;
  return {
    before: `Kept us out of ${n} ${n === 1 ? 'trade' : 'trades'} on ${row.gate}: ${row.would_have_won} would have won, avg `,
    pct: row.mean_outcome_pct,
    pctText: formatOutcomePct(row.mean_outcome_pct),
    after: `. ${verdictSentence(row.verdict)}${stake}`,
  };
}

export function gateReportLine(row: Parameters<typeof gateReportParts>[0]): string {
  const parts = gateReportParts(row);
  return `${parts.before}${parts.pctText ?? ''}${parts.after}`;
}
