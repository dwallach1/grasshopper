import { describe, expect, test } from 'bun:test';

import { classifyRobinhoodTools } from './robinhood-tool-policy';

describe('Robinhood MCP capability classification', () => {
  test('recognizes the complete read-only allowlist', () => {
    const status = classifyRobinhoodTools([
      'get_accounts',
      'get_portfolio',
      'get_equity_positions',
      'get_equity_orders',
      'get_equity_quotes',
      'get_equity_tradability',
      'get_equity_fundamentals',
      'get_equity_historicals',
      'get_earnings_results',
      'search',
    ]);
    expect(status.requiredReadToolsPresent).toBe(true);
    expect(status.executionEnabled).toBe(false);
    expect(status.unknownTools).toEqual([]);
  });

  test('fails closed on mutation and newly discovered tools', () => {
    const status = classifyRobinhoodTools([
      'get_accounts',
      'place_equity_order',
      'review_equity_order',
      'future_read_tool',
    ]);
    expect(status.requiredReadToolsPresent).toBe(false);
    expect(status.blockedTools).toEqual(['place_equity_order', 'review_equity_order']);
    expect(status.unknownTools).toContain('future_read_tool');
    expect(status.executionEnabled).toBe(false);
  });

  test('deduplicates tool names before reporting counts', () => {
    const status = classifyRobinhoodTools(['get_accounts', 'get_accounts']);
    expect(status.toolCount).toBe(1);
  });

  test('enables only the exact equity review and placement pair', () => {
    const status = classifyRobinhoodTools([
      'get_accounts',
      'get_portfolio',
      'get_equity_positions',
      'get_equity_orders',
      'get_equity_quotes',
      'get_equity_tradability',
      'get_equity_fundamentals',
      'get_equity_historicals',
      'get_earnings_results',
      'search',
      'review_equity_order',
      'place_equity_order',
      'place_option_order',
    ], true);
    expect(status.executionEnabled).toBe(true);
    expect(status.blockedTools).toEqual(['place_option_order']);
    expect(status.unknownTools).toEqual(['place_option_order']);
  });

  test('stays fail closed if one required execution tool disappears', () => {
    const status = classifyRobinhoodTools(['review_equity_order'], true);
    expect(status.executionEnabled).toBe(false);
  });
});
