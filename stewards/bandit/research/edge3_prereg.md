# BANDIT edge #3 — pre-registration: `meme_range_breakout`

thesis_id: `meme_range_breakout`
Written 2026-10-16 09:15 PT BEFORE any result of this rule was computed (no backtest run, no forward returns looked at). Research only; no trades, no live edits. Status: **paper only**.

## Rule (one, mechanical) — tight 6h range, volume breakout
Evaluated on each closed 5m bar t of a pool's USD OHLCV (bars `[ts, open, high, low, close, volume_usd]`):
1. **Range:** over the 72 bars (6h) **before** t (bars t-72 … t-1), let H = max high and L = min low. Require L > 0 and H/L - 1 <= 25%.
2. **Breakout:** close_t > H (the bar *closes* above the prior 6h high; a wick through H is not enough).
3. **Green bar:** close_t > open_t.
4. **Volume:** volume_t >= 3.0 × M, where M = median 5m USD volume of bars t-72 … t-1, and M > 0.
5. **Activity:** sum of USD volume over bars t-72 … t-1 >= $50,000 (same floor as edge2).
6. Enter at **open of bar t+1**. One open position per coin for this rule at a time; a new signal only after the prior trade exits.

Needs at least 73 closed bars (t plus the 72 before it). Bars missing from GeckoTerminal are not filled in; a window with fewer than 72 prior bars is skipped.

No overlap with `meme_pullback_reclaim` (edge2): edge2 needs close_t 20–40% below the trailing 6h max close; this rule needs close_t above every high of the prior 6h, so close_t is the 6h max close. A bar cannot trigger both.

Why (market structure, not past clips): a meme coin that has gone sideways for 6h in a narrow band has worked through its early-holder distribution. A close above that range on a volume spike (3x the typical bar) shows new demand big enough to take out every resting seller in the range. The tight range keeps entry near a defined base instead of chasing an extended move, which leaves room toward the +50% TP before a -40% kill.

## Data source
- **Signal bars:** GeckoTerminal `networks/solana/pools/{pool}/ohlcv/minute?aggregate=5&currency=usd&token={mint}` over HTTPS, closed bars only (bar start + 300 s <= now), on the mint's top-reserve pool (max `reserve_in_usd` from `networks/solana/tokens/{mint}/pools`). Same source and pool choice as the scan's edge2 check.
- **Universe (forward paper):** the scan's eligible universe in `stewards/bandit/scan_https_once.py` (`elig`: not in LEDGER / SKIP / BAN_SYM), with the live floors liquidity >= $100k and age < 14d, exactly as the edge2 loop applies them. The scan's momentum market gates (1h/6h change, 1h cap, etc.) are **not** applied; this rule replaces them.
- **Backtest dataset:** same as edge2: all `raw/ohlcv5_*_usd.json` files (GeckoTerminal 5m, USD) in the research box mirror; one pool per coin (the file with the most bars, ties alphabetical); exclude pools with median close > $1. Full available date range of each pool. Liquidity and age floors cannot be applied historically (no liquidity history in the raw files); noted as a caveat.

## Exits (house exits)
- **TP:** if high >= entry × 1.50, sell **all** at entry × 1.50.
- **Kill:** if low <= entry × 0.60, sell all at entry × 0.60. If TP and kill touch in the same bar, the **kill counts** (conservative).
- **Time stop:** otherwise sell at the close of the 48th bar after entry (4h; the entry bar is bar 1). If data ends earlier, close at the last bar (flagged).
- Entry bar counts: its high/low can trigger TP/kill.

## Costs
Subtract 2.0 percentage points per trade from gross return (1% round-trip fees/slippage + 1% assumed Jupiter price impact). Fixed assumption; no per-trade impact data exists in raw OHLCV. SOL P&L = net return × 0.45 SOL stake (as edge2).

## Dedupe
At most one signal per coin per 4h (and never while that coin has an open trade under this rule). In the backtest, after a signal on bar t the next eligible signal for that coin is the first qualifying bar at or after both the prior trade's exit and t + 48 bars. Forward, the scan keeps a per-rule state file (mint -> last logged ts) like `_edge2_dedupe.json`.

## Test split
Sort all backtest trades by entry time; older half = first floor(n/2) trades, newer half = the rest.

## Backtest bar (all must hold; otherwise the rule is retired and not paper-logged)
1. Total trades >= 20 and each half >= 10 (otherwise FAIL: insufficient sample).
2. Newer-half net mean return after costs > 0, and newer-half total net SOL > 0.
3. Overall net SOL after costs > 0.
No parameter changes after results. If it fails, it fails.

## Promotion bar (LOCKED, GRASSHOPPER-agreed in BIDNESS 2026-10-16)
Paper only until this holds, **even if sizing guidance says entry_allowed**.
- A paper pass = a closed paper trade of this rule, scored on the exit path above (5m bars, +50% / -40% kill-first / 4h, 2.0 pp cost), not the ledger's plain 4h mark.
- Evaluated only once n >= 20 forward paper passes, on all closed scored passes to date.
- Let r_i = net return per trade after the 2% cost, mean = average(r_i), SE = sample standard deviation of r_i (n - 1 denominator) / sqrt(n).
- Promote only if **both**: (a) mean - SE > 0, and (b) the mean of r_i with the 2 largest winners removed (n - 2 trades) > 0.
- Then go live at guidance size. Otherwise stay paper only.
- Backtest results do not count toward the 20; only forward paper passes do.
No changes to this bar after paper results start.

## Known caveats
- Coin-universe bias: backtest coins are ones our momentum scanner surfaced; not a random sample of Solana memes.
- No liquidity/age history in the backtest; the forward universe has floors the backtest cannot replicate.
- A green close above the high on 3x volume can be a single large buy into thin liquidity; the 2 pp cost may understate impact on these bars.
- Returns in USD terms; SOL drift ignored.
- Forward evaluation is checked repeatedly as n grows past 20 (optional stopping); the mean - SE and top-2-removed conditions are the guard; no further correction.
- GeckoTerminal 5m bars can lag or omit low-activity bars; skipped windows are not filled in.
