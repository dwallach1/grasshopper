export const ROBINHOOD_READ_ONLY_TOOL_ALLOWLIST = new Set([
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

export const ROBINHOOD_EXECUTION_TOOL_ALLOWLIST = new Set([
  'review_equity_order',
  'place_equity_order',
]);

export type RobinhoodToolClassification = {
  requiredReadToolsPresent: boolean;
  readTools: string[];
  blockedTools: string[];
  unknownTools: string[];
  toolCount: number;
  executionEnabled: boolean;
};

export function classifyRobinhoodTools(
  toolNames: readonly string[],
  executionEnabled = false,
): RobinhoodToolClassification {
  const unique = [...new Set(toolNames)].sort();
  const readTools = unique.filter((name) => ROBINHOOD_READ_ONLY_TOOL_ALLOWLIST.has(name));
  const knownTools = new Set([
    ...ROBINHOOD_READ_ONLY_TOOL_ALLOWLIST,
    ...ROBINHOOD_EXECUTION_TOOL_ALLOWLIST,
  ]);
  const unknownTools = unique.filter((name) => !knownTools.has(name));
  const blockedTools = unique.filter((name) =>
    /^(review|place|cancel|exercise|create|update|add|remove|follow|unfollow)_/.test(name)
    && (!executionEnabled || !ROBINHOOD_EXECUTION_TOOL_ALLOWLIST.has(name)),
  );
  const requiredExecutionToolsPresent = [...ROBINHOOD_EXECUTION_TOOL_ALLOWLIST]
    .every((name) => unique.includes(name));
  return {
    requiredReadToolsPresent: [...ROBINHOOD_READ_ONLY_TOOL_ALLOWLIST].every((name) => readTools.includes(name)),
    readTools,
    blockedTools,
    unknownTools,
    toolCount: unique.length,
    executionEnabled: executionEnabled && requiredExecutionToolsPresent,
  };
}
