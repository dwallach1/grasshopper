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

/**
 * Two-sided 95% Student-t critical value. df 1..30 are the table; above that,
 * Cornish-Fisher coefficients shared with public.student_t_crit_95.
 */
const T_CRIT_95 = [
  0,
  12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.3060, 2.2622, 2.2281,
  2.2010, 2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.0930, 2.0860,
  2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423,
];
const T_Z = 1.959963984540054;
const T_A1 = 2.372271230298562;
const T_A2 = 2.822498615739611;
const T_A3 = 2.555849679507722;
const T_A4 = 1.589534053393822;
/** Stop naming a count past this many further scored trades. The average is too close to a scratch. */
export const GATE_MORE_CAP = 500;
/** Lines shown before the rest sit behind a tap. */
export const GATE_REPORT_OPEN = 3;

/** Labels that say where a row was copied from, not which rule blocked it. */
const PROVENANCE_GATES = new Set(['morning_rollup', 'afternoon_rollup']);

const EDGE_NOT_ENOUGH = /not a real positive edge|no real post-fee edge|no clear post-fee edge|under the [0-9]+\s*c bar|edge under|thin after-spread edge|after spread edge thin|edge after .{0,80} not enough|thin edge/i;
const ENTER_DID_NOT_GO = /pm_enter.{0,40}timeout|db timeout|not_placed|not placed|skip forced/i;

const GATE_PHRASE: Record<string, string> = {
  edge_below_gate: 'the edge minimum',
  weather_forecast_gate: 'the weather forecast',
  thesis_paused: 'a paused thesis',
  quality_drawdown_fail: 'quality and drawdown',
  '1h_cap_30': 'the one-hour rise cap',
  not_placed: 'an order that never went out',
  unlabeled: 'no named rule',
  cancelled_resting: 'a cancelled resting order',
  devig_gate: 'the de-vig check',
  same_game: 'a second bet on the same game',
  screen_fail: 'the screen',
  paper_only: 'paper only',
  guidance_cap: 'the size cap',
  not_live: 'a dry run',
};

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
  /** Sample spread of the scored percents. Null with fewer than two. */
  sd_outcome_pct: number | null;
  /** Further scored trades that would settle the interval if the average held. Null when it would not, within 500. */
  more_needed: number | null;
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

/** Two-sided 95% Student-t critical value. Null when df < 1. */
export function studentTCrit95(df: number): number | null {
  if (!Number.isInteger(df) || df < 1) return null;
  if (df <= 30) return T_CRIT_95[df];
  return T_Z + T_A1 / df + T_A2 / df ** 2 + T_A3 / df ** 3 + T_A4 / df ** 4;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Blocking gate for one market in an ODDSBORNE note. The edge is the note's own
 * post-fee number. A phrase on that market's line wins over a tiny positive number.
 * A multi-market note does not lend another market's sentence.
 */
export function oddsborneNoteBlockingGate(
  body: string | null,
  meta: { comps?: unknown; comps_top?: unknown; candidates?: unknown } | null,
  instrument: string | null,
): { gate: string; edge: number | null; why: string | null } {
  const comps = meta?.comps;
  const compsTop = meta?.comps_top;
  const candidates = meta?.candidates;
  const multi = Array.isArray(comps) || Array.isArray(compsTop) || Array.isArray(candidates);
  let edge: number | null = null;
  if (Array.isArray(compsTop) && instrument) {
    for (const item of compsTop) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { market?: unknown; post_fee_maker?: unknown };
      if (row.market === instrument) {
        const parsed = finiteNumber(row.post_fee_maker);
        if (parsed !== null) {
          edge = parsed;
          break;
        }
      }
    }
  }
  if (edge === null && Array.isArray(candidates) && instrument) {
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { slug?: unknown; maker?: unknown };
      if (row.slug === instrument) {
        const parsed = finiteNumber(row.maker);
        if (parsed !== null) {
          edge = parsed;
          break;
        }
      }
    }
  }
  // A multi-market note may only use the line that names this market. A
  // single-market note is all about this skip, including a reason on the next line.
  let line: string | null = null;
  if (multi) {
    if (body && instrument && body.includes(instrument)) {
      line = body.split('\n').find((part) => part.includes(instrument)) ?? null;
    }
  } else {
    line = body;
  }
  const text = line ?? '';
  if (EDGE_NOT_ENOUGH.test(text) || (edge !== null && edge < 0)) {
    return {
      gate: 'edge_below_gate',
      edge,
      why: line ?? `post-fee edge ${edge} is under the minimum`,
    };
  }
  if (ENTER_DID_NOT_GO.test(text) && (edge === null || edge > 0)) {
    return { gate: 'not_placed', edge, why: line };
  }
  return { gate: 'unlabeled', edge, why: null };
}

