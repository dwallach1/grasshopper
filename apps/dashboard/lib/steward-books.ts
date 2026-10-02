/**
 * Book: one phone page that replaces the old Book and Theses tabs.
 * Organized by steward. Each section is a plain header (book value, change since
 * start, risk used of budget), the open positions with a one-line why / exit /
 * track record, and a collapsed Watching list of theses with nothing open.
 * Closed lots collapse beside it. Every value comes from the ledger payload;
 * a missing mark or P/L stays missing, never invented.
 */
import { assembleBookHoldings, type BookHolding } from './book-holdings';
import { assembleDeskBookHealth, type DeskBookAlert } from './desk-book-health';
import { assembleLeaderboard } from './desk-leaderboard';
import type { DeskPayload, LessonRow } from './ledger-types';
import type { ExposureUsage } from './ledger-watchdog';
import { formatAmount, signedAmount, type MoneyUnit } from './money-units';
import { HISTORICAL_UNTAGGED } from './position-thesis';
import { predictionDesk } from './prediction-book';
import type { ThesisScoreRow } from './steward-scorecard';
import { assembleThesisRoster, type ThesisRosterRow } from './thesis-roster';

export type BooksStewardSlug = 'quantanamo' | 'oddsborne' | 'bandit';

export const BOOKS_STEWARDS: readonly { slug: BooksStewardSlug; name: string; unit: MoneyUnit }[] = [
  { slug: 'quantanamo', name: 'QUANTANAMO', unit: 'USD' },
  { slug: 'oddsborne', name: 'ODDSBORNE', unit: 'USD' },
  { slug: 'bandit', name: 'BANDIT', unit: 'SOL' },
];

export type BooksTrack = {
  trades: number;
  wins: number | null;
  score: number | null;
  /** `6 trades, score 56` · `6 trades + 1 backtest, score 52` · `1 trade, not scored yet` · `no track record yet` */
  label: string;
  /** `Backtests: 1 logged (714 trades), -0.35% per trade after costs, counts against the score` · null */
  backtest: string | null;
};

export type BooksLot = {
  holding: BookHolding;
  /** Display name: the symbol, or `YES · <market question>` for a prediction (never the raw slug when a question exists). */
  name: string;
  thesis: ThesisRosterRow | null;
  /** Plain why: thesis name, or why there is none. */
  why: string;
  /** `exits below $220.80` · `exit noted` · null */
  exit: string | null;
  /** `Rules in force no chase already printed leftovers` · null when none, or when the lot is closed */
  rules: string | null;
  track: BooksTrack;
};

export type BooksIdea = {
  thesis: ThesisRosterRow;
  name: string;
  track: BooksTrack;
  lean: string;
};

export type BooksCheck = { id: string; text: string };

export type BooksPnl = { text: string; sign: number | null };

export type BooksSection = {
  slug: BooksStewardSlug;
  name: string;
  unit: MoneyUnit;
  value: number | null;
  return_pct: number | null;
  risk: ExposureUsage | null;
  over: boolean;
  open: BooksLot[];
  watching: BooksIdea[];
  set_aside: BooksIdea[];
  closed: BooksLot[];
  checks: BooksCheck[];
};

export type StewardBooks = {
  sections: BooksSection[];
  lessons_by_thesis: ReadonlyMap<string, LessonRow[]>;
};

const STEWARD_SUFFIX = /\s*\((QUANTANAMO|ODDSBORNE|BANDIT|COINTANAMO)\)\s*$/i;

/** Thesis name in plain words: drop a trailing `(STEWARD)` tag; an id falls back to spaced words. */
export function plainThesisName(name: string, id?: string): string {
  const trimmed = name.trim();
  if (!trimmed || (id && trimmed === id)) return plainWords(id ?? trimmed);
  return trimmed.replace(STEWARD_SUFFIX, '').trim() || trimmed;
}

