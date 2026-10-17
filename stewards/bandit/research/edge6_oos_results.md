# edge6 `meme_flush_rebound` — out-of-sample results

Run 2026-10-17 06:09 PT, once, exactly per `edge6_prereg.md` (sha256 `d4770a56b42bf33a1d1f7dcfd114c896ae3bbaec1c2d76f99fee8e8c12b893ca`; committed in ccf1f92 at 06:06:59 PT, before the set B fetch started at 06:07:08 PT and before any OOS run. The prereg header's "Written 06:20 PT" is a wrong clock reading in the locked file; the commit time is the real one. Not edited, to keep the hash; `edge6_oos_run.py` checks it and aborts on mismatch). Code: `edge6_rule.py`, `edge6_oos_fetch.py`, `edge6_oos_run.py`. Trades: `edge6_oos_results.csv`. Summary: `_edge6_oos_summary.json`. Set B fetch log: `edge6_oos_setB_fetch_log.json`. No rule or parameter was changed after seeing results.

## Datasets
- **A — edge2 dataset** (older period, 2026-09-18 … 10-07): 10 coins used. Excluded: Agency (in-sample mint), GROK (median close > $1).
- **B — fresh coins** (GeckoTerminal top Solana pools by 24h volume at 2026-10-17 06:07 PT, pool < 14d, reserve >= $100k, not in-sample, not in A): only 13 pools qualified in pages 1–10 (the prereg allowed up to 40); 7 had >= 74 bars and were used, 6 were too new (< 74 bars).

## Results (net after 2 pp, house exits)
| Set | Trades | Wins | Mean net % | SE | Mean − SE | Mean ex top 2 | Median | Net SOL (0.45) |
|---|---|---|---|---|---|---|---|---|
| Pooled | 66 | 37 | +11.69% | 4.24 | +7.45% | +10.55% | +6.53% | +3.47 |
| Older half | 33 | 17 | +9.07% | 6.16 | +2.90% | +6.56% | +3.19% | +1.35 |
| Newer half | 33 | 20 | +14.31% | 5.88 | +8.43% | +12.13% | +12.18% | +2.12 |
| A (edge2 coins) | 56 | 31 | +12.13% | 4.66 | +7.47% | +10.80% | +5.34% | +3.06 |
| B (fresh coins) | 10 | 6 | +9.20% | 10.64 | −1.44% | −0.50% | +8.87% | +0.41 |

Exit triggers (pooled): 27 at +50% TP, 9 at the −40% kill, 30 at the 4h stop. Entries 2026-09-18 10:10 PT … 2026-10-17 03:15 PT.

## OOS gate (verbatim from the prereg)
1. Pooled trades >= 20 and each half >= 10: **holds** (66; 33 / 33).
2. Pooled net mean > 0 and newer-half net mean > 0: **holds** (+11.69%, +14.31%).
3. Pooled mean ex top 2 > 0: **holds** (+10.55%).

**Verdict: PASS → forward paper.** Per the prereg this only earns paper logging; promotion needs >= 20 forward paper passes meeting the house bar.

## Robustness (diagnostic only, not a rule change)
- No single coin carries it: dropping any one coin with >= 5 trades leaves the pooled mean between +9.7% and +12.5% (ex top 2 between +8.3% and +11.3%). Per-coin means: QUEEF +28.8% (7), goon +25.1% (6), SI +18.6% (5), COLLECT +13.1% (5), FEELSGOOD +12.6% (11), TIGRINO +9.5% (8), 1/TRUMP +5.9% (5), JEANPHIL +2.3% (4), familiars +2.0% (5); negative: X7 −12.0% (3), SHARTCOIN −14.5% (2).
- Set B alone is too small to say anything (n = 10; mean − SE and ex top 2 both slightly negative).
- In-sample (exploration coins, prereg): +4.81% (n = 272). OOS is higher; set A is a hotter, scanner-surfaced period, so do not read +11.7% as the expected forward edge.

## Caveats
- Set A coins were surfaced by our momentum scanner (not a random sample) and the period overlaps the earliest edge2 work; set B is survivorship-biased (selected on current volume and liquidity) and small.
- 5m fills at flush prices are optimistic; spreads and impact right after a 30–50% drop can exceed the 2 pp cost assumption.
- No liquidity/age history in either set; the forward universe applies the scan floors (liquidity >= $100k, age < 14d) that the backtest cannot.
- Trades within a coin are correlated; the SE treats them as independent.
- Returns in USD terms; SOL drift ignored.
