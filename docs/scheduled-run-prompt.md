# ThesisForge Scheduled Run Prompt

Run this workflow in `/Users/davidwallach/code/robinhood_trader`.

Use only X bookmark data, linked article text when fetchable, and the Robinhood MCP. Do not use external market-data providers.

Steps:
0. Start a durable scheduled-run recap with `bun run run:report -- start scheduled_research`. Read `config/trade_policy.json` and obey its sizing, asset-class, market-hours, and execution rules.
1. Confirm `THESISFORGE_DATABASE_URL` is configured, then run `bun run x:bookmarks`. The fetch streams directly into normalized Supabase bookmark tables; do not create a local bookmark JSON file.
2. Use Robinhood MCP to refresh the authorized trading account and all readable positions. Persist a new `account_snapshots` row and current `portfolio_exposure` rows in Supabase before calculating any position size. Reject sizing if the live refresh fails or is older than the policy limit.
3. Fetch readable linked articles with `bun run articles:fetch`. If network/article fetch fails, continue with available bookmark text.
4. Read `bun run thesis:report` and query the canonical Supabase database as needed.
5. Use Robinhood MCP to refresh cross-account exposure, quotes, fundamentals, earnings, financials, and options data where useful.
6. Validate every candidate symbol through Robinhood search/quotes before treating it as a ticker. Reject uppercase words that do not resolve.
7. Run bull-case, bear-case, and portfolio-risk reviews for candidate trades when practical.
8. Prefer swing setups: days to weeks, identifiable catalyst, momentum or dislocation, clear invalidation. Avoid adding to names already heavily owned in other Robinhood accounts unless there is a specific short-term catalyst.
8. Persist new observations into Supabase Postgres: portfolio exposure, catalysts, softened/hardened thesis scores, and trade proposals.
9. Autonomous placement is authorized without per-trade user approval, but only while the US regular market session is open. Derive every notional cap from the fresh Robinhood total portfolio value, then cap it by live buying power. For a proposal that passes every thesis, portfolio, quote, spread, gap, and buying-power gate, call Robinhood `review_equity_order` immediately before `place_equity_order`. Never queue an after-hours order. If the broker tool itself requires an unavoidable confirmation, surface that broker requirement rather than weakening or bypassing it.
10. Apply the configured standing-cash target and tactical-sleeve percentages generically. Never encode ticker allocations or ticker-specific sizing exceptions in policy. Cash may remain only transiently while the market is closed or when no candidate passes every gate; re-screen it at the next regular session rather than forcing a low-quality trade.
11. Finish the durable recap with `bun run run:report -- finish scheduled_research`. Supply a headline and short summary, plus repeatable `--insight`, `--learning`, and `--action` entries. State explicitly when the run produced no new thesis, no new evidence, or no executable action. Then run `bun run dashboard:publish` so the recap appears in the RUNS page.

Output:
- New or changed theses
- Hardened theses
- Softened/invalidation notes
- Candidate swing trades with suggested percentage, computed notional from fresh equity, catalyst, invalidation, and existing portfolio overlap
- No-trade list with reasons
- Orders placed, rejected, or deferred, with the exact gate result for each
- Tactical sleeve deployment status and the next-session re-screen plan for any transient cash
- A plain-language run recap separating genuinely new ideas from confirmations, risk findings, and queued actions
