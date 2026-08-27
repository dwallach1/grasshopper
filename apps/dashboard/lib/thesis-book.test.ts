import { describe, expect, test } from 'bun:test';

import { NOT_IN_LEDGER } from './book-performance';
import type {
  ExposureRow,
  FillRow,
  IntentRow,
  PositionRow,
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

const OBSERVED = '2026-08-26T19:04:32.415Z';
const OLDER = '2026-08-24T16:18:10.000Z';
const LATER_PERSONAL = '2026-08-26T21:00:00.000Z';
const FILLED_AT = '2026-08-26T19:05:48.528Z';

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
    created_at: OBSERVED,
    updated_at: OBSERVED,
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
    observed_at: OBSERVED,
    account_last4: AGENTIC_LAST4,
    ...extra,
  };
}

function position(symbol: string, quantity: number, average_cost: number): PositionRow {
  return {
    id: symbol,
    account_key: 'agentic-7638',
    symbol,
    status: 'open',
    quantity,
    average_cost,
    opened_at: '2026-08-26T19:01:00.000Z',
    next_review_at: null,
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
  exposure('IREN', 25.208855, 39.6686),
  exposure('NBIS', 4.653004, 214.9149),
  exposure('CIFR', 63.211524, 15.8199),
];

const livePositions = [
  position('IREN', 25.208855, 39.6686),
  position('NBIS', 4.653004, 214.9149),
  position('CIFR', 63.211524, 15.8199),
];

const liveProposals = [
  proposal('neocloud_compute', 'IREN', 'filled', { id: 28 }),
  proposal('neocloud_compute', 'NBIS', 'filled', { id: 29 }),
  proposal('neocloud_compute', 'CIFR', 'filled', { id: 30 }),
  proposal('ai_power_nuclear', 'CEG', 'deferred', { id: 24, notional: 0 }),
  proposal('semis_photonics', 'LITE', 'rejected', { id: 22, notional: 0 }),
];

const liveLinks: ThesisSymbolLink[] = [
  { thesis_id: 'neocloud_compute', symbol: 'CIFR', role: 'held' },
  { thesis_id: 'neocloud_compute', symbol: 'NBIS', role: 'held' },
  { thesis_id: 'neocloud_compute', symbol: 'IREN', role: 'held' },
  { thesis_id: 'semis_photonics', symbol: 'NBIS', role: 'member' },
  { thesis_id: 'semis_photonics', symbol: 'IREN', role: 'member' },
  { thesis_id: 'ai_power_nuclear', symbol: 'IREN', role: 'candidate' },
  { thesis_id: 'ai_power_nuclear', symbol: 'NBIS', role: 'candidate' },
  { thesis_id: 'earnings_gap_structure', symbol: 'ANF', role: 'case_study' },
];

describe('latest Agentic book', () => {
  test('keeps the 2026-08-26 7638 snapshot and drops older personal books', () => {
    const rows = [
      ...liveBook,
      exposure('IREN', 480.926017, 47.82, { observed_at: OLDER, account_last4: '7254' }),
      exposure('NVDA', 126.56, 153.05, { observed_at: OLDER, account_last4: '7254' }),
    ];
    const book = latestBookExposures(rows);
    expect(book.map((row) => row.symbol).sort()).toEqual(['CIFR', 'IREN', 'NBIS']);
    expect(book.every((row) => row.account_last4 === AGENTIC_LAST4)).toBe(true);
    expect(book.find((row) => row.symbol === 'IREN')?.quantity).toBeCloseTo(25.208855);
  });

  test('a later personal snapshot cannot displace the Agentic book', () => {
    const book = latestBookExposures([
      ...liveBook,
      exposure('HOOD', 500, 33.4, { observed_at: LATER_PERSONAL, account_last4: '7254' }),
    ]);
    expect(book.map((row) => row.symbol).sort()).toEqual(['CIFR', 'IREN', 'NBIS']);
  });
});

describe('thesis lots', () => {
  test('binds neocloud_compute to IREN/NBIS/CIFR from filled proposals and held roles', () => {
    const theses = attachThesisLots(
      [
        thesis('neocloud_compute', ['CIFR', 'NBIS', 'IREN']),
        thesis('earnings_gap_structure', ['ANF']),
        thesis('ai_power_nuclear', ['IREN', 'NBIS', 'CEG']),
        thesis('semis_photonics', ['NBIS', 'IREN', 'NVDA']),
      ],
      {
        links: liveLinks,
        proposals: liveProposals,
        exposures: liveBook,
        positions: livePositions,
      },
    );
    const neocloud = theses.find((row) => row.id === 'neocloud_compute');
    expect(neocloud?.lots.map((lot) => lot.symbol)).toEqual(['CIFR', 'IREN', 'NBIS']);
    const iren = neocloud?.lots.find((lot) => lot.symbol === 'IREN');
    expect(iren?.side).toBe('buy');
    expect(iren?.quantity).toBeCloseTo(25.208855);
    expect(iren?.average_cost).toBeCloseTo(39.6686);
    expect(iren?.invested).toBeCloseTo(25.208855 * 39.6686);
    expect(iren?.mark).toBeNull();
    expect(iren?.pnl).toBeNull();
    expect(iren?.note).toBe(MARK_NOT_IN_LEDGER);
    expect(theses.find((row) => row.id === 'earnings_gap_structure')?.lots).toEqual([]);
    expect(theses.find((row) => row.id === 'ai_power_nuclear')?.lots).toEqual([]);
    expect(theses.find((row) => row.id === 'semis_photonics')?.lots).toEqual([]);
  });

  test('held role alone binds an open lot when no filled proposal exists', () => {
    const theses = attachThesisLots([thesis('neocloud_compute')], {
      links: [{ thesis_id: 'neocloud_compute', symbol: 'IREN', role: 'held' }],
      proposals: [],
      exposures: [exposure('IREN', 25.208855, 39.6686)],
      positions: [],
    });
    expect(theses[0]?.lots).toHaveLength(1);
    expect(theses[0]?.lots[0]?.symbol).toBe('IREN');
  });

  test('rejected proposals and candidate/member tags do not invent a position', () => {
    const theses = attachThesisLots([thesis('semis_photonics'), thesis('ai_power_nuclear')], {
      links: liveLinks,
      proposals: liveProposals,
      exposures: liveBook,
      positions: livePositions,
    });
    expect(theses.every((row) => row.lots.length === 0)).toBe(true);
  });

  test('computes P/L only when a ledger mark is supplied', () => {
    const theses = attachThesisLots([thesis('neocloud_compute')], {
      links: [{ thesis_id: 'neocloud_compute', symbol: 'IREN', role: 'held' }],
      proposals: [proposal('neocloud_compute', 'IREN', 'filled')],
      exposures: [exposure('IREN', 25.208855, 39.6686)],
      positions: [],
      marks: new Map([['IREN', 40]]),
    });
    const lot = theses[0]?.lots[0];
    expect(lot?.mark).toBe(40);
    expect(lot?.pnl).toBeCloseTo((40 - 39.6686) * 25.208855);
    expect(lot?.note).toBe('');
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
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.symbol)).toEqual(['CIFR', 'IREN', 'NBIS']);
    expect(rows.every((row) => row.source === 'filled_intent')).toBe(true);
    expect(rows.every((row) => row.status === 'filled')).toBe(true);
    const iren = rows.find((row) => row.symbol === 'IREN');
    expect(iren?.price).toBeCloseTo(1000 / 25.208855);
    expect(iren?.notional).toBe(1000);
    expect(fillLogCaption(rows)).toBe('filled intents · broker fills not in ledger');
  });

  test('prefers broker_fills when they exist and does not invent a missing intent symbol', () => {
    const fills: FillRow[] = [
      {
        id: 'fill-iren',
        trade_intent_id: 'iren',
        quantity: 25.208855,
        price: 39.6686,
        executed_at: '2026-08-26T19:06:00.000Z',
      },
    ];
    const rows = assembleFillLog({
      fills,
      intents: [intent('iren', 'IREN', { quantity: 25.208855, notional: 1000 })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('broker_fill');
    expect(rows[0]?.price).toBeCloseTo(39.6686);
    expect(rows[0]?.notional).toBeCloseTo(25.208855 * 39.6686);
    expect(fillLogCaption(rows)).toBe('broker fills');
  });

  test('empty ledger is not in ledger, not a fake stream', () => {
    const rows = assembleFillLog({ fills: [], intents: [] });
    expect(rows).toEqual([]);
    expect(fillLogCaption(rows)).toBe(NOT_IN_LEDGER);
    expect(NO_POSITION).toBe('no position');
  });

  test('ignores non-Agentic intents so personal fills stay off Home', () => {
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
