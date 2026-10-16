# BANDIT edge #4 — pre-registration: `meme_grad_pullback`

thesis_id: `meme_grad_pullback`
Written 2026-10-16 09:15 PT BEFORE any result of this rule was computed (no backtest run, no forward returns looked at). Research only; no trades, no live edits. Status: **paper only**.

## Graduation detection (data the scan can get over HTTPS)
A coin counts as a pump.fun graduate when **all** hold:
1. GeckoTerminal `networks/solana/tokens/{mint}/pools` lists at least one pool whose `relationships.dex.data.id` is `pumpswap` (pump.fun's AMM; graduated coins migrate there). The bonding-curve pool appears as dex id `pump-fun` and is never used for signals.
2. Graduation time **G** = the earliest `attributes.pool_created_at` among that mint's `pumpswap` pools (the migration pool; later copycat pumpswap pools are created after it).
3. Forward only, as a consistency check: the Jupiter token row in the scan has `launchpad` == `pump.fun` (and `graduated` true when present). If Jupiter disagrees with GeckoTerminal the coin is skipped (logged as `grad_mismatch`), not guessed. The backtest uses step 1–2 only (GeckoTerminal pool metadata is static and fetchable now).
Coins graduated to other AMMs (raydium, meteora, launchlab) are out of scope for this rule.

## Rule (one, mechanical) — first post-graduation pullback reclaim
On the **migration pool's** (pumpswap pool at G) closed 5m USD bars, using only bars starting at or after G. Evaluate each closed bar t with:
1. **Fresh:** start of bar t is < 24h after G (t_ts - G < 86,400 s), and at least 12 bars (1h) of post-G data exist before t.
2. **Post-graduation high:** P = max close over post-G bars up to and including t-1, at bar p; require p <= t-3 (peak at least 15 min old).
3. **Pullback:** 0.65 × P <= close_t <= 0.80 × P (close 20–35% below the post-graduation high).
4. **Reclaim trigger:** close_t > high_{t-1} and close_t > open_t (green bar closing above the prior bar's high).
5. **Activity:** sum of USD volume over post-G bars up to t-1 >= $50,000.
6. **First pullback only:** this is the first bar since G that satisfies 2–5. At most **one** signal per coin per graduation, ever; if it is dropped (precedence below, dedupe, data gap), there is no second chance.
7. **Precedence vs edge2:** if bar t also triggers `meme_pullback_reclaim` (edge2) on the same pool, it is attributed to edge2 and is not a `meme_grad_pullback` signal (it still uses up the "first pullback").
8. Enter at **open of bar t+1**. One position per coin.

Why (market structure, not past clips): graduation moves a pump.fun coin onto a real AMM with deeper liquidity and puts it in front of a new set of buyers (aggregators, screeners, bots that ignore bonding curves). The usual pattern is a post-migration pop, then bonding-curve holders take profit. The first 20–35% shakeout after that pop, followed by a reclaim bar, is the earliest point where that supply has been absorbed; capping at 35% avoids coins that are dumping back toward their curve price.

Differences from edge2: edge2 needs a +40% run inside a 6h window and accepts 20–40% pullbacks on any coin; this rule needs a pumpswap graduation in the last 24h, uses the post-graduation high (any run size), a tighter 20–35% band, a green-bar requirement, and only the first trigger per graduation. Same-bar overlap goes to edge2 (point 7).

## Data source
- **Graduation:** GeckoTerminal token pools endpoint (dex id + `pool_created_at`), HTTPS.
- **Signal bars:** GeckoTerminal `networks/solana/pools/{pumpswap_pool}/ohlcv/minute?aggregate=5&currency=usd&token={mint}`, closed bars only. Note this is the **migration pool**, not necessarily the top-reserve pool. Needs up to 288 bars (24h) of history, so `limit` must be >= 300 (the scan's edge2 call uses 100).
- **Universe (forward paper):** the scan's eligible universe in `scan_https_once.py` (`elig`, liquidity >= $100k, age < 14d), as the edge2 loop applies it. Momentum market gates not applied.
- **Backtest dataset:** the coins (mints) in the edge2 dataset (`raw/ohlcv5_*_usd.json`, median close <= $1). For each, find G from GeckoTerminal pool metadata; fetch the migration pool's 5m USD bars covering [G, G + 28h] (24h signal window + 4h hold) via `before_timestamp` paging. Coins with no pumpswap pool, or whose bars for that window cannot be fetched, are excluded and listed with the reason. No bars are filled in.

## Exits (house exits)
- **TP:** if high >= entry × 1.50, sell **all** at entry × 1.50.
- **Kill:** if low <= entry × 0.60, sell all at entry × 0.60. If TP and kill touch in the same bar, the **kill counts**.
- **Time stop:** otherwise sell at the close of the 48th bar after entry (4h; entry bar = bar 1). If data ends earlier, close at the last bar (flagged).

## Costs
Subtract 2.0 percentage points per trade from gross return (1% round-trip fees/slippage + 1% assumed impact). SOL P&L = net return × 0.45 SOL stake.

## Dedupe
One signal per coin per 4h (house dedupe), and in practice stricter: one signal per coin per graduation (point 6). Forward, the scan keeps a per-rule state file (mint -> {G, logged_ts or consumed}).

## Test split
Sort all backtest trades by entry time; older half = first floor(n/2), newer half = the rest.

## Backtest bar (all must hold; otherwise the rule is retired and not paper-logged)
1. Total trades >= 20 and each half >= 10 (otherwise FAIL: insufficient sample).
2. Newer-half net mean return after costs > 0, and newer-half total net SOL > 0.
3. Overall net SOL after costs > 0.
No parameter changes after results. If it fails, it fails.
If the backtest sample is too small only because graduation windows are missing from the data (not because the rule rarely fires), report it as INSUFFICIENT DATA and let the desk decide whether to run forward paper only; the forward promotion bar below is unchanged either way.

## Promotion bar (LOCKED, GRASSHOPPER-agreed in BIDNESS 2026-10-16)
Paper only until this holds, **even if sizing guidance says entry_allowed**.
- A paper pass = a closed paper trade of this rule, scored on the exit path above (5m bars, +50% / -40% kill-first / 4h, 2.0 pp cost), not the ledger's plain 4h mark.
- Evaluated only once n >= 20 forward paper passes, on all closed scored passes to date.
- r_i = net return per trade after the 2% cost; mean = average(r_i); SE = sample standard deviation of r_i (n - 1) / sqrt(n).
- Promote only if **both**: (a) mean - SE > 0, and (b) the mean with the 2 largest winners removed (n - 2 trades) > 0.
- Then go live at guidance size. Otherwise stay paper only.
- Backtest trades do not count toward the 20.
No changes to this bar after paper results start.

## Known caveats
- Universe bias: backtest coins were surfaced by our momentum scanner, and only those that later reached our dataset; survivors of graduation are over-represented.
- The live $100k liquidity floor and Jupiter's age field (first pool, i.e. curve creation) cannot be replicated in the backtest.
- Early post-migration bars are thin and volatile; the 2 pp cost likely understates impact in the first hours.
- GeckoTerminal history depth for the first 24h after graduation may be incomplete for older coins; missing windows are excluded, not filled.
- Assumes pump.fun migrates to `pumpswap`; if pump.fun changes its migration venue, detection must be revised in a new prereg (not edited here).
- Returns in USD terms; SOL drift ignored. Repeated forward evaluation past n = 20 (optional stopping); guarded only by the two conditions.
