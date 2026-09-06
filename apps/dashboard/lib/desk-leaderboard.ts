/**
 * Desk-sport ranking: % return vs each book's own start, native units only.
 * Never convert SOL→USD. Missing start is not ranked — never 0%.
 * No invented marks or P/L.
 */
import { agenticSnapshots } from './book-performance';
import { assembleDeskBookRollup } from './desk-book-rollup';
import { deskTeam, teamCards, type AvatarShape, type DeskTeamCard } from './desk-team';
import type { DeskVenue } from './desk-venue';
import { venueShort } from './desk-venue';
import type { DeskPayload } from './ledger-types';
import { latestMemePnl, memeDesk, memeEquitySeries, memeStartEquity } from './meme-book';
import type { MoneyUnit } from './money-units';
import {
  latestPredictionPnl,
  predictionDesk,
  predictionEquitySeries,
  predictionStartEquity,
} from './prediction-book';

export const NOT_RANKED = 'not ranked';

export const LEADERBOARD_SUBTITLE =
  'Desk sport: managers compete on % return vs each book’s own start. Not a risk mandate.';

export const LEADERBOARD_RULES =
  'Score is % vs that book’s own start, in its native unit. SOL is not converted to USD. Missing start is not ranked — not 0%. Ties go to lower drawdown, then the older book.';

const DAY_MS = 86_400_000;

export type LeaderboardCompetitorId = 'quantanamo' | 'oddsborne' | 'bandit' | 'grasshopper';

export type LeaderboardRow = {
  id: LeaderboardCompetitorId;
  slug: string;
  steward: string;
  role_title: string;
  accent: string;
  avatar_shape: AvatarShape;
  venue: DeskVenue | null;
  venue_label: string;
  unit: MoneyUnit | null;
  return_pct: number | null;
  start: number | null;
  now: number | null;
  start_as_of: string | null;
  last_marked: string | null;
  max_drawdown_pct: number | null;
  days_live: number | null;
  open_lots: number;
  risk_note: string;
  ranked: boolean;
  rank_note: string;
};

export type LeaderboardStanding = LeaderboardRow & {
  place: number | null;
};

export type DeskLeaderboard = {
  rows: LeaderboardStanding[];
  subtitle: string;
  rules: string;
};

export function percentReturn(start: number | null, now: number | null): number | null {
  if (start === null || now === null) return null;
  if (!(start > 0) || !Number.isFinite(start) || !Number.isFinite(now)) return null;
  return ((now - start) / start) * 100;
}

/** Peak-to-trough % from a time-ordered equity series. Null unless two+ marks exist. */
export function maxDrawdownPct(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  let peak = values[0];
  if (peak === undefined) return null;
  let worst = 0;
  let saw = false;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value > peak) peak = value;
    if (!(peak > 0)) continue;
    const drawdown = (peak - value) / peak;
    if (drawdown > worst) {
      worst = drawdown;
      saw = true;
    }
  }
  return saw ? worst * 100 : 0;
}

export function daysLive(startAt: string | null, endAt: string | null): number | null {
  if (!startAt || !endAt) return null;
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs < startMs) return null;
  return Math.floor((endMs - startMs) / DAY_MS);
}

export function riskNote(row: Pick<LeaderboardRow, 'max_drawdown_pct' | 'days_live' | 'open_lots' | 'ranked'>): string {
  if (row.max_drawdown_pct !== null) {
    const dd = `max DD ${row.max_drawdown_pct.toFixed(1)}%`;
    if (row.days_live !== null) return `${dd} · ${row.days_live}d live`;
    if (row.open_lots > 0) return `${dd} · ${row.open_lots} open`;
    return dd;
  }
  if (row.days_live !== null) {
    if (row.open_lots > 0) return `${row.days_live}d live · ${row.open_lots} open`;
    return `${row.days_live}d live`;
  }
  if (row.open_lots > 0) return `${row.open_lots} open`;
  if (!row.ranked) return 'not in ledger';
  return 'open risk not in ledger';
}

