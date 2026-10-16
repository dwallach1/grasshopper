# edge3 / edge4 amendment: forward paper only (2026-10-16)

Written 2026-10-16 09:22 PT. Records a desk ruling. **The hashed prereg files are unchanged**:
- `edge3_prereg.md` sha256 `599acd6d6a50e4bacc6eeaca000dddee5ae6ef5c7816de86e796e8fa093bba04`
- `edge4_prereg.md` sha256 `f88d7e42876ccf6e02ddeb2af2295bb34114aeeff28cd329007803e3d20bde30`
This note sits alongside them and supersedes one clause in each: "Backtest FAIL → rule retired, not paper-logged".

## Ruling
- **Who:** GRASSHOPPER (desk lead), in BIDNESS, after BANDIT posted the edge3/edge4 backtest results (`edge3_results.md`, `edge4_results.md`).
- **When:** 2026-10-16 09:20 PT (12:20 ET).
- **What:** amendment GRANTED. `meme_range_breakout` (edge3) and `meme_grad_pullback` (edge4) both go to **forward paper only**:
  - no backtest credit (backtest trades never count toward the 20 passes);
  - promotion bar **exactly as locked** in each prereg (n >= 20 forward paper passes, mean - SE > 0 AND mean with top 2 winners removed > 0, then guidance size);
  - no money moves until that bar is met, even if sizing guidance says entry_allowed.
- Signal definitions, exits, costs, dedupe and edge2 precedence are as in the hashed preregs. Nothing is re-tuned.

## Reason
- **edge4:** FAIL: insufficient sample (4 trades) came only from the data. The edge2 dataset has just 6 pump.fun graduates, and the rule allows one signal per graduation, so the 20-trade gate could not be reached on any outcome. It was not a negative result.
- **edge3:** FAIL: insufficient sample on 1 trade, and that trade was bad data. The edge2 dataset's FEELSGOOD file (`ohlcv5_FEELSGOOD_8V79sJMP_usd.json`) is a PEPE/FEELSGOOD pool whose USD bars price PEPE, not FEELSGOOD. On FEELSGOOD's own pool, edge3 has **0** signal bars, so the backtest has no valid trade. See `edge2_dataset_feelsgood_fix_20261016.md`.

The locked results files (`edge3_results.*`, `edge4_results.*`, `_edge3_summary.json`, `_edge4_summary.json`) are kept as run and are not edited.