/** snake_case / kebab-case → spaced words. Used for ids and rule slugs. */
export function plainWords(slug: string): string {
  return slug.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

type TrackRow = Pick<ThesisScoreRow, 'priced_trades' | 'wins' | 'results_confidence'>
  & Partial<Pick<ThesisScoreRow, 'backtest_tests' | 'backtest_trades' | 'backtest_weight' | 'backtest_mean_ret' | 'backtest_effect'>>;

function wholeCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Plain line for logged backtests (real rows only; null when none count). */
export function backtestLine(row: TrackRow | null | undefined): string | null {
  const tests = wholeCount(row?.backtest_tests);
  if (!row || tests === 0) return null;
  const trades = wholeCount(row.backtest_trades);
  const mean = row.backtest_mean_ret;
  const parts = [`Backtests: ${tests} logged${trades > 0 ? ` (${trades} trades)` : ''}`];
  if (mean !== null && mean !== undefined && Number.isFinite(mean)) {
    parts.push(`${mean > 0 ? '+' : ''}${(mean * 100).toFixed(2)}% per trade after costs`);
  }
  // Rule 47: backtests earn no weight until the thesis has 3 live trades.
  if (row.backtest_weight !== undefined && row.backtest_weight !== null && Number(row.backtest_weight) === 0) parts.push('counts once the thesis has 3 live trades');
  else if (row.backtest_effect === 'for') parts.push('counts for the score');
  else if (row.backtest_effect === 'against') parts.push('counts against the score');
  return parts.join(', ');
}

export function trackRecord(row: TrackRow | null | undefined): BooksTrack {
  const trades = row && Number.isFinite(row.priced_trades) ? Math.max(0, Math.round(row.priced_trades)) : 0;
  const tests = wholeCount(row?.backtest_tests);
  if (!row || (trades === 0 && tests === 0)) {
    return { trades: 0, wins: null, score: null, label: 'no track record yet', backtest: null };
  }
  const score = row.results_confidence === null || !Number.isFinite(row.results_confidence)
    ? null
    : Math.round(row.results_confidence);
  const counts = [
    trades > 0 ? `${trades} ${trades === 1 ? 'trade' : 'trades'}` : null,
    tests > 0 ? `${tests} ${tests === 1 ? 'backtest' : 'backtests'}` : null,
  ].filter((part): part is string => part !== null).join(' + ');
  return {
    trades,
    wins: trades > 0 && Number.isFinite(row.wins) ? row.wins : null,
    score,
    label: score === null ? `${counts}, not scored yet` : `${counts}, score ${score}`,
    backtest: backtestLine(row),
  };
}

/** Plain rules still in force on an open lot. Closed lots keep this off the row. */
export function openRulesLine(slugs: readonly string[]): string | null {
  const words = slugs.map(plainWords).filter(Boolean);
  if (!words.length) return null;
  return `Rules in force ${words.join(' · ')}`;
}

export function exitLine(holding: Pick<BookHolding, 'invalidation' | 'unit'>): string | null {
  const inv = holding.invalidation;
  if (!inv) return null;
  if (inv.price !== null) return `exits below ${formatAmount(inv.price, holding.unit)}`;
  return inv.note ? 'exit noted' : null;
}

function untaggedWhy(holding: BookHolding): string {
  if (holding.untagged === HISTORICAL_UNTAGGED) return 'opened before theses were tracked';
  return 'no thesis linked';
}

/** Header money: `$5,496` or `1.82 SOL`. */
export function headerAmount(value: number, unit: MoneyUnit): string {
  if (unit === 'SOL') return `${value.toFixed(2)} SOL`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** `risk $351 of $550` / `risk 0 of 0.18 SOL` — plain ink, never P/L colors. */
export function riskText(row: ExposureUsage): string {
  if (row.unit === 'SOL') {
    const used = row.open_risk === 0 ? '0' : row.open_risk.toFixed(2);
    return `risk ${used} of ${row.risk_budget.toFixed(2)} SOL`;
  }
  const usd = (value: number) => `$${Math.round(value).toLocaleString('en-US')}`;
  return `risk ${usd(row.open_risk)} of ${usd(row.risk_budget)}`;
}

/** `+9.9% since start` (sign colors it; the page never invents a start). */
export function changeText(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}% since start`;
}

/**
 * Size or value for a row: value when an open lot has a mark, else the size in
 * plain units. A closed lot with nothing left returns '' (no `0 tokens`).
 */
export function lotAmount(holding: BookHolding): string {
  if (holding.size !== null && holding.mark !== null && holding.life === 'live') {
    return formatAmount(holding.size * holding.mark, holding.unit);
  }
  if (holding.size === null || holding.size === 0) return holding.life === 'closed' ? '' : '—';
  return `${sizeNumber(holding.size)} ${sizeUnit(holding)}`;
}

/**
 * Row P/L: `+$121.80 (+12.2%)`, or the % alone when there is no size left to
 * price (a closed lot's 0 × move is not a P/L). `sign` drives the up/down ink.
 * Nothing priced → `closed` / `no price yet`, never a made-up zero.
 */
export function lotPnl(holding: Pick<BookHolding, 'upl' | 'change_pct' | 'size' | 'unit' | 'life'>): BooksPnl {
  const sized = holding.size !== null && holding.size !== 0;
  const upl = sized ? holding.upl : null;
  const change = holding.change_pct;
  if (upl === null) {
    if (change === null) return { text: holding.life === 'closed' ? 'closed' : 'no price yet', sign: null };
    return { text: signedPct(change), sign: change };
  }
  const amount = signedAmount(upl, holding.unit);
  return { text: change === null ? amount : `${amount} (${signedPct(change)})`, sign: upl };
}

function signedPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function sizeNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

export function sizeUnit(holding: Pick<BookHolding, 'venue' | 'size'>): string {
  const one = holding.size !== null && Math.abs(holding.size) === 1;
  if (holding.venue === 'prediction') return one ? 'contract' : 'contracts';
  if (holding.venue === 'meme') return 'tokens';
  return one ? 'share' : 'shares';
}

/** Stance in plain words. */
export function leanText(stance: string): string {
  const value = stance.trim().toLowerCase();
  if (value === 'bullish') return 'expects up';
  if (value === 'bearish') return 'expects down';
  if (value === 'neutral') return 'no direction';
  return plainWords(value);
}

/** Thesis status in plain words. */
export function statusText(status: string): string {
  const value = status.trim().toLowerCase();
  if (value === 'hardening') return 'active';
  if (value === 'forming') return 'early';
  if (value === 'rejected') return 'set aside';
  if (value === 'killed') return 'dropped';
  return plainWords(value);
}

/** Belief-trail kinds in plain words. */
export function beliefKindText(kind: string): string {
  const value = kind.trim().toLowerCase();
  if (value === 'playbook_rule') return 'rule';
  if (value === 'outcome_rescore') return 're-scored on results';
  if (value === 'trade_close_lesson') return 'lesson from a close';
  return plainWords(value);
}

const CHECK_TEXT = {
  stale_open: 'price not updated in 6h',
  resolved_still_open: 'market closed but the position is still open',
  stale_catalog: 'market list not refreshed',
  invalidation_breach: 'price is at or below its exit',
  missing_invalidation: 'no exit price written',
} as const satisfies Record<DeskBookAlert['kind'], string>;

export function assembleStewardBooks(desk: DeskPayload, nowMs: number): StewardBooks {
  const holdings = assembleBookHoldings(desk).rows;
  const roster = assembleThesisRoster(desk).rows;
  const rosterById = new Map(roster.map((row) => [row.id, row]));
  const scores = new Map((desk.scorecard?.theses ?? []).map((row) => [row.thesis_id, row]));
  const exposure = new Map((desk.watchdog?.exposure ?? []).map((row) => [row.steward, row]));
  const standings = new Map(assembleLeaderboard(desk).rows.map((row) => [row.id, row]));
  const alerts = assembleDeskBookHealth(desk, nowMs).alerts;
  const predictions = predictionDesk(desk);
  const questions = new Map(predictions.markets.map((row) => [row.id, row.question?.trim() ?? '']));
  const pmNames = new Map(predictions.positions.map((row) => {
    const question = questions.get(row.market_id) ?? '';
    const side = row.outcome.trim().toUpperCase();
    return [`pm:${row.id}`, question ? `${side ? `${side} · ` : ''}${question}` : ''];
  }));

  const lot = (holding: BookHolding): BooksLot => {
    const thesis = holding.thesis_id ? rosterById.get(holding.thesis_id) ?? null : null;
    const why = holding.thesis_id
      ? plainThesisName(thesis?.name ?? holding.thesis_name ?? holding.thesis_id, holding.thesis_id)
      : untaggedWhy(holding);
    return {
      holding,
      name: pmNames.get(holding.id) || holding.name,
      thesis,
      why,
      exit: holding.life === 'live' ? exitLine(holding) : null,
      rules: holding.life === 'live' ? openRulesLine(holding.rules_in_force) : null,
      track: holding.thesis_id ? trackRecord(scores.get(holding.thesis_id)) : trackRecord(null),
    };
  };

  const idea = (thesis: ThesisRosterRow): BooksIdea => ({
    thesis,
    name: plainThesisName(thesis.name, thesis.id),
    track: trackRecord(scores.get(thesis.id)),
    lean: leanText(thesis.stance),
  });

  const sections = BOOKS_STEWARDS.map(({ slug, name, unit }): BooksSection => {
    const mine = holdings.filter((row) => row.steward_slug === slug);
    const open = mine.filter((row) => row.life === 'live').map(lot);
    const closed = mine.filter((row) => row.life === 'closed').map(lot);
    const held = new Set(open.map((row) => row.holding.thesis_id).filter((id): id is string => Boolean(id)));
    const ideas = roster.filter((row) => row.steward === slug && !held.has(row.id));
    const standing = standings.get(slug);
    const risk = exposure.get(slug) ?? null;
    return {
      slug,
      name,
      unit,
      value: standing?.now ?? null,
      return_pct: standing?.return_pct ?? null,
      risk,
      over: Boolean(risk?.over),
      open,
      watching: ideas.filter((row) => row.live).map(idea),
      set_aside: ideas.filter((row) => !row.live).map(idea),
      closed,
      checks: alerts
        .filter((row) => row.steward === slug)
        .map((row) => ({ id: row.id, text: `${row.label}: ${CHECK_TEXT[row.kind]}` })),
    };
  });

  const lessons = new Map<string, LessonRow[]>();
  for (const row of desk.lessons ?? []) {
    if (!row.thesis_id) continue;
    const list = lessons.get(row.thesis_id) ?? [];
    list.push(row);
    lessons.set(row.thesis_id, list);
  }
  for (const list of lessons.values()) {
    list.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  }

  return { sections, lessons_by_thesis: lessons };
}

/** Every lot on a thesis, open first, for the detail's outcomes list. */
export function lotsForThesis(books: StewardBooks, thesisId: string): BooksLot[] {
  const rows = books.sections.flatMap((section) => [...section.open, ...section.closed]);
  return rows.filter((row) => row.holding.thesis_id === thesisId);
}