export function assembleLeaderboard(desk: DeskPayload): DeskLeaderboard {
  const cards = teamCards(deskTeam(desk));
  const bySlug = new Map(cards.map((card) => [card.slug, card]));
  const competitors = [
    stocksRow(desk, bySlug.get('quantanamo')),
    predictionsRow(desk, bySlug.get('oddsborne')),
    coinsRow(desk, bySlug.get('bandit')),
  ];
  const deskRow = grasshopperRow(desk, bySlug.get('grasshopper'));
  if (deskRow) competitors.push(deskRow);

  const ranked = competitors.filter((row) => row.ranked);
  const waiting = competitors.filter((row) => !row.ranked);
  ranked.sort(compareRanked);
  const ordered = [...ranked, ...waiting];
  const rows: LeaderboardStanding[] = ordered.map((row, index) => ({
    ...row,
    place: row.ranked ? index + 1 : null,
  }));

  return {
    rows,
    subtitle: LEADERBOARD_SUBTITLE,
    rules: LEADERBOARD_RULES,
  };
}

function compareRanked(a: LeaderboardRow, b: LeaderboardRow): number {
  const aPct = a.return_pct ?? Number.NEGATIVE_INFINITY;
  const bPct = b.return_pct ?? Number.NEGATIVE_INFINITY;
  if (aPct !== bPct) return bPct - aPct;
  const aDd = a.max_drawdown_pct;
  const bDd = b.max_drawdown_pct;
  if (aDd !== null && bDd !== null && aDd !== bDd) return aDd - bDd;
  const aStart = a.start_as_of ?? '9999';
  const bStart = b.start_as_of ?? '9999';
  if (aStart !== bStart) return aStart.localeCompare(bStart);
  return a.steward.localeCompare(b.steward);
}

function stocksRow(desk: DeskPayload, card: DeskTeamCard | undefined): LeaderboardRow {
  const start = desk.book.starting_nav;
  const now = desk.book.current_nav;
  const return_pct = percentReturn(start, now);
  const series = agenticNavSeries(desk);
  const start_as_of = series[0]?.as_of ?? null;
  const last_marked = desk.book.observed_at;
  const max_drawdown_pct = maxDrawdownPct(series.map((point) => point.value));
  const days_live = daysLive(start_as_of, last_marked);
  const open_lots = assembleDeskBookRollup(desk).lots_by_venue.equity;
  const ranked = return_pct !== null;
  const identity = stewardIdentity(card, 'quantanamo', 'QUANTANAMO', 'Equities trader');
  return finishRow({
    ...identity,
    id: 'quantanamo',
    venue: 'equity',
    venue_label: venueShort('equity'),
    unit: 'USD',
    return_pct,
    start,
    now,
    start_as_of,
    last_marked,
    max_drawdown_pct,
    days_live,
    open_lots,
    ranked,
    rank_note: ranked ? `vs book start ${start}` : NOT_RANKED,
  });
}

function predictionsRow(desk: DeskPayload, card: DeskTeamCard | undefined): LeaderboardRow {
  const payload = predictionDesk(desk);
  const startMark = predictionStartEquity(payload);
  const latest = latestPredictionPnl(payload);
  const start = startMark?.equity ?? null;
  const now = latest?.equity ?? null;
  const return_pct = percentReturn(start, now);
  const series = predictionEquitySeries(payload);
  const start_as_of = startMark?.as_of ?? null;
  const last_marked = latest?.as_of ?? null;
  const max_drawdown_pct = maxDrawdownPct(series.map((point) => point.equity));
  const days_live = daysLive(start_as_of, last_marked);
  const open_lots = assembleDeskBookRollup(desk).lots_by_venue.prediction;
  const ranked = return_pct !== null;
  const identity = stewardIdentity(card, 'oddsborne', 'ODDSBORNE', 'Prediction markets trader');
  return finishRow({
    ...identity,
    id: 'oddsborne',
    venue: 'prediction',
    venue_label: venueShort('prediction'),
    unit: 'USD',
    return_pct,
    start,
    now,
    start_as_of,
    last_marked,
    max_drawdown_pct,
    days_live,
    open_lots,
    ranked,
    rank_note: ranked ? `vs ${startMark?.source ?? 'pnl'} start` : NOT_RANKED,
  });
}

