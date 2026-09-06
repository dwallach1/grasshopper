/**
 * ALL-tab rollup. USD books (Stocks + Predictions) add when present.
 * BANDIT SOL stays a separate line — never converted, never treated as USD.
 * Missing legs stay null / not-in-ledger. Never invent marks or P/L.
 */
import { latestMemePnl, memeDesk } from './meme-book';
import { deskBookNames, latestPredictionPnl, predictionDesk } from './prediction-book';
import type { DeskVenue } from './desk-venue';
import { rowVenue } from './desk-venue';
import type { DeskPayload } from './ledger-types';
import type { MoneyUnit } from './money-units';

export const USD_ROLLUP_NOTE =
  'USD NAV/cash = STOCKS + PREDICTIONS when those legs exist. SOL is native BANDIT — not converted.';

export type DeskBookLeg = {
  venue: DeskVenue;
  label: string;
  unit: MoneyUnit;
  equity: number | null;
  cash: number | null;
  lots: number;
  as_of: string | null;
};

export type DeskBookRollup = {
  usd_nav: number | null;
  usd_cash: number | null;
  usd_legs_used: DeskVenue[];
  sol_equity: number | null;
  sol_cash: number | null;
  open_lots: number;
  lots_by_venue: Record<DeskVenue, number>;
  legs: DeskBookLeg[];
  note: string;
};

export function addLedger(...values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let seen = false;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    sum += value;
    seen = true;
  }
  return seen ? sum : null;
}

export function assembleDeskBookRollup(desk: DeskPayload): DeskBookRollup {
  const prediction = latestPredictionPnl(predictionDesk(desk));
  const coins = latestMemePnl(memeDesk(desk));
  const names = deskBookNames(desk);
  const lots_by_venue: Record<DeskVenue, number> = { equity: 0, prediction: 0, meme: 0 };
  for (const row of names) {
    lots_by_venue[rowVenue(row)] += 1;
  }

  const stocksEquity = desk.book.current_nav;
  const stocksCash = desk.book.cash;
  const predictionEquity = prediction?.equity ?? null;
  const predictionCash = prediction?.cash ?? null;
  const usd_legs_used: DeskVenue[] = [];
  if (stocksEquity !== null || stocksCash !== null) usd_legs_used.push('equity');
  if (predictionEquity !== null || predictionCash !== null) usd_legs_used.push('prediction');

  const legs: DeskBookLeg[] = [
    {
      venue: 'equity',
      label: 'STOCKS',
      unit: 'USD',
      equity: stocksEquity,
      cash: stocksCash,
      lots: lots_by_venue.equity,
      as_of: desk.book.observed_at,
    },
    {
      venue: 'prediction',
      label: 'PREDICTIONS',
      unit: 'USD',
      equity: predictionEquity,
      cash: predictionCash,
      lots: lots_by_venue.prediction,
      as_of: prediction?.as_of ?? null,
    },
    {
      venue: 'meme',
      label: 'COINS',
      unit: 'SOL',
      equity: coins?.equity_sol ?? null,
      cash: coins?.cash_sol ?? null,
      lots: lots_by_venue.meme,
      as_of: coins?.as_of ?? null,
    },
  ];

  return {
    usd_nav: addLedger(stocksEquity, predictionEquity),
    usd_cash: addLedger(stocksCash, predictionCash),
    usd_legs_used,
    sol_equity: coins?.equity_sol ?? null,
    sol_cash: coins?.cash_sol ?? null,
    open_lots: names.length,
    lots_by_venue,
    legs,
    note: USD_ROLLUP_NOTE,
  };
}
