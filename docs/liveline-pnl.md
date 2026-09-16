# Liveline ← ledger time series

The public desk draws [Liveline](https://benji.org/liveline) from `/api/desk`. The Worker live-reads the ledger as `desk_public_reader`. A failed live read is an error, not a cached copy. The line interpolates at 60fps between **real marks**. It does not invent a price, a P/L, or a SOL→USD print.

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

`%` in Board standings is `((value - start) / start) * 100` against **that book’s own start**. Missing or non-positive start → not ranked, not `0%`. Board hero plots every live steward’s % curve on that same axis (QUANTANAMO, ODDSBORNE, BANDIT — COINTANAMO only if a book curve is wired; it is not today). No FX and no summed USD+SOL NAV. The shared view is the overlay itself, not an equal-weight composite line. `showValue` is off when two or more books plot, so the big number cannot be read as desk-wide dollars. Idle (`paused`) when **every** plotted book’s marks are stale so the spline does not fake a walk. Phone swipe / pull-to-refresh stay first: the hero frame is `pointer-events: none` and Liveline scrub is off. There is no per-book native-unit mode switch on Board — that would fight the swipe rail. Native-unit equity stays on Book.

Assembler: `apps/dashboard/lib/desk-liveline.ts` (`assembleLiveline`, `boardHeroLiveline`, `lerpMark`, `livelineIdle`).

## Fill clocks

Fill rows (`fill_log.at`, `pm_fills.executed_at`, `meme_fills.executed_at`) do **not** become marks. A fill may add a vertex at its timestamp whose value is the last ledger equity/cash at or before that time (LOCF). Fill price and notional are ignored.

## Windows

Liveline’s default window is 30 seconds — useless for a snapshot desk. Board hero uses the full `now − firstPoint` span with no window chips. Compact Book OPEN sparks do the same. An empty book uses Liveline’s empty state (`not in ledger`). The public boot screen uses Liveline `loading` until `/api/desk` returns.

## What is not a series

- No SOL→USD ranking line
- No Book ALL overlay of QUANTANAMO NAV on ODDSBORNE equity (different scale) or on BANDIT SOL
- No Rive fill-tape as the delight
- No fabricated ticks between ledger observations — the spline is chrome

Assembler history caps (`loadDeskFromPostgres` / REST) keep 200 Agentic snapshots and 200 `pm_pnl` / `meme_pnl` rows so the line can breathe from real history.

## Book OPEN strip

Open tickets only (mark path vs entry). Closed-lot CRT stays the mast. Assembler: `apps/dashboard/lib/book-open-strip.ts`.

```text
pm_positions.mark @ mark_at
pm_markets.last_yes|last_no @ last_marked_at
pm_fills.price @ executed_at
        └─► Liveline
pm_positions.average_cost  └─► referenceLine

meme_positions.mark_sol @ mark_at
meme_tokens.last_price_sol @ last_marked_at
meme_fills.price_sol @ executed_at
        └─► Liveline
meme_positions.average_cost_sol └─► referenceLine

portfolio_exposure.last_price (two+ clocks already in snapshot)
        └─► Liveline
book.names.average_cost    └─► referenceLine
```

No CLOB fetch. No invented ticks. `kill_mid` overlay only if that number is already on the row. Two clocks to draw; a lone mark is a label.