/** Gate key. A written blocked_by wins, except a provenance label. Unknown is unlabeled. */
export function decisionGateKey(
  steward: string,
  reason: string | null,
  meta: { blocked_by?: string | null; pattern?: string | null } | null,
): string {
  const given = (meta?.blocked_by ?? '').trim();
  if (given && !PROVENANCE_GATES.has(given)) return given;
  if (steward.trim().toLowerCase() !== 'oddsborne') return 'unlabeled';
  const text = reason ?? '';
  if (/^wx pass/i.test(text) || (meta?.pattern ?? '') === 'fav_vs_forecast') return 'weather_forecast_gate';
  if (/same_game|same game/i.test(text)) return 'same_game';
  if (/guidance_cap/i.test(text)) return 'guidance_cap';
  if (/not_live/i.test(text)) return 'not_live';
  if (/not_placed|not placed|skip forced|pm_enter.{0,40}timeout|db timeout/i.test(text)) return 'not_placed';
  if (/cancelled resting/i.test(text)) return 'cancelled_resting';
  if (/no two-way|devig fail|methods disagree/i.test(text)) return 'devig_gate';
  if (EDGE_NOT_ENOUGH.test(text) || /post-fee|makerΔ|bovada fair|^fair | pass:|^pm |fair=/i.test(text)) {
    return 'edge_below_gate';
  }
  return 'unlabeled';
}

/** Protecting or costing growth only when a 95% interval on the mean excludes zero. */
export function gateOutcomeVerdict(scored: number, mean: number | null, sd: number | null): GateVerdict {
  if (scored < 2 || mean === null || mean === 0 || sd === null || sd < 0) return 'too few to tell';
  if (sd === 0) return mean > 0 ? 'costing growth' : 'protecting';
  const crit = studentTCrit95(scored - 1);
  if (crit === null) return 'too few to tell';
  if (Math.abs(mean) > crit * sd / Math.sqrt(scored)) return mean > 0 ? 'costing growth' : 'protecting';
  return 'too few to tell';
}

/**
 * Further scored trades that would clear the interval if this mean and spread held.
 * Null when that would take more than GATE_MORE_CAP. Zero when it already clears.
 * scored is part of the signature so a caller can pass the view's count; the interval uses it.
 */
export function gateMoreNeeded(scored: number, mean: number | null, sd: number | null): number | null {
  if (scored < 2 || mean === null || mean === 0 || sd === null || sd < 0) return null;
  if (sd === 0) return 0;
  const clears = (n: number) => {
    const crit = studentTCrit95(n - 1);
    return crit !== null && Math.abs(mean) > crit * sd / Math.sqrt(n);
  };
  if (clears(scored)) return 0;
  const cap = scored + GATE_MORE_CAP;
  if (cap * mean * mean < (1.96 * sd) * (1.96 * sd)) return null;
  for (let n = scored + 1; n <= cap; n += 1) {
    if (clears(n)) return n - scored;
  }
  return null;
}

/**
 * True when a protecting or costing-growth verdict is new, or when that lesson has to
 * be taken back. scored is unused: the verdict already applied the interval. A re-run
 * with the same verdict is false. A superseded belief is left as history.
 */
export function gateBeliefDue(latest: string | null, scored: number, verdict: GateVerdict): boolean {
  void scored;
  if (latest === 'superseded') return false;
  if ((verdict === 'protecting' || verdict === 'costing growth') && latest !== verdict) return true;
  return verdict === 'too few to tell' && (latest === 'protecting' || latest === 'costing growth');
}

function gateLead(gate: string): string {
  const phrase = GATE_PHRASE[gate] ?? gate.replace(/_/g, ' ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
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

function evidenceSentence(row: { verdict: GateVerdict; scored: number; more_needed: number | null }): string {
  if (row.verdict === 'protecting') return 'Protecting the book.';
  if (row.verdict === 'costing growth') return 'Costing growth.';
  if (row.more_needed !== null && row.more_needed > 0) {
    const n = row.more_needed;
    return `Too few to tell yet. About ${n} more scored ${n === 1 ? 'trade' : 'trades'} would settle this if the average holds.`;
  }
  if (row.scored >= 2 && row.more_needed === null) {
    return 'Too few to tell yet. The average is close to a scratch, so more of the same would not settle it soon.';
  }
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
  'gate' | 'skips' | 'scored' | 'would_have_won' | 'mean_outcome_pct' | 'verdict' | 'at_stake_pnl' | 'unit' | 'more_needed'
>): GateReportParts {
  const lead = gateLead(row.gate);
  if (row.scored <= 0 || row.mean_outcome_pct === null) {
    const n = row.skips;
    return {
      before: `${lead} kept us out of ${n} ${n === 1 ? 'trade' : 'trades'}. None scored yet.`,
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
    before: `${lead} kept us out of ${n} ${n === 1 ? 'trade' : 'trades'}: ${row.would_have_won} would have won, avg `,
    pct: row.mean_outcome_pct,
    pctText: formatOutcomePct(row.mean_outcome_pct),
    after: `. ${evidenceSentence(row)}${stake}`,
  };
}

export function gateReportLine(row: Parameters<typeof gateReportParts>[0]): string {
  const parts = gateReportParts(row);
  return `${parts.before}${parts.pctText ?? ''}${parts.after}`;
}
