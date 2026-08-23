# ThesisForge Scheduled Run Prompt

Run this workflow in `/Users/davidwallach/code/robinhood_trader`.

Use only X bookmark data, linked article text when fetchable, and the Robinhood MCP. Do not use external market-data providers.

Steps:
0. Read `config/trade_policy.json` and obey its sizing, asset-class, and approval rules.
1. Refresh X bookmarks with `npm run x:bookmarks`.
2. Confirm `THESISFORGE_DATABASE_URL` is configured, then update persistent Supabase thesis memory with `npm run thesis:ingest`.
3. Fetch readable linked articles with `npm run articles:fetch`. If network/article fetch fails, continue with available bookmark text.
4. Read `npm run thesis:report` and query the canonical Supabase database as needed.
5. Use Robinhood MCP to refresh the Agentic account, cross-account exposure, quotes, fundamentals, earnings, financials, and options data where useful.
6. Validate every candidate symbol through Robinhood search/quotes before treating it as a ticker. Reject uppercase words that do not resolve.
7. Run bull-case, bear-case, and portfolio-risk reviews for candidate trades when practical.
8. Prefer swing setups: days to weeks, identifiable catalyst, momentum or dislocation, clear invalidation. Avoid adding to names already heavily owned in other Robinhood accounts unless there is a specific short-term catalyst.
8. Persist new observations into Supabase Postgres: portfolio exposure, catalysts, softened/hardened thesis scores, and trade proposals.
9. Do not place trades automatically. For high-confidence equity candidates, use Robinhood `review_equity_order` when appropriate, then report trade-ready proposals and broker alerts for user approval. Only call `place_equity_order` in an interactive run after explicit user confirmation.

Output:
- New or changed theses
- Hardened theses
- Softened/invalidation notes
- Candidate swing trades with suggested notional, catalyst, invalidation, and existing portfolio overlap
- No-trade list with reasons
