import { describe, expect, test } from 'bun:test';

import { NOT_IN_LEDGER } from './book-performance';
import type {
  ExposureRow,
  FillRow,
  IntentRow,
  ProposalRow,
  ThesisRow,
  ThesisSymbolLink,
} from './ledger-types';
import {
  AGENTIC_LAST4,
  assembleFillLog,
  attachThesisLots,
  fillLogCaption,
  latestBookExposures,
  MARK_NOT_IN_LEDGER,
  NO_POSITION,
} from './thesis-book';

const LIVE = '2026-08-27T13:22:00.000Z';
const YESTERDAY = '2026-08-26T19:04:32.415Z';
const OLDER = '2026-08-24T16:18:10.000Z';
const LATER_PERSONAL = '2026-08-27T14:00:00.000Z';
const FILLED_AT = '2026-08-27T13:23:10.587Z';

function thesis(id: string, symbols: string[] = []): ThesisRow {
  return {
    id,
    name: id,
    summary: id,
    status: 'hardening',
    confidence: 80,
    time_horizon: 'medium',
    stance: 'bullish',
    variant_perception: null,
    falsifier: null,
    created_at: LIVE,
    updated_at: LIVE,
    symbols,
    lots: [],
  };
}

function exposure(
  symbol: string,
  quantity: number,
  average_buy_price: number,
  extra: Partial<ExposureRow> = {},
): ExposureRow {
  return {
    symbol,
    quantity,
    average_buy_price,
    observed_at: LIVE,
    account_last4: AGENTIC_LAST4,
    ...extra,
  };
}

function proposal(
  thesis_id: string | null,
  symbol: string,
  status: string,
  extra: Partial<ProposalRow> = {},
): ProposalRow {
  return {
    id: extra.id ?? 1,
    thesis_id,
    symbol,
    side: 'buy',
    notional: 1000,
    order_type: 'market',
    status,
    rationale: 'test',
    created_at: FILLED_AT,
    ...extra,
  };
}

function intent(
  id: string,
  symbol: string,
  extra: Partial<IntentRow> = {},
): IntentRow {
  return {
    id,
    account_key: 'agentic-7638',
    symbol,
    side: 'buy',
    status: 'filled',
    mode: 'live',
    notional: 1000,
    quantity: extra.quantity ?? 1,
    order_type: 'market',
    broker_order_id: null,
    created_at: FILLED_AT,
    updated_at: FILLED_AT,
    ...extra,
  };
}

const liveBook = [
  exposure('IREN', 25.208855, 39.67),
  exposure('NBIS', 4.653004, 214.91),
  exposure('CIFR', 63.211524, 15.82),
  exposure('DG', 14, 132.25),
];

const yesterdayBook = [
  exposure('IREN', 25.208855, 39.6686, { observed_at: YESTERDAY }),
  exposure('NBIS', 4.653004, 214.9149, { observed_at: YESTERDAY }),
  exposure('CIFR', 63.211524, 15.8199, { observed_at: YESTERDAY }),
];

const liveProposals = [
  proposal('neocloud_compute', 'IREN', 'filled', { id: 28 }),
  proposal('neocloud_compute', 'NBIS', 'filled', { id: 29 }),
  proposal('neocloud_compute', 'CIFR', 'filled', { id: 30 }),
  proposal('earnings_gap_structure', 'DG', 'filled', { id: 32, notional: 1851.5 }),
  proposal('ai_power_nuclear', 'CEG', 'deferred', { id: 24, notional: 0 }),
  proposal('semis_photonics', 'LITE', 'rejected', { id: 22, notional: 0 }),
];

const liveLinks: ThesisSymbolLink[] = [
  { thesis_id: 'neocloud_compute', symbol: 'CIFR', role: 'held' },
  { thesis_id: 'neocloud_compute', symbol: 'NBIS', role: 'held' },
  { thesis_id: 'neocloud_compute', symbol: 'IREN', role: 'held' },
  { thesis_id: 'earnings_gap_structure', symbol: 'DG', role: 'held' },
  { thesis_id: 'earnings_gap_structure', symbol: 'DLTR', role: 'pre_open_primary' },
  { thesis_id: 'earnings_gap_structure', symbol: 'ANF', role: 'case_study' },
  { thesis_id: 'semis_photonics', symbol: 'NBIS', role: 'member' },
  { thesis_id: 'semis_photonics', symbol: 'IREN', role: 'member' },
  { thesis_id: 'ai_power_nuclear', symbol: 'IREN', role: 'candidate' },
  { thesis_id: 'ai_power_nuclear', symbol: 'NBIS', role: 'candidate' },
];

