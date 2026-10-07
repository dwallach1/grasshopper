/**
 * Book: one phone page that replaces the old Book and Theses tabs.
 * Organized by steward. Each section is a plain header (book value, change since
 * start, risk used of budget). A collapsed position is one or two sentences:
 * why it is held, and the exit price. Score, backtests, and rule names stay in
 * the detail. A prediction row uses a short name; the full question stays in
 * the detail. One watched idea is its own line; several fold until opened.
 * Closed lots collapse beside it. Every value comes from the ledger payload;
 * a missing mark or P/L stays missing, never invented.
 */
import { assembleBookHoldings, type BookHolding } from './book-holdings';
import { assembleDeskBookHealth, type DeskBookAlert } from './desk-book-health';
import { assembleLeaderboard } from './desk-leaderboard';
import type { DeskPayload, LessonRow } from './ledger-types';
import { learningGapHoldingId, type ExposureUsage } from './ledger-watchdog';
import { formatAmount, signedAmount, type MoneyUnit } from './money-units';
import { HISTORICAL_UNTAGGED } from './position-thesis';
import { predictionDesk } from './prediction-book';
import { forecastVsMarketLine, type ThesisScoreRow } from './steward-scorecard';
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
  /** Short name: the symbol, or a prediction side a person would say (`Dolphins`). */
  name: string;
  /** Full market question. Shown only in the detail. Null for stocks and coins. */
  question: string | null;
  thesis: ThesisRosterRow | null;
  /** Plain why: thesis name, or why there is none. */
  why: string;
  /** `exits below $220.80` · `exit noted` · null */
  exit: string | null;
  /** Closed lot past the learning-loop grace with no lesson or belief after the close. */
  lesson_waiting: boolean;
  track: BooksTrack;
};

export type BooksIdea = {
  thesis: ThesisRosterRow;
  name: string;
  track: BooksTrack;
  lean: string;
};

/** `breach`: an actionable exit (red). `open`: an out-of-session print that decides at the open (quiet). */
export type BooksCheckTone = 'breach' | 'open' | 'plain';

export type BooksCheck = { id: string; text: string; tone: BooksCheckTone };

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
  /** Ledger count of closes still waiting on a lesson. Zero stays off the header. */
  lesson_gaps: number;
  checks: BooksCheck[];
  /** Settled probabilities vs the price they were looking at. Null when nothing has both. */
  forecast: string | null;
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

/** Rule names for the detail. The collapsed row does not use this line. */
export function openRulesLine(slugs: readonly string[]): string | null {
  const words = slugs.map(plainWords).filter(Boolean);
  if (!words.length) return null;
  return `Rules in force ${words.join(' · ')}`;
}

/** One or two sentences: why the position is held, then the exit price. */
export function rowSentence(why: string, exit: string | null): string {
  const held = asSentence(why);
  if (!exit) return held;
  const leave = asSentence(exit);
  return leave ? `${held} ${leave}` : held;
}

/** Collapsed row. A close still waiting on its lesson says so. Open rows never do. */
export function lotLine(lot: Pick<BooksLot, 'why' | 'exit' | 'lesson_waiting'>): string {
  const base = rowSentence(lot.why, lot.exit);
  if (!lot.lesson_waiting) return base;
  return base ? `${base} No lesson written yet.` : 'No lesson written yet.';
}

/** Header fragment when the steward has closes waiting on a lesson. */
export function lessonGapText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const n = Math.trunc(count);
  return n === 1 ? '1 close with no lesson yet' : `${n} closes with no lesson yet`;
}

