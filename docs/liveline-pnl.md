# Liveline ← ledger time series

The public desk draws [Liveline](https://benji.org/liveline) from the published snapshot only. The line interpolates at 60fps between **real marks**. It does not invent a price, a P/L, or a SOL→USD print.

`time` is unix **seconds** (Liveline’s clock). `value` is the ledger number in that book’s native unit.

## Point map

| Steward | Curve | Source field | Unit |
|---|---|---|---|
| QUANTANAMO | equity | Agentic `account_snapshots.total_value` | USD |
| QUANTANAMO | cash | Agentic `account_snapshots.cash` | USD |
| ODDSBORNE | equity | `pm_pnl.equity` (skip null) | USD |
| ODDSBORNE | cash | `pm_pnl.cash` (skip null) | USD |
| BANDIT | equity | `meme_pnl.equity_sol` (skip null) | SOL |
| BANDIT | cash | `meme_pnl.cash_sol` (skip null) | SOL |

Personal Robinhood books never enter the QUANTANAMO series (`agentic` label only). Duplicate timestamps keep the later row. Oldest first.

`%` on Board ALL is `((value - start) / start) * 100` against **that book’s own start**. Missing or non-positive start → no % series, not `0%`. That is why ALL can share one axis without FX.

Assembler: `apps/dashboard/lib/desk-liveline.ts` (`assembleLiveline`).

## Fill clocks

Fill rows (`fill_log.at`, `pm_fills.executed_at`, `meme_fills.executed_at`) do **not** become marks. A fill may add a vertex at its timestamp whose value is the last ledger equity/cash at or before that time (LOCF). Fill price and notional are ignored.

## Windows

Liveline’s default window is 30 seconds — useless for a snapshot desk. We set `window` to `now − firstPoint` and expose `1d` / `7d` / `30d` / `all` when the span is long enough. An empty book uses Liveline’s empty state (`not in ledger`). The public boot screen uses Liveline `loading` until `/api/desk` returns.

## What is not a series

- No SOL→USD ranking line
- No Book ALL overlay of QUANTANAMO NAV on ODDSBORNE equity (different scale) or on BANDIT SOL
- No Rive fill-tape as the delight
- No fabricated ticks between ledger observations — the spline is chrome

Publisher history caps (`loadDeskFromPostgres` / REST) keep 200 Agentic snapshots and 200 `pm_pnl` / `meme_pnl` rows so the line can breathe from real history.
