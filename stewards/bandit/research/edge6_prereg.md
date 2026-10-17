# BANDIT edge #6 — pre-registration: `meme_flush_rebound`

thesis_id: `meme_flush_rebound`
Written 2026-10-17 06:20 PT, AFTER an in-sample exploration (below) and BEFORE any out-of-sample result of this rule was computed (no OOS data fetched or run). Research only; no trades, no live edits. Status: **paper only**.

## Where it came from (exploratory, IN-SAMPLE — not evidence of an edge)
Source: every scored BANDIT meme pass in the ledger (`decision_candidates`, steward bandit, decision skip, counterfactual_pnl set), all `blocked_by` kinds, 99 rows 2026-10-06 … 10-17, deduped one per coin per 4h → 85 passes, 29 coins; 80 had GeckoTerminal 5m bars around the decision. Ledger meta carries only 1h/6h change, liquidity and impact (parsed from `reason`), so bar features were added from GeckoTerminal.
- The passes mostly fell: house-exit net mean -4.0%, median -7.6%, 24/80 winners.
- Logged features (1h, 6h, liquidity, impact; terciles) show no clean separation (all medians negative). With ~11 features × 3 bins looked at, any single cell is likely noise.
- Bar feature `close / 6h high` was the one consistent shape: passes taken within 5% of the 6h high lost hardest (n=29, 3 winners, mean about -12%), the "late chase" the 1h_cap_30 trial also points at.
- A long-only reversal reading of "the coins we passed on mostly fell": replaying simple bar conditions over **all** bars of the same 29 coins (not just pass times), buying a coin that has already **flushed 30–50% below its 6h high** while still trading was the only region positive in both time halves. Exact rule below, in-sample: **n=272 trades, 26 coins, net mean +4.81%, SE 1.71, mean ex top 2 +4.49%, median +0.84%, 52% winners; older half +5.25%, newer half +4.36%** (2026-10-02 … 10-17). The 30–50% band was chosen from this exploration (about 16 band/filter cells were tried), so these numbers are biased upward; trades within a coin are correlated. Only the OOS check below and forward paper count.
- Rejected in exploration: shallow cool-off (5–16% below the 6h high; positive at pass times, about -0.7% over all bars), first-hour flush after a pass (keeps falling), green/reclaim confirmation (weaker in the newer half).
Code: `edge6_explore.py`; in-sample coin list: `edge6_insample_mints.txt` (excluded from OOS).

## Rule (one, mechanical) — buy the 30–50% flush
Evaluated on each closed 5m bar t of a pool's USD OHLCV (bars `[ts, open, high, low, close, volume_usd]`), t >= 72:
1. **6h high:** H = max high of the 72 bars t-71 … t (6h, including bar t).
2. **Flush:** 0.50 <= close_t / H <= 0.70 (the close is 30–50% below the 6h high).
3. **Still trading:** sum of USD volume over bars t-71 … t >= $50,000 (house floor).
4. **Precedence:** if bar t is an edge2 `meme_pullback_reclaim` bar, it belongs to edge2, not this rule. Also, in the scan, a coin that triggered edge2, edge3, edge4 or edge5 in the same scan run is attributed to that rule (edge2 > edge3 > edge4 > edge5 > edge6). edge3 (close above the 6h high) cannot overlap by construction.
5. **Entry:** open of bar t+1. One open position per coin for this rule at a time.
No 1h/6h momentum gates, no reclaim/green requirement. Code: `edge6_rule.py` (`signal`, `exit_path`, `trades`); the scan uses the same `signal` logic.

Why (market structure): thin meme books overshoot on forced selling (sniper/dev dumps, stop cascades, panic after a failed run). A 30–50% drop inside 6h on a coin that still trades >= $50k is often a liquidity-driven overshoot that partly snaps back within hours; the +50% TP is reachable from a flushed price and the -40% kill caps the rug tail. Deeper than 50% is excluded (rug zone). It is long-only spot: the wallet has no short venue, so "these coins fall" is used as an entry after the fall rather than as a short.