function coinsRow(desk: DeskPayload, card: DeskTeamCard | undefined): LeaderboardRow {
  const payload = memeDesk(desk);
  const startMark = memeStartEquity(payload);
  const latest = latestMemePnl(payload);
  const start = startMark?.equity_sol ?? null;
  const now = latest?.equity_sol ?? null;
  const return_pct = percentReturn(start, now);
  const series = memeEquitySeries(payload);
  const start_as_of = startMark?.as_of ?? series[0]?.as_of ?? null;
  const last_marked = latest?.as_of ?? null;
  const max_drawdown_pct = maxDrawdownPct(series.map((point) => point.equity_sol));
  const days_live = daysLive(start_as_of, last_marked);
  const open_lots = assembleDeskBookRollup(desk).lots_by_venue.meme;
  const ranked = return_pct !== null;
  const identity = stewardIdentity(card, 'bandit', 'BANDIT', 'Meme-coin trader');
  return finishRow({
    ...identity,
    id: 'bandit',
    venue: 'meme',
    venue_label: venueShort('meme'),
    unit: 'SOL',
    return_pct,
    start,
    now,
    start_as_of,
    last_marked,
    max_drawdown_pct,
    days_live,
    open_lots,
    ranked,
    rank_note: ranked ? `vs ${startMark?.source ?? 'bankroll'} start` : NOT_RANKED,
  });
}

/**
 * GRASSHOPPER is ledger owner, not a fourth trader. Only appear when a real
 * desk-level book exists that is not just the three venue legs.
 * The USD rollup is not that book — it would require FX to include SOL.
 */
export function hasDeskLevelBook(_desk: DeskPayload): boolean {
  return false;
}

function grasshopperRow(desk: DeskPayload, card: DeskTeamCard | undefined): LeaderboardRow | null {
  if (!hasDeskLevelBook(desk)) return null;
  const identity = stewardIdentity(card, 'grasshopper', 'GRASSHOPPER', 'Ledger steward');
  return finishRow({
    ...identity,
    id: 'grasshopper',
    venue: null,
    venue_label: 'LEDGER',
    unit: null,
    return_pct: null,
    start: null,
    now: null,
    start_as_of: null,
    last_marked: null,
    max_drawdown_pct: null,
    days_live: null,
    open_lots: 0,
    ranked: false,
    rank_note: NOT_RANKED,
  });
}

function finishRow(row: Omit<LeaderboardRow, 'risk_note'>): LeaderboardRow {
  return { ...row, risk_note: riskNote(row) };
}

function stewardIdentity(
  card: DeskTeamCard | undefined,
  slug: string,
  fallbackName: string,
  fallbackRole: string,
): Pick<LeaderboardRow, 'slug' | 'steward' | 'role_title' | 'accent' | 'avatar_shape'> {
  if (card) {
    return {
      slug: card.slug,
      steward: card.display_name,
      role_title: card.role_title,
      accent: card.accent,
      avatar_shape: card.avatar_shape,
    };
  }
  return {
    slug,
    steward: fallbackName,
    role_title: fallbackRole,
    accent: '#94a3b8',
    avatar_shape: 'spark',
  };
}

function agenticNavSeries(desk: DeskPayload): Array<{ as_of: string; value: number }> {
  const rows = agenticSnapshots(desk.snapshots ?? []).slice().sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  return rows.map((row) => ({ as_of: row.observed_at, value: row.total_value }));
}
