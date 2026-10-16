# BANDIT edge #5 — pre-registration: `meme_liq_accum`

thesis_id: `meme_liq_accum`
Written 2026-10-16 09:15 PT BEFORE any result of this rule was computed (no backtest run, no forward returns looked at). Research only; no trades, no live edits. Status: **paper only, FORWARD-PAPER-ONLY (no backtest)**.

## Why forward-only
The signal needs a 6h liquidity series per coin. None of our sources provides one historically: GeckoTerminal OHLCV has price and volume only (pool `reserve_in_usd` is a current snapshot), DexScreener and the Jupiter tokens API give current liquidity only, and the edge2 raw files are OHLCV only. The box has a few one-off scan outputs, not a continuous series. So this rule **cannot be backtested** and is tested only on forward paper passes. The scan must start recording liquidity snapshots before the first signal can fire. There is no backtest bar and no older/newer backtest split; the split below applies to forward passes as a diagnostic.

## Rule (one, mechanical) — liquidity accumulation in a flat price
Evaluated once per scan run s (hourly) on each coin in the universe, using the scan's own snapshot history:
1. **Snapshot:** each scan stores, for every coin in `elig`, (scan ts, Jupiter `liquidity` USD, Jupiter `usdPrice`). Stored per mint, kept >= 8h.
2. **Reference:** the snapshot of the same mint taken between 5h and 7h before scan s (closest to 6h; ties: the older). No reference -> no signal (no interpolation).
3. **Liquidity up:** liq_s / liq_ref - 1 >= +50%, with liq_ref >= $50,000 (avoids tiny-base jumps).
4. **Price flat:** |usdPrice_s / usdPrice_ref - 1| <= 10% (same window as the liquidity change).
5. **Buy share:** max(1h buy share by volume, 1h buy share by tx count) >= 0.52, the scan's existing buy-share gate, computed exactly as in `scan_https_once.py` from Jupiter `stats1h`.
6. **Not a migration jump:** coin age (scan `age_h`) >= 12h, and no new pool for the mint with `pool_created_at` inside the 6h window per GeckoTerminal token pools (a newly created/migrated pool adds liquidity without accumulation). If the pools call fails, the coin is skipped (`pools_err`), not assumed clean.
7. **Precedence vs edge2:** if the coin triggers `meme_pullback_reclaim` in the same scan, it is attributed to edge2, not this rule.
8. **Entry: on the next scan.** Signal at scan s; paper entry time = start of scan s+1 (the next scheduled scan run). Entry price = open of the first GeckoTerminal 5m USD bar (top-reserve pool) starting at or after that time. The Jupiter quote at s+1 is recorded for impact reference only. If scan s+1 does not run within 2h of s, the signal is void (logged `no_next_scan`).
One position per coin.

Why (market structure, not past clips): liquidity rising +50% while price is flat means LPs or a team are adding depth (or buyers are filling the pool's quote side) without price moving; combined with more buying than selling, it suggests supply is being absorbed quietly before a move. Unlike edge2 (after a big run), edge3 (range breakout) and edge4 (fresh graduate), this signal is about depth, not price action.

## Data source
- **Signal:** Jupiter tokens v2 rows already fetched by the scan (`liquidity`, `usdPrice`, `stats1h`), HTTPS, plus GeckoTerminal token pools for point 6. Snapshots written by the scan to a box state file (e.g. `/workspace/bandit/_liq_snapshots.json`).
- **Exit path:** GeckoTerminal 5m USD bars of the top-reserve pool (same as the edge2 path scorer).
- **Universe:** the scan's eligible universe in `scan_https_once.py` (`elig`, liquidity >= $100k, age < 14d), as the edge2 loop applies it. Momentum market gates (1h/6h change etc.) not applied; the buy-share gate is applied as point 5.

## Exits (house exits)
- **TP:** if high >= entry × 1.50, sell **all** at entry × 1.50.
- **Kill:** if low <= entry × 0.60, sell all at entry × 0.60. If TP and kill touch in the same bar, the **kill counts**.
- **Time stop:** otherwise sell at the close of the 48th bar after entry (4h; entry bar = bar 1). If data ends earlier, close at the last bar (flagged).

## Costs
Subtract 2.0 percentage points per trade from gross return (1% round-trip fees/slippage + 1% assumed impact). SOL P&L = net return × 0.45 SOL stake.

## Dedupe
At most one signal per coin per 4h, and never while that coin has an open paper trade under this rule. Per-rule state file (mint -> last logged ts).

## Test split (forward diagnostic only)
At promotion time, sort forward passes by entry time; older half = first floor(n/2), newer half = the rest. Report each half's net mean. This is informational and does not change the promotion bar.

## Backtest bar
None: not backtestable (see "Why forward-only").

## Promotion bar (LOCKED, GRASSHOPPER-agreed in BIDNESS 2026-10-16)
Paper only until this holds, **even if sizing guidance says entry_allowed**.
- A paper pass = a closed paper trade of this rule, scored on the exit path above (5m bars, +50% / -40% kill-first / 4h, 2.0 pp cost), not the ledger's plain 4h mark.
- Evaluated only once n >= 20 forward paper passes, on all closed scored passes to date.
- r_i = net return per trade after the 2% cost; mean = average(r_i); SE = sample standard deviation of r_i (n - 1) / sqrt(n).
- Promote only if **both**: (a) mean - SE > 0, and (b) the mean with the 2 largest winners removed (n - 2 trades) > 0.
- Then go live at guidance size. Otherwise stay paper only.
No changes to this bar after paper results start.

## Known caveats
- No backtest at all: the first evidence is the forward paper log, so this rule takes longest to reach 20 passes and has no out-of-sample check other than the forward log itself.
- Signals cannot fire until the scan has ~6h of snapshots; scan gaps (missed hourly runs) remove reference points.
- Jupiter `liquidity` aggregates across pools and can jump when a pool is added or re-indexed; point 6 catches new pools but not re-indexing.
- LP adds by the team can precede a pull (rug); the -40% kill is the only protection.
- Entry is up to ~1h after the signal (next scan), so part of any move may be missed; this is the locked design, not a bug.
- Returns in USD terms; SOL drift ignored. Repeated forward evaluation past n = 20 (optional stopping); guarded only by the two conditions.