function asSentence(text: string): string {
  const trimmed = text.trim().replace(/[.]+$/g, '').trim();
  if (!trimmed) return '';
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

const WIN_PREFIX = /^who will win(?::| in the upcoming \w+ event)?\s+/i;
const MONTH = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

/**
 * Spoken name for a prediction row. Head-to-head markets use the side
 * (`Dolphins`, `Titans`). The full question stays off this string.
 */
export function predictionShortName(question: string, outcome: string): string {
  const q = question.trim().replace(/\s+/g, ' ');
  const side = outcome.trim().toLowerCase();
  if (!q) return side ? side.toUpperCase() : 'Market';
  const matchup = matchupNicknames(q);
  if (matchup) return side === 'no' ? matchup.no : matchup.yes;
  const phrase = shortMarketPhrase(q);
  if (side === 'no') return `No on ${phrase}`;
  return phrase;
}

function matchupNicknames(question: string): { yes: string; no: string } | null {
  if (!/^who will win\b/i.test(question)) return null;
  const vs = question.match(/\s+vs\.?\s+/i);
  if (!vs || vs.index === undefined) return null;
  const left = teamNickname(trimMatchupSide(question.slice(0, vs.index).replace(WIN_PREFIX, '')));
  const right = teamNickname(trimMatchupSide(question.slice(vs.index + vs[0].length)));
  if (!left || !right) return null;
  return { yes: left, no: right };
}

function trimMatchupSide(side: string): string {
  let text = side.split('(')[0] ?? side;
  text = text.split(/\s+scheduled\b/i)[0] ?? text;
  text = text.replace(new RegExp(`\\s+(?:${MONTH})[a-z]*\\.?\\s+\\d{1,2}\\b.*$`, 'i'), '');
  return text.replace(/[?].*$/, '').trim();
}

function teamNickname(team: string): string {
  const words = team.split(/\s+/).filter(Boolean);
  return words[words.length - 1] ?? '';
}

function shortMarketPhrase(question: string): string {
  const weather = question.match(/^Highest temperature in (.+?) on .+?\?\s*(?:[—–-]\s*)?(.+)$/i);
  if (weather?.[1] && weather[2]) {
    return `${weather[1].trim()}, ${weather[2].trim().replace(/[?.]+$/g, '')}`;
  }
  const fed = question.match(/^Fed Decision in [A-Za-z]+\s*[—–-]\s*(.+)$/i);
  if (fed?.[1]) return fedPhrase(fed[1]);
  const dash = question.split(/\s+[—–]\s+|\s+-\s+/);
  const left = dash[0]?.trim() ?? '';
  if (dash.length >= 2 && left && left.length <= 48) return left.replace(/[?.]+$/g, '');
  return clipPhrase(question);
}

function fedPhrase(bit: string): string {
  const text = bit.trim().replace(/[?.]+$/g, '');
  if (/no change/i.test(text)) return 'Fed, no change';
  const bps = text.match(/(\d+)\s*bps/i);
  if (bps && /increase|hike|higher/i.test(text)) return `Fed, up ${bps[1]} bps`;
  if (bps && /decrease|cut|lower/i.test(text)) return `Fed, down ${bps[1]} bps`;
  return `Fed, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function clipPhrase(text: string, max = 42): string {
  const clean = text.trim().replace(/[?.]+$/g, '');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > 16 ? cut.slice(0, space) : cut).trim();
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
  invalidation_review_at_open: 'out-of-session print under its exit, decides at open',
  missing_invalidation: 'no exit price written',
} as const satisfies Record<DeskBookAlert['kind'], string>;

/** Book line for a check: `CODA: premarket print under its exit, decides at open`. */
export function checkText(alert: Pick<DeskBookAlert, 'kind' | 'label' | 'print'>): string {
  if (alert.kind === 'invalidation_review_at_open' && alert.print) {
    return `${alert.label}: ${alert.print} under its exit, decides at open`;
  }
  return `${alert.label}: ${CHECK_TEXT[alert.kind]}`;
}

function checkTone(kind: DeskBookAlert['kind']): BooksCheckTone {
  if (kind === 'invalidation_breach') return 'breach';
  if (kind === 'invalidation_review_at_open') return 'open';
  return 'plain';
}

export function assembleStewardBooks(desk: DeskPayload, nowMs: number): StewardBooks {
  const holdings = assembleBookHoldings(desk).rows;
  const roster = assembleThesisRoster(desk).rows;
  const rosterById = new Map(roster.map((row) => [row.id, row]));
  const scores = new Map((desk.scorecard?.theses ?? []).map((row) => [row.thesis_id, row]));
  const exposure = new Map((desk.watchdog?.exposure ?? []).map((row) => [row.steward, row]));
  const gapIds = new Set(
    (desk.watchdog?.learning_gap_lots ?? [])
      .map((row) => learningGapHoldingId(row.lot_table, row.lot_id))
      .filter((id): id is string => Boolean(id)),
  );
  const gapCounts = desk.watchdog?.learning_gaps;
  const standings = new Map(assembleLeaderboard(desk).rows.map((row) => [row.id, row]));
  const alerts = assembleDeskBookHealth(desk, nowMs).alerts;
  const predictions = predictionDesk(desk);
  const questions = new Map(predictions.markets.map((row) => [row.id, row.question?.trim() ?? '']));
  const pmCopy = new Map(predictions.positions.map((row) => {
    const question = questions.get(row.market_id) ?? '';
    return [row.id, question
      ? { name: predictionShortName(question, row.outcome), question }
      : null];
  }));

  const lot = (holding: BookHolding): BooksLot => {
    const thesis = holding.thesis_id ? rosterById.get(holding.thesis_id) ?? null : null;
    const why = holding.thesis_id
      ? plainThesisName(thesis?.name ?? holding.thesis_name ?? holding.thesis_id, holding.thesis_id)
      : untaggedWhy(holding);
    const copy = holding.id.startsWith('pm:') ? pmCopy.get(holding.id.slice(3)) : undefined;
    return {
      holding,
      name: copy?.name || holding.name,
      question: copy?.question || null,
      thesis,
      why,
      exit: holding.life === 'live' ? exitLine(holding) : null,
      lesson_waiting: holding.life === 'closed' && gapIds.has(holding.id),
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
      lesson_gaps: gapCounts?.[slug] ?? 0,
      forecast: forecastVsMarketLine(desk.scorecard?.forecast ?? [], slug, name),
      checks: alerts
        .filter((row) => row.steward === slug)
        .map((row) => ({ id: row.id, text: checkText(row), tone: checkTone(row.kind) })),
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