## Data source
- **Signal bars (forward):** GeckoTerminal `networks/solana/pools/{pool}/ohlcv/minute?aggregate=5&currency=usd&token={mint}`, HTTPS, closed bars only, top-reserve pool (the bars the scan's edge2 check already fetches, `GT_BARS`). Bars that closed since the previous scan run are checked; the first qualifying bar is used.
- **Universe (forward):** the scan's `universe345` (eligible, liquidity >= $100k, age < 14d), as for edge3/4/5. Momentum market gates not applied.
- **Exit path / scoring:** GeckoTerminal 5m USD bars of the same pool, entry ts = signal bar ts + 300 (`meta.edge6.prereg_entry_ts`), scored by `paper_path_score.py`.

## Exits (house exits)
- **TP:** if high >= entry × 1.50, sell **all** at entry × 1.50.
- **Kill:** if low <= entry × 0.60, sell all at entry × 0.60. If TP and kill touch in the same bar, the **kill counts**.
- **Time stop:** otherwise sell at the close of the 48th bar after entry (4h; entry bar = bar 1). If data ends earlier, close at the last bar (flagged; excluded from the OOS stats).

## Costs
Subtract 2.0 percentage points per trade from gross return. SOL P&L = net return × 0.45 SOL stake.

## Dedupe
At most one signal per coin per 4h, and never while that coin has an open trade under this rule. Backtest: the next signal for a coin is the first qualifying bar at or after both the prior exit and t + 48 bars. Forward: per-rule state file `_edge6_dedupe.json` (mint -> last logged signal bar ts).

## Out-of-sample check (rule fixed above before any OOS data is fetched or run)
Two datasets, neither used in the exploration; pooled for the gate, each also reported:
- **A — edge2 dataset (older period):** all `raw/ohlcv5_*_usd.json` in the research box mirror (as of this prereg), one pool per coin (most bars, ties alphabetical), median close <= $1, minus any coin whose mint is in `edge6_insample_mints.txt`. About 2026-09-18 … 10-07.
- **B — fresh coins (disjoint coins, recent period):** at fetch time, GeckoTerminal `networks/solana/pools?sort=h24_volume_usd_desc` pages 1–10; keep pools with `pool_created_at` within 14 days of fetch and `reserve_in_usd` >= $100k; the token = the non-SOL side (base); drop SOL/USDC/USDT, any mint in `edge6_insample_mints.txt` or dataset A; one pool per mint (highest reserve); first 40 mints by 24h volume. For each, up to 2,000 5m USD bars (2 pages, `before_timestamp` paging, `token=<mint>`). Caveat: selected on current volume and liquidity (survivorship bias in favour of coins that did not die).
Code: `edge6_oos_fetch.py`, `edge6_oos_run.py`; this file's sha256 is checked by the run script (abort on mismatch).

### OOS gate (all must hold)
1. Pooled OOS trades >= 20 and each time half >= 10 (sort by entry time; older half = first floor(n/2)); otherwise **INSUFFICIENT SAMPLE** → ask GRASSHOPPER for forward-paper-only (as the edge3/edge4 amendment).
2. Pooled net mean > 0 and newer-half net mean > 0.
3. Pooled mean ex top 2 > 0.
If 2 or 3 fails, the rule is retired and not paper-logged. No parameter changes after results.

## Promotion bar (house bar, as edge3/4/5)
Paper only until this holds, **even if sizing guidance says entry_allowed**.
- A paper pass = a closed paper trade of this rule, scored on the exit path above, not the ledger's plain 4h mark.
- Evaluated only once n >= 20 forward paper passes (deduped), on all closed scored passes to date.
- r_i = net return after the 2% cost; mean = average(r_i); SE = sample sd (n-1) / sqrt(n).
- Promote only if **both**: (a) mean - SE > 0, and (b) mean with the 2 largest winners removed > 0.
- Backtest/OOS trades do not count toward the 20.
No changes to this bar after paper results start.

## Kill rule (forward)
- Retire (stop paper-logging) at any score run with n >= 10 forward passes where mean + SE < 0 (clearly negative).
- Retire if the promotion bar is still not met at n = 40 forward passes.

## Known caveats
- The band (30–50%) was picked in-sample; the OOS check is the guard, and set B shares the calendar period with the in-sample data (different coins).
- Falling-knife risk: a flush can be the start of a rug; the -40% kill is the only protection, and 5m fills at the kill level are optimistic.
- The scan runs hourly and logs after the bar closes; entry is scored at the prereg entry bar (t+1) even though the log happens later (up to ~1h), as for edge3.
- No liquidity/age history in the backtest; the forward universe has floors the backtest cannot apply.
- Returns in USD terms; SOL drift ignored. Repeated forward evaluation past n = 20 (optional stopping).
