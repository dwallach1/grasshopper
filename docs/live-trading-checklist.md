# Live Trading Checklist

Before any real trade, ThesisForge should:

1. Confirm the account is the Agentic account ending 7638.
2. Confirm buying power through Robinhood MCP.
3. Validate each symbol with Robinhood search/quotes/tradability.
4. Check existing exposure across readable Robinhood accounts.
5. Identify the catalyst, expected swing horizon, and invalidation.
6. Read `config/trade_policy.json` and size by conviction/risk, not fixed caps.
7. Run bull-case, bear-case, and portfolio-risk reviews when practical.
8. Use web research when the thesis depends on current events, 13F filings, articles, SEC filings, or fresh market context.
9. Call Robinhood `review_equity_order` before any equity placement.
10. Persist every proposal, placement, outcome, and lesson into `data/thesisforge.sqlite`.
11. If a Robinhood MCP write tool requires explicit confirmation after review, obey that tool requirement.

The user wants autonomous execution after validation where tooling and safety requirements allow it.
