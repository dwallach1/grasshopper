import { describe, expect, test } from 'bun:test';

import { MARK_NOT_IN_LEDGER } from './book-performance';
import {
  assembleCrtBoot,
  crtBootDurationMs,
  CRT_BOOT_FADE_MS,
  CRT_BOOT_FIRST_MS,
  CRT_BOOT_HOLD_MS,
  CRT_BOOT_STEP_MS,
  padCrtDots,
} from './desk-crt-boot';
import { fallbackTeam } from './desk-team';
import type { BookNameLine, DeskPayload } from './ledger-types';
import { BANDIT_BANKROLL_SOL_START, BANDIT_PRIMARY_ACCOUNT } from './meme-book';

function equityLine(symbol: string): BookNameLine {
  return {
    symbol,
    quantity: 1,
    average_cost: null,
    cost: null,
    mark: null,
    pnl: null,
    note: MARK_NOT_IN_LEDGER,
    venue: 'equity',
  };
}

function liveDesk(): DeskPayload {
  const desk = {
    generated_at: '2026-09-07T13:16:55.309Z',
    source: 'snapshot',
    snapshots: [
      {
        observed_at: '2026-08-23T20:26:25.000Z',
        account_label: 'Agentic',
        total_value: 5000,
        equity_value: 0,
        cash: 5000,
        buying_power: 5000,
        source: 'robinhood_mcp',
      },
      {
        observed_at: '2026-09-04T20:06:00.000Z',
        account_label: 'robinhood_agentic_7638',
        total_value: 6020.0632,
        equity_value: 2166.0332,
        cash: 3854.03,
        buying_power: 3854.03,
        source: 'robinhood_mcp',
      },
    ],
    book: {
      account_label: 'robinhood_agentic_7638',
      observed_at: '2026-09-04T20:06:00.000Z',
      last4: '7638',
      buying_power: 3854.03,
      starting_nav: 5000,
      current_nav: 6020.0632,
      cash: 3854.03,
      deployed: 2166.0332,
      vs_start: 1020.0632,
      vs_start_note: 'vs first Agentic snapshot',
      day_pnl: 518.95,
      day_pnl_note: 'vs prior NY session',
      vs_cost: null,
      vs_cost_note: MARK_NOT_IN_LEDGER,
      names: [equityLine('AOUT')],
    },
    prediction_markets: {
      desk: 'ODDSBORNE',
      venue: 'prediction',
      markets: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [
        {
          id: 'seed',
          account_key: 'polymarket-us-primary',
          as_of: '2026-09-06T13:10:47.142Z',
          realized: 0,
          unrealized: 0,
          fees: 0,
          cash: 426,
          equity: 426,
          notes: 'seed',
        },
        {
          id: 'latest-pm',
          account_key: 'polymarket-us-primary',
          as_of: '2026-09-06T13:43:43.294Z',
          realized: 0,
          unrealized: -1.9299,
          fees: 1.93,
          cash: 358.5809,
          equity: 424.07,
          notes: 'mark',
        },
      ],
      notes: [],
    },
    meme_coins: {
      desk: 'BANDIT',
      venue: 'meme',
      tokens: [],
      positions: [],
      orders: [],
      fills: [],
      pnl: [
        {
          id: 'seed-sol',
          account_key: BANDIT_PRIMARY_ACCOUNT,
          as_of: '2026-09-06T14:23:40.405Z',
          realized: 0,
          unrealized: 0,
          fees: 0,
          cash_sol: 2,
          equity_sol: BANDIT_BANKROLL_SOL_START,
          notes: 'seed',
        },
        {
          id: 'latest-sol',
          account_key: BANDIT_PRIMARY_ACCOUNT,
          as_of: '2026-09-06T15:48:20.740Z',
          realized: 0,
          unrealized: 0.02298,
          fees: 0,
          cash_sol: 1.97261544,
          equity_sol: 2.0355978427111925,
          notes: 'mark',
        },
      ],
      notes: [],
    },
    fill_log: [],
    routines: [],
    team: fallbackTeam(),
  };
  // SAFETY: fixture only populates CRT boot / board fields this test reads.
  return desk as DeskPayload;
}

describe('CRT boot stages', () => {
  test('warming copy waits; live snapshot adds the ranked lead only', () => {
    expect(assembleCrtBoot(null).map((row) => `${row.label}:${row.status}`)).toEqual([
      'GRASSHOPPER:READY',
      'LOCAL SNAPSHOT:WAIT',
      'LEDGER ONLINE:HOLD',
    ]);
    const live = assembleCrtBoot(liveDesk());
    expect(live.map((row) => row.label)).toEqual([
      'GRASSHOPPER',
      'LOCAL SNAPSHOT',
      'LEDGER ONLINE',
      'QUANTANAMO',
    ]);
    expect(live[1]?.status).toBe('LINK');
    expect(live[2]?.status).toBe('OK');
    expect(live[3]?.status).toBe('+20.40%');
    expect(padCrtDots('GRASSHOPPER', 'READY', 24)).toBe('GRASSHOPPER ...... READY');
  });

  test('boot duration stays short', () => {
    expect(crtBootDurationMs(4)).toBe(
      CRT_BOOT_FIRST_MS + 3 * CRT_BOOT_STEP_MS + CRT_BOOT_HOLD_MS + CRT_BOOT_FADE_MS,
    );
    expect(crtBootDurationMs(4)).toBeLessThan(4000);
  });
});
