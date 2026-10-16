# edge4 `meme_grad_pullback` — backtest results

Run 2026-10-16 09:18 PT, once, exactly per `edge4_prereg.md` (sha256 `f88d7e42876ccf6e02ddeb2af2295bb34114aeeff28cd329007803e3d20bde30`, checked by the script before running; it aborts on mismatch). Code: `edge4_fetch.py` (GeckoTerminal over HTTPS, cached in box `research/raw/edge4/`) and `edge4_run.py` (modeled on `edge2_fullexit_run.py`). Trades: `edge4_results.csv`. Summary: `_edge4_summary.json`. No rule or parameter was changed after seeing results.

Dataset: the mints of the edge2 dataset coins (median close <= $1): 11 coins. Graduation = earliest `pumpswap` pool by `pool_created_at`. Bars = that migration pool's 5m USD bars for [G, G+28h].

| Coin | Graduation (pumpswap) | Outcome |
|---|---|---|
| TIGRINO | 2026-09-18 04:06 PT | trade: tp_full, +48.0% net |
| familiars | 2026-09-23 16:22 PT | trade: 4h stop, -11.63% net |
| goon | 2026-09-23 15:34 PT (goon/HIMS pumpswap pool) | trade: tp_full, +48.0% net |
| COLLECT | 2026-09-24 17:58 PT (COLLECT/CARDS pumpswap pool) | trade: tp_full, +48.0% net |
| Agency | 2026-10-01 15:42 PT | first pullback (bar 103, 10-02 00:20 PT) was also an edge2 trigger → given to edge2, uses up the signal |
| JEANPHIL | 2026-09-19 12:06 PT | first pullback (bar 73, 09-19 18:15 PT) was also an edge2 trigger → given to edge2, uses up the signal |
| FEELSGOOD, QUEEF, SHARTCOIN, SI, X7 | none | no pumpswap pool (not pump.fun graduates) → out of scope |

All 6 graduates had complete windows (334–336 bars of the 336 possible). No coin was dropped for missing data.

| Half | Trades | Wins | Mean net % | SE | Mean - SE | Mean ex top 2 | Net SOL (0.45 stake) |
|---|---|---|---|---|---|---|---|
| Older | 2 | 1 | +18.18% | 29.81 | -11.63% | n/a (n-2 = 0) | +0.164 |
| Newer | 2 | 2 | +48.00% | 0.00 | +48.00% | n/a (n-2 = 0) | +0.432 |
| All | 4 | 3 | +33.09% | 14.91 | +18.19% | +18.18% (n=2) | +0.596 |

Exit triggers: 3 full TP, 1 at the 4h stop.

## Backtest gate (verbatim from the prereg)
1. Total trades >= 20 and each half >= 10: **fails** (4 trades; 2 per half).
2. Newer-half mean net > 0 and newer-half net SOL > 0: holds.
3. Overall net SOL > 0: holds.

**Verdict: FAIL: insufficient sample.** INSUFFICIENT DATA does not apply. The prereg keeps that label for a sample that is small "only because graduation windows are missing"; here every graduate's window was complete. The sample is small because the dataset has only 6 pump.fun graduates and the rule allows one signal per graduation. Per the prereg, the rule is retired and not paper-logged unless the desk decides otherwise.

## Caveats and possible rule problems (reported, not fixed)
- **The gate can't be reached on this dataset.** One signal per coin over 11 coins (6 graduates) caps the backtest at 6 trades, below the 20-trade minimum. Any backtest of this rule needs a dataset of at least 20 graduates that has nothing to do with our scanner's picks.
- **Overlap with edge2 is large:** 2 of the 6 graduates' first pullbacks were also edge2 triggers. By rule 7 those went to edge2 and used up this rule's only signal.
- Some migration pools are paired with a meme token, not SOL (goon/HIMS, COLLECT/CARDS). Detection takes them as written. USD prices still come from the mint's side of the pool.
- n = 4: three trades hit +50% by about 4.6h after graduation. The positive numbers mean nothing statistically.
- Survivorship: every coin made it into our scanner's dataset after graduating.
- Fills on 5m bars are optimistic, especially in thin post-migration bars. The 2 pp cost is assumed. Returns are in USD.