describe('latest Agentic book', () => {
  test('latest 7638 snapshot includes DG and drops the 8/26 lots', () => {
    const book = latestBookExposures([
      ...yesterdayBook,
      ...liveBook,
      exposure('IREN', 480.926017, 47.82, { observed_at: OLDER, account_last4: '7254' }),
    ]);
    expect(book.map((row) => row.symbol).sort()).toEqual(['CIFR', 'DG', 'IREN', 'NBIS']);
    expect(book.every((row) => row.account_last4 === AGENTIC_LAST4)).toBe(true);
    expect(book.every((row) => row.observed_at === LIVE)).toBe(true);
    expect(book.find((row) => row.symbol === 'DG')?.quantity).toBe(14);
    expect(book.find((row) => row.symbol === 'IREN')?.quantity).toBeCloseTo(25.208855);
  });

  test('a later personal snapshot cannot displace the Agentic book', () => {
    const book = latestBookExposures([
      ...liveBook,
      exposure('HOOD', 500, 33.4, { observed_at: LATER_PERSONAL, account_last4: '7254' }),
    ]);
    expect(book.map((row) => row.symbol).sort()).toEqual(['CIFR', 'DG', 'IREN', 'NBIS']);
  });

  test('other last4 books are ignored when 7638 is missing, not used as a fallback', () => {
    const book = latestBookExposures([
      exposure('HOOD', 500, 33.4, { account_last4: '7254' }),
      exposure('NVDA', 10, 100, { account_last4: '7094' }),
    ]);
    expect(book).toEqual([]);
  });
});

describe('thesis lots', () => {
  test('binds earnings_gap_structure to the DG lot on the latest 7638 snapshot', () => {
    const theses = attachThesisLots(
      [
        thesis('neocloud_compute', ['CIFR', 'NBIS', 'IREN']),
        thesis('earnings_gap_structure', ['DG', 'DLTR', 'ANF']),
        thesis('ai_power_nuclear', ['IREN', 'NBIS', 'CEG']),
        thesis('semis_photonics', ['NBIS', 'IREN', 'NVDA']),
      ],
      {
        links: liveLinks,
        proposals: liveProposals,
        exposures: [...yesterdayBook, ...liveBook],
      },
    );
    const gap = theses.find((row) => row.id === 'earnings_gap_structure');
    expect(gap?.lots.map((lot) => lot.symbol)).toEqual(['DG']);
    expect(gap?.lots[0]?.quantity).toBe(14);
    expect(gap?.lots[0]?.average_cost).toBeCloseTo(132.25);
    expect(gap?.lots[0]?.invested).toBeCloseTo(14 * 132.25);
    expect(gap?.lots[0]?.mark).toBeNull();
    expect(gap?.lots[0]?.pnl).toBeNull();
    expect(gap?.lots[0]?.note).toBe(MARK_NOT_IN_LEDGER);
    const neocloud = theses.find((row) => row.id === 'neocloud_compute');
    expect(neocloud?.lots.map((lot) => lot.symbol)).toEqual(['CIFR', 'IREN', 'NBIS']);
    expect(theses.find((row) => row.id === 'ai_power_nuclear')?.lots).toEqual([]);
    expect(theses.find((row) => row.id === 'semis_photonics')?.lots).toEqual([]);
  });

  test('unheld symbols stay no position, including DLTR on earnings_gap_structure', () => {
    const theses = attachThesisLots(
      [thesis('earnings_gap_structure'), thesis('ai_power_nuclear'), thesis('crypto')],
      {
        links: liveLinks,
        proposals: liveProposals,
        exposures: liveBook,
      },
    );
    expect(theses.find((row) => row.id === 'earnings_gap_structure')?.lots.map((lot) => lot.symbol))
      .toEqual(['DG']);
    expect(theses.find((row) => row.id === 'ai_power_nuclear')?.lots).toEqual([]);
    expect(theses.find((row) => row.id === 'crypto')?.lots).toEqual([]);
  });

  test('held role alone binds an open lot when no filled proposal exists', () => {
    const theses = attachThesisLots([thesis('neocloud_compute')], {
      links: [{ thesis_id: 'neocloud_compute', symbol: 'IREN', role: 'held' }],
      proposals: [],
      exposures: [exposure('IREN', 25.208855, 39.67)],
    });
    expect(theses[0]?.lots).toHaveLength(1);
    expect(theses[0]?.lots[0]?.symbol).toBe('IREN');
  });

  test('rejected proposals and candidate/member tags do not invent a position', () => {
    const theses = attachThesisLots([thesis('semis_photonics'), thesis('ai_power_nuclear')], {
      links: liveLinks,
      proposals: liveProposals,
      exposures: liveBook,
    });
    expect(theses.every((row) => row.lots.length === 0)).toBe(true);
  });

  test('computes P/L only when a ledger mark is supplied', () => {
    const theses = attachThesisLots([thesis('neocloud_compute')], {
      links: [{ thesis_id: 'neocloud_compute', symbol: 'IREN', role: 'held' }],
      proposals: [proposal('neocloud_compute', 'IREN', 'filled')],
      exposures: [exposure('IREN', 25.208855, 39.67)],
      marks: new Map([['IREN', 40]]),
    });
    const lot = theses[0]?.lots[0];
    expect(lot?.mark).toBe(40);
    expect(lot?.pnl).toBeCloseTo((40 - 39.67) * 25.208855);
    expect(lot?.note).toBe('');
  });

  test('8/26 lots are not the live book once a newer 7638 snapshot exists', () => {
    const theses = attachThesisLots([thesis('earnings_gap_structure')], {
      links: liveLinks,
      proposals: liveProposals,
      exposures: yesterdayBook,
    });
    expect(theses[0]?.lots).toEqual([]);
  });
});

