# Live Trading Checklist

Before any real trade, Quantanamo should:

1. Refresh the authorized trading account and all readable positions through Robinhood immediately before sizing.
2. Persist the refreshed account values to `account_snapshots` and positions to `portfolio_exposure` in Supabase; reject sizing when the refresh is missing or stale.
3. Validate each symbol with Robinhood search/quotes/tradability.
4. Check existing exposure across readable Robinhood accounts.
5. Identify the catalyst, expected swing horizon, and invalidation.
6. Read `config/trade_policy.json`; calculate every dollar limit from the refreshed Robinhood total portfolio value and cap the result by live buying power.
7. Run bull-case, bear-case, and portfolio-risk reviews when practical.
8. Use web research when the thesis depends on current events, 13F filings, articles, SEC filings, or fresh market context.
9. Call Robinhood `review_equity_order` before any equity placement.
10. Persist every proposal, placement, outcome, and lesson into the canonical Supabase Postgres database.
11. Confirm the US regular market session is open at placement time. Do not submit or queue after-hours orders.
12. No per-trade user approval is required. If a Robinhood MCP write tool imposes its own unavoidable confirmation after review, obey that tool requirement.
13. Maintain the configured standing-cash and tactical-sleeve percentages without embedding symbol allocations. Cash is permitted only transiently when the market is closed or every candidate fails a gate, and must be re-screened at the next regular session.

The user authorizes autonomous execution after validation during regular market hours where tooling and safety requirements allow it.
