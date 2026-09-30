# Live Trading Checklist

Before any real trade, Quantanamo should:

1. Refresh the authorized trading account and all readable positions through Robinhood immediately before sizing.
2. Persist the refreshed account values to `account_snapshots` and positions to `portfolio_exposure` in Supabase; reject sizing when the refresh is missing or stale.
3. Validate each symbol with Robinhood search/quotes/tradability.
4. Check existing exposure across readable Robinhood accounts.
5. Identify the catalyst, expected swing horizon, and invalidation.
6. Read `config/trade_policy.json`. Record a fresh `account_snapshots` row, then call `steward_sizing_guidance('quantanamo', <thesis_id>, <SYMBOL>, <requested usd>, <invalidation usd/share>, <entry usd/share>)`. Buy only when `entry_allowed` is true, and size to `sized_notional` = min(requested, edge-scaled `max_stake`, spendable cash, exposure fit) (there is no outcome multiplier; `max_stake` = starter 0.03 × book / bet volatility until proven, × the steward drawdown scale; see `docs/rules/`). There's no per-position % cap and no margin. A missing invalidation returns `missing_invalidation`; a book observation older than 6h returns `stale_book`; open risk to invalidation at 10% of book returns `exposure_cap`; the thesis must be hardening with a gate score ≥ 80 (`results_basis.gate_score`, the results score shrunk toward 50 by 16 zero-mean trades; `quantanamo_unscored` / `quantanamo_confidence_gate` otherwise, and David approves). Write the same `invalidation_price` (and `invalidation_note`) on the new `position_episodes` lot. The database rejects a new open lot without one. There are no fixed rails (trade count, spread block, 09:45–15:45 window, add %, reduce band, averaging-down ban, global stop-loss, drawdown limit); exits come from the lot's own invalidation (`position_episodes.invalidation_price` / `invalidation_note`), then the thesis's written invalidation; spread and session edges are guidance.
7. Run bull-case, bear-case, and portfolio-risk reviews when practical.
8. Use web research when the thesis depends on current events, 13F filings, articles, SEC filings, or fresh market context.
9. Call Robinhood `review_equity_order` before any equity placement.
10. Persist every proposal, placement, outcome, and lesson into the canonical Supabase Postgres database.
11. Confirm the US regular market session is open at placement time. Do not submit or queue after-hours orders.
12. No per-trade user approval is required. If a Robinhood MCP write tool imposes its own unavoidable confirmation after review, obey that tool requirement.
13. Maintain the configured standing-cash and tactical-sleeve percentages without embedding symbol allocations. Cash is permitted only transiently when the market is closed or every candidate fails a gate, and must be re-screened at the next regular session.

The user authorizes autonomous execution after validation during regular market hours where tooling and safety requirements allow it.