describe('fill log', () => {
  test('uses filled intents when broker_fills is empty', () => {
    const rows = assembleFillLog({
      fills: [],
      intents: [
        intent('iren', 'IREN', { quantity: 25.208855, notional: 1000 }),
        intent('nbis', 'NBIS', { quantity: 4.653004, notional: 1000 }),
        intent('cifr', 'CIFR', { quantity: 63.211524, notional: 1000 }),
        intent('dg', 'DG', {
          quantity: 14,
          notional: 1851.5,
          created_at: FILLED_AT,
          updated_at: FILLED_AT,
        }),
      ],
    });
    expect(rows.map((row) => row.symbol)).toEqual(['CIFR', 'DG', 'IREN', 'NBIS']);
    expect(rows.every((row) => row.source === 'filled_intent')).toBe(true);
    const dg = rows.find((row) => row.symbol === 'DG');
    expect(dg?.price).toBeCloseTo(1851.5 / 14);
    expect(dg?.at).toBe(FILLED_AT);
    expect(fillLogCaption(rows)).toBe('filled intents · broker fills not in ledger');
  });

  test('prefers broker_fills when they exist and does not invent a missing intent symbol', () => {
    const fills: FillRow[] = [
      {
        id: 'fill-iren',
        trade_intent_id: 'iren',
        quantity: 25.208855,
        price: 39.67,
        executed_at: '2026-08-26T19:06:00.000Z',
      },
    ];
    const rows = assembleFillLog({
      fills,
      intents: [intent('iren', 'IREN', { quantity: 25.208855, notional: 1000 })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('broker_fill');
    expect(rows[0]?.price).toBeCloseTo(39.67);
    expect(fillLogCaption(rows)).toBe('broker fills');
  });

  test('empty ledger is not in ledger, not a fake stream', () => {
    const rows = assembleFillLog({ fills: [], intents: [] });
    expect(rows).toEqual([]);
    expect(fillLogCaption(rows)).toBe(NOT_IN_LEDGER);
    expect(NO_POSITION).toBe('no position');
  });

  test('ignores non-Agentic intents so personal fills stay off the Book tape', () => {
    const rows = assembleFillLog({
      fills: [],
      intents: [
        intent('personal', 'HOOD', { account_key: 'robinhood-7254', quantity: 10, notional: 330 }),
        intent('agentic', 'IREN', { quantity: 25.208855, notional: 1000 }),
      ],
    });
    expect(rows.map((row) => row.symbol)).toEqual(['IREN']);
  });
});
