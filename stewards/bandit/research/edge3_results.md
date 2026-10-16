# edge3 `meme_range_breakout` — backtest results

Run 2026-10-16 09:18 PT, once, exactly per `edge3_prereg.md` (sha256 `599acd6d6a50e4bacc6eeaca000dddee5ae6ef5c7816de86e796e8fa093bba04`, checked by the script before running; it aborts on mismatch). Code: `edge3_run.py` (modeled on `edge2_fullexit_run.py`). Trades: `edge3_results.csv`. Summary: `_edge3_summary.json`. No rule or parameter was changed after seeing results.

Dataset: the edge2 dataset (`raw/ohlcv5_*_usd.json`, one pool per coin with the most bars, median close > $1 excluded → GROK excluded). 11 coins, 5,207 evaluable bars, about 2026-09-18 to 2026-10-07 PT.

| Half | Trades | Wins | Mean net % | Mean - SE | Mean ex top 2 | Net SOL (0.45 stake) |
|---|---|---|---|---|---|---|
| Older | 0 | 0 | n/a | n/a | n/a | 0 |
| Newer | 1 | 1 | +9.14% | n/a (n=1) | n/a | +0.041 |
| All | 1 | 1 | +9.14% | n/a (n=1) | n/a | +0.041 |

Exit triggers: 1 at the 4h stop.

## Backtest gate (verbatim from the prereg)
1. Total trades >= 20 and each half >= 10: **fails** (1 trade; older half 0, newer half 1).
2. Newer-half mean net > 0 and newer-half net SOL > 0: holds (1 trade).
3. Overall net SOL > 0: holds (1 trade).

**Verdict: FAIL: insufficient sample.** Per the prereg, the rule is retired and not paper-logged unless the desk decides otherwise.

## Signal counts (diagnostic only, not a rule change)
Of 5,207 bars: 1,451 had a 6h range <= 25%; 37 closed above the 6h high; 37 of those were green; 17 had volume >= 3x the 6h median; 3 also had 6h volume >= $50k. Dedupe (>= prior exit and >= 4h) cut those 3 bars to 1 trade. Nearly all tight-range windows fail the $50k activity floor.

## Caveats
- **The only trade is not a FEELSGOOD price.** The edge2 pool-choice rule (most bars) picks `ohlcv5_FEELSGOOD_8V79sJMP_usd.json`, a PEPE/FEELSGOOD pool whose USD bars price the base token, PEPE (`PEPEqnuu…`). The single trade is a PEPE price path. This is a flaw in the shared dataset, not in this rule. It does not touch the edge2 results (edge2 had 0 FEELSGOOD trades). Left as-is because the prereg locks the dataset.
- Tiny dataset: 11 coins and ~21 coin-days. 20 trades was never likely here.
- Bar windows are counted by index (72 bars). GeckoTerminal leaves out bars with no trades, so a window can cover more than 6h of clock time. The trade's window covered 6.0h.
- No liquidity or age history: the live $100k / <14d floors can't be applied.
- Fills on 5m bars are optimistic. The 2 pp cost is an assumption, not a quote. Returns are in USD. The coin universe came from our scanner.
