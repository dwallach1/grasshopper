# edge2 dataset fix: FEELSGOOD pool (2026-10-16)

Written 2026-10-16 09:22 PT. Data fix on the box research mirror only. **No locked results file was edited** (`edge2_results.*`, `edge2_fullexit_results.*`, `_edge2*_summary.json`, `edge3_results.*` are byte-identical to what was run).

## Problem
The edge2 dataset rule ("one pool per coin: the file with the most bars") picked `raw/ohlcv5_FEELSGOOD_8V79sJMP_usd.json` (723 bars) for FEELSGOOD. That pool is **PEPE / FEELSGOOD**: base PEPE (`PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m`), quote FEELSGOOD. It was fetched with `token=base`, so its USD bars are **PEPE's** price. FEELSGOOD's own pool is `raw/ohlcv5_FEELSGOOD_51nGR5Xc_usd.json` (FEELSGOOD / SOL, base `HgcxVs6kJhPAaGqnPNGaa7zYgNT49hJrLufiqcNMuYZT`, 688 bars).

## Fix (box, `/workspace/bandit/research/raw/`)
Moved the PEPE file out of the dataset glob, without deleting it:
`raw/ohlcv5_FEELSGOOD_8V79sJMP_usd.json` → `raw/_excluded/ohlcv5_FEELSGOOD_8V79sJMP_usd.json` (sha256 `690b9f42070a88ecbefb852440f2b345af911bd63753ec5432989b5576851f50`).
Now `raw/ohlcv5_*_usd.json` resolves FEELSGOOD to `ohlcv5_FEELSGOOD_51nGR5Xc_usd.json` (sha256 `a2c433d44045fb904c08d006bcf24b28d5a9170ea39be869b07df04a2f82cc05`). To undo, move the file back.
The other raw files were checked: in each, the coin itself is the base token (COLLECT/CARDS, QUEEF/Fartcoin and goon/HIMS are non-SOL pools, but they still price the coin). GROK's file is SPCXx/GROK and stays excluded by the median > $1 rule.

## Impact
- **edge3 (`meme_range_breakout`):** its single backtest trade was on the PEPE series, so it was invalid. On FEELSGOOD's own pool there are 0 edge3 signal bars, which leaves edge3 with 0 valid backtest trades.
- **edge2 (`meme_pullback_reclaim`):** no locked edge2 trade used the PEPE series (0 FEELSGOOD trades in `edge2_results.csv` / `edge2_fullexit_results.csv`), so **every recorded edge2 trade is valid**. But the locked run never saw FEELSGOOD's real price, so it **missed FEELSGOOD's real signals**. An informational rerun of `edge2_fullexit_run.py` on the corrected dataset (run in a scratch dir; it changes no locked file, verdict or promotion bar) gives:
  - 52 trades (was 46), including 6 FEELSGOOD trades (net -0.103 SOL: -16.4, +48.0, -17.9, -5.9, -22.8, -7.8 %).
  - Older 26 trades, +8.08% mean, +0.946 SOL. Newer 26, +8.66%, +1.014 SOL. All 52, +8.37%, +1.959 SOL. Mean with top 2 removed: older +4.76%, newer +5.38%, all +6.79%. All mean - SE: +3.83%.
  - The original pre-registered bar still PASSES on corrected data. The locked edge2 numbers (46 trades, +9.96%) stay the record of what was run.
