# BANDIT edge #2 — pre-registration: `meme_pullback_reclaim`

Written 2026-10-12 PT BEFORE any result of this rule was computed. Research only; no trades, no live edits.

## Rule (one, mechanical) — pullback-after-run reclaim
Evaluated on each closed 5m bar t of a pool's USD OHLCV:
1. **Run:** in the trailing 72 bars (6h) ending at t, let P = max close, at bar p. Let L = min close in the window before p. Require P/L - 1 >= +40%.
2. **Pullback:** close_t between 20% and 40% below P (0.60*P <= close_t <= 0.80*P), and p at least 6 bars (30 min) before t.
3. **Reclaim trigger:** close_t > high_{t-1} (a green bar closing above the prior bar's high).
4. **Activity:** sum of USD volume over the trailing 72 bars >= $50,000.
5. Enter at **open of bar t+1**. One position per pool at a time; a new signal only after the prior trade exits.

Why (market structure, not past clips): chasing a 6h move buys from late momentum traders at the point of maximum early-holder supply. After a run, the first shakeout (20–40% retrace) flushes weak hands and early profit-takers; a reclaim bar shows dip buyers absorbing that supply. Entry is cheaper relative to the prior peak, giving room toward the +50% TP, while the 40% cap avoids coins that have fully round-tripped (rug/dead).

## Exits (unchanged from the clip thesis)
- TP: if high >= entry*1.50, sell half at entry*1.50; remainder rides.
- Kill: if low <= entry*0.60, sell all remaining at entry*0.60. If TP and kill touch in the same bar, assume kill first (conservative).
- Time stop: remaining position sold at close of the 48th bar after entry (4h). If data ends earlier, close at the last bar (flagged).

## Costs
Subtract 2.0 percentage points per trade from gross return (1% round-trip fees/slippage + 1% assumed Jupiter price impact, 0.5% per side). No per-trade impact data exists in raw OHLCV, so this is a fixed assumption.

## Dataset
All `raw/ohlcv5_*_usd.json` files (GeckoTerminal 5m, USD). One pool per coin: the file with the most bars (ties: alphabetical). Exclude pools with median close > $1 (SOL/major-quoted pools, e.g. the GROK file). Full available date range of each pool (approx. 2026-09-18 to 2026-10-07). Returns are in USD terms (SOL drift ignored); SOL P&L = return * 0.45 SOL stake.
Known bias: these coins were all ones our momentum scanner surfaced; windows extend well beyond our clips but the coin universe is not random.

## Split
Sort all trades by entry time; older half = first floor(n/2) trades, newer half = rest.

## Pass bar (all must hold)
1. Total trades >= 20 and each half >= 10 (otherwise FAIL: insufficient sample).
2. Newer half net mean return after costs > 0, and newer-half total net SOL > 0 (beats staying flat = 0).
3. Overall net SOL after costs > 0.
No parameter changes after results. If it fails, it fails.

## Addendum 2026-10-12 09:43 PT — locked promotion bar (appended after the original run; original file hash fa97431… in edge2_prereg.sha256)

Status: paper only.
Promotion test: after 20 paper passes (closed paper trades of this rule), compute the mean net return per trade after costs with the 2 largest winners removed (n = 18). If that mean is > 0, the rule goes live at full guidance size. Otherwise it is not promoted.
No changes to this bar after paper results start.
