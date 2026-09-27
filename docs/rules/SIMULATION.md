# Rules-court simulation (2026-09-26, backtest evidence 2026-09-27)

Reproduce with `python3 tools/court/grid.py && python3 tools/court/grid2.py && python3 tools/court/replay.py && python3 tools/court/evidence.py && python3 tools/court/evidence_gate.py && python3 tools/court/report.py`. `ledger.json` holds each steward's closed, priced, non-paper returns on stake (`realized_pnl / cost`), in order, exported from `trade_outcomes`.

## Assumptions

- **Trades are sequential**, one position at a time. The Monte Carlo can't see concurrent correlated positions; see portfolio-exposure.
- **Returns are bootstrapped** from the steward's real returns on stake, then re-centred to a hypothetical true mean `mu = Sharpe/trade x sd`, floored at -1.06. Shape (fat tails, rugs, binary payoffs) comes from the ledger; the level of edge is the scenario.
- **The horizon is one year at ledger pace**: QUANTANAMO 100, ODDSBORNE 150, BANDIT 400 trades. There are 1,500 paths per cell, and the book starts at 1.0 (today's equity).
- **The rules are simulated as coded**: starter; proven at n ≥ 10 with 1σ LCB > 0; half-Kelly on the LCB; growth ≤ starter x 2^(1+(n-10)/5); cash only (stake ≤ equity). The sim tracks a single thesis per steward.
- **Drawdown scaling** is x1 at ≤ 10% below peak, linear to x0.5 at ≥ 40%.
- **QUANTANAMO stress**: with 7 trades, the worst return on stake is -19%, which understates gap risk. The stress rows add a 5% chance per trade of a -40% gap.
- **Backtest credit** (grid 2, 2026-09-26): 30 backtest trades at weight 0.5 with a 50% mean haircut. The backtest mean = true mean + estimation noise (+ a fake +0.2 Sharpe in the overfit case). The 2026-09-27 evidence runs are described in their own section.
- **Metrics**: `medX` is the median terminal multiple. `P2x` / `P10x` are the chance of touching 2x or 10x within the year. `DD50` is P(a peak-to-trough drawdown ≥ 50%). `ruin` is P(book < 20% of start).
- **Limits**: the samples are tiny (QUANTANAMO 7, ODDSBORNE 8, BANDIT 35), so the real edge is unknown; that's why every table is conditional on the true Sharpe. Nothing here is a P/L forecast.

## Ledger statistics (return on stake)

| Steward | n | mean | sd | 1σ LCB | hit | P(loss) | P(loss \| prev loss) | lag-1 corr |
|---|---|---|---|---|---|---|---|---|
| bandit | 35 | +0.0019 | 0.4488 | -0.0740 | 0.49 | 0.51 | 0.53 | +0.004 |
| oddsborne | 8 | +0.2037 | 1.9572 | -0.4883 | 0.38 | 0.62 | 0.50 | +0.050 |
| quantanamo | 7 | +0.0055 | 0.2220 | -0.0784 | 0.29 | 0.71 | 0.75 | +0.218 |

## Grid 1: current rules vs alternatives

`A_current` is fixed-dollar starter (5% of today's book), loss halving, 1σ. `C` is starter as a share of current book, plus drawdown scaling. `fixed_x%` is a fixed fraction of equity with no learning, for reference.


**bandit, true Sharpe/trade 0.0 (mu +0.0000)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 0.974 | 0.045 | 0.001 | 0.205 | 0.011 | 81.0 | 20.0 | 0.643 |
| B_current_no_halving | 0.954 | 0.079 | 0.003 | 0.419 | 0.069 | 90.0 | 20.0 | 0.614 |
| C_book%5,ddscale,1sig | 0.875 | 0.083 | 0.003 | 0.093 | 0.0 | 113.5 | 20.0 | 0.634 |
| C2_book%5,ddscale,2sig | 0.892 | 0.067 | 0.0 | 0.047 | 0.0 | 270.0 | 34.0 | 0.198 |
| C_book%10,ddscale,1sig | 0.77 | 0.21 | 0.005 | 0.67 | 0.001 | 148.0 | 20.0 | 0.634 |
| C_book%2.5,ddscale,1sig | 0.934 | 0.05 | 0.001 | 0.021 | 0.0 | 85.0 | 20.0 | 0.634 |
| fixed_2% | 0.987 | 0.0 | 0.0 | 0.0 | 0.0 | None | 20.0 | 0.634 |
| fixed_5% | 0.912 | 0.077 | 0.0 | 0.272 | 0.0 | 283.0 | 20.0 | 0.634 |
| fixed_10% | 0.674 | 0.284 | 0.002 | 0.865 | 0.135 | 166.0 | 20.0 | 0.634 |
| fixed_20% | 0.2 | 0.411 | 0.043 | 0.999 | 0.667 | 73.0 | 20.0 | 0.615 |

**bandit, true Sharpe/trade 0.05 (mu +0.0224)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 1.247 | 0.187 | 0.015 | 0.098 | 0.0 | 163.0 | 23.0 | 0.839 |
| B_current_no_halving | 1.369 | 0.266 | 0.028 | 0.215 | 0.007 | 178.0 | 24.0 | 0.841 |
| C_book%5,ddscale,1sig | 1.279 | 0.284 | 0.021 | 0.06 | 0.0 | 198.5 | 23.0 | 0.839 |
| C2_book%5,ddscale,2sig | 1.347 | 0.281 | 0.003 | 0.007 | 0.0 | 264.5 | 68.5 | 0.439 |
| C_book%10,ddscale,1sig | 1.414 | 0.532 | 0.033 | 0.378 | 0.0 | 159.0 | 23.0 | 0.839 |
| C_book%2.5,ddscale,1sig | 1.129 | 0.185 | 0.018 | 0.038 | 0.0 | 156.0 | 23.0 | 0.839 |
| fixed_2% | 1.181 | 0.002 | 0.0 | 0.0 | 0.0 | 370.0 | 23.0 | 0.839 |
| fixed_5% | 1.429 | 0.319 | 0.0 | 0.06 | 0.0 | 272.0 | 23.0 | 0.839 |
| fixed_10% | 1.654 | 0.625 | 0.035 | 0.627 | 0.017 | 162.5 | 23.0 | 0.839 |
| fixed_20% | 1.343 | 0.711 | 0.207 | 0.997 | 0.309 | 80.0 | 25.0 | 0.845 |

**bandit, true Sharpe/trade 0.1 (mu +0.0449)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 1.663 | 0.491 | 0.069 | 0.125 | 0.0 | 191.5 | 20.0 | 0.963 |
| B_current_no_halving | 1.942 | 0.617 | 0.133 | 0.224 | 0.0 | 179.0 | 20.0 | 0.963 |
| C_book%5,ddscale,1sig | 1.977 | 0.629 | 0.106 | 0.099 | 0.0 | 188.0 | 20.0 | 0.963 |
| C2_book%5,ddscale,2sig | 2.107 | 0.657 | 0.032 | 0.007 | 0.0 | 237.0 | 91.0 | 0.739 |
| C_book%10,ddscale,1sig | 3.174 | 0.815 | 0.154 | 0.205 | 0.0 | 138.0 | 20.0 | 0.963 |
| C_book%2.5,ddscale,1sig | 1.545 | 0.492 | 0.093 | 0.085 | 0.0 | 184.0 | 20.0 | 0.963 |
| fixed_2% | 1.413 | 0.034 | 0.0 | 0.0 | 0.0 | 362.0 | 20.0 | 0.963 |
| fixed_5% | 2.237 | 0.707 | 0.001 | 0.008 | 0.0 | 237.0 | 20.0 | 0.963 |
| fixed_10% | 4.054 | 0.889 | 0.188 | 0.341 | 0.001 | 131.0 | 20.0 | 0.963 |
| fixed_20% | 7.752 | 0.916 | 0.581 | 0.977 | 0.079 | 65.0 | 20.0 | 0.963 |

**bandit, true Sharpe/trade 0.2 (mu +0.0898)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 17.607 | 0.967 | 0.654 | 0.321 | 0.0 | 121.0 | 13.0 | 1.0 |
| B_current_no_halving | 43.818 | 0.987 | 0.778 | 0.517 | 0.0 | 103.0 | 13.0 | 1.0 |
| C_book%5,ddscale,1sig | 28.417 | 0.987 | 0.739 | 0.29 | 0.0 | 107.0 | 13.0 | 1.0 |
| C2_book%5,ddscale,2sig | 9.753 | 0.991 | 0.524 | 0.053 | 0.0 | 151.0 | 51.0 | 0.995 |
| C_book%10,ddscale,1sig | 37.445 | 0.999 | 0.814 | 0.309 | 0.0 | 79.0 | 13.0 | 1.0 |
| C_book%2.5,ddscale,1sig | 24.838 | 0.967 | 0.703 | 0.281 | 0.0 | 117.0 | 13.0 | 1.0 |
| fixed_2% | 2.022 | 0.565 | 0.0 | 0.0 | 0.0 | 336.0 | 13.0 | 1.0 |
| fixed_5% | 5.475 | 0.996 | 0.091 | 0.0 | 0.0 | 153.0 | 13.0 | 1.0 |
| fixed_10% | 24.208 | 1.0 | 0.875 | 0.053 | 0.0 | 78.0 | 13.0 | 1.0 |
| fixed_20% | 275.464 | 1.0 | 0.985 | 0.766 | 0.002 | 40.0 | 13.0 | 1.0 |

**oddsborne, true Sharpe/trade 0.0 (mu +0.0000)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 1.418 | 0.341 | 0.005 | 0.344 | 0.101 | 86.0 | 23.0 | 0.685 |
| B_current_no_halving | 1.678 | 0.547 | 0.011 | 0.599 | 0.235 | 68.0 | 21.0 | 0.681 |
| C_book%5,ddscale,1sig | 1.145 | 0.441 | 0.029 | 0.508 | 0.001 | 51.0 | 21.0 | 0.693 |
| C2_book%5,ddscale,2sig | 1.149 | 0.443 | 0.03 | 0.505 | 0.001 | 50.5 | 55.5 | 0.229 |
| C_book%10,ddscale,1sig | 0.948 | 0.546 | 0.103 | 0.986 | 0.119 | 30.0 | 21.0 | 0.693 |
| C_book%2.5,ddscale,1sig | 1.173 | 0.265 | 0.005 | 0.041 | 0.0 | 89.0 | 21.0 | 0.693 |
| fixed_2% | 1.226 | 0.217 | 0.0 | 0.071 | 0.0 | 105.0 | 21.0 | 0.693 |
| fixed_5% | 1.23 | 0.547 | 0.05 | 0.817 | 0.074 | 54.0 | 21.0 | 0.693 |
| fixed_10% | 0.577 | 0.627 | 0.18 | 1.0 | 0.483 | 26.5 | 22.0 | 0.701 |
| fixed_20% | 0.01 | 0.556 | 0.191 | 1.0 | 0.916 | 10.5 | 19.5 | 0.629 |

**oddsborne, true Sharpe/trade 0.05 (mu +0.0979)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 1.591 | 0.415 | 0.007 | 0.279 | 0.061 | 83.5 | 21.0 | 0.763 |
| B_current_no_halving | 1.969 | 0.641 | 0.025 | 0.515 | 0.187 | 67.0 | 23.0 | 0.737 |
| C_book%5,ddscale,1sig | 1.383 | 0.54 | 0.05 | 0.45 | 0.001 | 53.5 | 21.0 | 0.753 |
| C2_book%5,ddscale,2sig | 1.383 | 0.541 | 0.051 | 0.447 | 0.001 | 53.0 | 58.0 | 0.306 |
| C_book%10,ddscale,1sig | 1.25 | 0.619 | 0.155 | 0.982 | 0.085 | 30.0 | 21.0 | 0.753 |
| C_book%2.5,ddscale,1sig | 1.333 | 0.343 | 0.01 | 0.027 | 0.0 | 85.0 | 21.0 | 0.753 |
| fixed_2% | 1.37 | 0.292 | 0.0 | 0.052 | 0.0 | 103.0 | 21.0 | 0.753 |
| fixed_5% | 1.568 | 0.629 | 0.075 | 0.767 | 0.049 | 52.0 | 21.0 | 0.753 |
| fixed_10% | 0.948 | 0.687 | 0.239 | 0.999 | 0.413 | 24.5 | 20.0 | 0.755 |
| fixed_20% | 0.01 | 0.603 | 0.239 | 1.0 | 0.881 | 10.0 | 20.0 | 0.693 |

**oddsborne, true Sharpe/trade 0.1 (mu +0.1957)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 1.819 | 0.534 | 0.013 | 0.186 | 0.028 | 86.0 | 20.0 | 0.84 |
| B_current_no_halving | 2.401 | 0.765 | 0.045 | 0.399 | 0.111 | 62.0 | 20.0 | 0.835 |
| C_book%5,ddscale,1sig | 1.966 | 0.665 | 0.099 | 0.315 | 0.0 | 49.0 | 21.0 | 0.85 |
| C2_book%5,ddscale,2sig | 1.967 | 0.666 | 0.099 | 0.311 | 0.0 | 49.0 | 57.0 | 0.418 |
| C_book%10,ddscale,1sig | 2.109 | 0.734 | 0.263 | 0.953 | 0.042 | 30.0 | 21.0 | 0.85 |
| C_book%2.5,ddscale,1sig | 1.664 | 0.493 | 0.025 | 0.013 | 0.0 | 85.5 | 21.0 | 0.85 |
| fixed_2% | 1.632 | 0.426 | 0.0 | 0.023 | 0.0 | 99.0 | 21.0 | 0.85 |
| fixed_5% | 2.418 | 0.757 | 0.145 | 0.671 | 0.021 | 48.0 | 21.0 | 0.85 |
| fixed_10% | 2.208 | 0.807 | 0.361 | 0.997 | 0.266 | 24.0 | 20.0 | 0.857 |
| fixed_20% | 0.098 | 0.703 | 0.358 | 1.0 | 0.793 | 9.0 | 17.0 | 0.777 |

**oddsborne, true Sharpe/trade 0.2 (mu +0.3914)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 2.948 | 0.848 | 0.131 | 0.015 | 0.001 | 69.0 | 16.0 | 0.987 |
| B_current_no_halving | 4.942 | 0.975 | 0.331 | 0.133 | 0.007 | 45.0 | 15.0 | 0.988 |
| C_book%5,ddscale,1sig | 8.185 | 0.949 | 0.485 | 0.037 | 0.0 | 37.0 | 16.0 | 0.987 |
| C2_book%5,ddscale,2sig | 8.177 | 0.949 | 0.486 | 0.031 | 0.0 | 37.0 | 50.0 | 0.846 |
| C_book%10,ddscale,1sig | 20.525 | 0.961 | 0.737 | 0.643 | 0.0 | 22.0 | 16.0 | 0.987 |
| C_book%2.5,ddscale,1sig | 3.777 | 0.891 | 0.242 | 0.003 | 0.0 | 67.0 | 16.0 | 0.987 |
| fixed_2% | 2.908 | 0.857 | 0.005 | 0.0 | 0.0 | 82.0 | 16.0 | 0.987 |
| fixed_5% | 10.222 | 0.973 | 0.578 | 0.196 | 0.0 | 36.0 | 16.0 | 0.987 |
| fixed_10% | 39.787 | 0.981 | 0.833 | 0.937 | 0.027 | 20.0 | 16.0 | 0.987 |
| fixed_20% | 56.856 | 0.955 | 0.827 | 1.0 | 0.297 | 11.0 | 14.0 | 0.981 |

**quantanamo, true Sharpe/trade 0.0 (mu +0.0000)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 0.98 | 0.006 | 0.0 | 0.0 | 0.0 | 50.0 | 17.0 | 0.471 |
| B_current_no_halving | 0.973 | 0.011 | 0.0 | 0.003 | 0.0 | 48.0 | 17.0 | 0.471 |
| C_book%5,ddscale,1sig | 0.97 | 0.013 | 0.0 | 0.0 | 0.0 | 42.0 | 17.0 | 0.471 |
| C2_book%5,ddscale,2sig | 0.989 | 0.001 | 0.0 | 0.0 | 0.0 | 24.0 | 26.0 | 0.087 |
| C_book%10,ddscale,1sig | 0.95 | 0.016 | 0.0 | 0.001 | 0.0 | 42.0 | 17.0 | 0.471 |
| C_book%2.5,ddscale,1sig | 0.975 | 0.009 | 0.0 | 0.0 | 0.0 | 52.5 | 17.0 | 0.471 |
| fixed_2% | 0.997 | 0.0 | 0.0 | 0.0 | 0.0 | None | 17.0 | 0.471 |
| fixed_5% | 0.99 | 0.0 | 0.0 | 0.0 | 0.0 | None | 17.0 | 0.471 |
| fixed_10% | 0.971 | 0.0 | 0.0 | 0.0 | 0.0 | None | 17.0 | 0.471 |
| fixed_20% | 0.906 | 0.047 | 0.0 | 0.187 | 0.0 | 69.5 | 17.0 | 0.471 |

**quantanamo, true Sharpe/trade 0.05 (mu +0.0111)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 1.002 | 0.022 | 0.0 | 0.001 | 0.0 | 51.0 | 18.0 | 0.634 |
| B_current_no_halving | 1.018 | 0.037 | 0.001 | 0.004 | 0.0 | 52.0 | 18.0 | 0.634 |
| C_book%5,ddscale,1sig | 1.013 | 0.036 | 0.0 | 0.001 | 0.0 | 51.0 | 18.0 | 0.634 |
| C2_book%5,ddscale,2sig | 1.045 | 0.004 | 0.0 | 0.0 | 0.0 | 61.5 | 34.0 | 0.186 |
| C_book%10,ddscale,1sig | 1.055 | 0.047 | 0.001 | 0.001 | 0.0 | 56.0 | 18.0 | 0.634 |
| C_book%2.5,ddscale,1sig | 0.996 | 0.031 | 0.0 | 0.001 | 0.0 | 53.0 | 18.0 | 0.634 |
| fixed_2% | 1.02 | 0.0 | 0.0 | 0.0 | 0.0 | None | 18.0 | 0.634 |
| fixed_5% | 1.047 | 0.0 | 0.0 | 0.0 | 0.0 | None | 18.0 | 0.634 |
| fixed_10% | 1.085 | 0.001 | 0.0 | 0.0 | 0.0 | 92.5 | 18.0 | 0.634 |
| fixed_20% | 1.132 | 0.132 | 0.0 | 0.073 | 0.0 | 74.0 | 18.0 | 0.634 |

**quantanamo, true Sharpe/trade 0.1 (mu +0.0222)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 1.034 | 0.061 | 0.002 | 0.001 | 0.0 | 61.0 | 17.0 | 0.775 |
| B_current_no_halving | 1.061 | 0.109 | 0.003 | 0.009 | 0.0 | 60.0 | 17.0 | 0.775 |
| C_book%5,ddscale,1sig | 1.06 | 0.107 | 0.003 | 0.001 | 0.0 | 61.0 | 17.0 | 0.775 |
| C2_book%5,ddscale,2sig | 1.102 | 0.013 | 0.0 | 0.0 | 0.0 | 56.0 | 39.0 | 0.33 |
| C_book%10,ddscale,1sig | 1.165 | 0.133 | 0.004 | 0.001 | 0.0 | 60.0 | 17.0 | 0.775 |
| C_book%2.5,ddscale,1sig | 1.019 | 0.097 | 0.003 | 0.001 | 0.0 | 61.5 | 17.0 | 0.775 |
| fixed_2% | 1.043 | 0.0 | 0.0 | 0.0 | 0.0 | None | 17.0 | 0.775 |
| fixed_5% | 1.107 | 0.0 | 0.0 | 0.0 | 0.0 | None | 17.0 | 0.775 |
| fixed_10% | 1.213 | 0.007 | 0.0 | 0.0 | 0.0 | 89.0 | 17.0 | 0.775 |
| fixed_20% | 1.413 | 0.273 | 0.0 | 0.023 | 0.0 | 70.0 | 17.0 | 0.775 |

**quantanamo, true Sharpe/trade 0.2 (mu +0.0444)**

| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| A_current(fixed$5%,halving,1sig) | 1.32 | 0.329 | 0.018 | 0.002 | 0.0 | 66.0 | 14.0 | 0.957 |
| B_current_no_halving | 1.571 | 0.456 | 0.068 | 0.025 | 0.0 | 61.0 | 14.0 | 0.957 |
| C_book%5,ddscale,1sig | 1.514 | 0.447 | 0.057 | 0.003 | 0.0 | 61.0 | 14.0 | 0.957 |
| C2_book%5,ddscale,2sig | 1.217 | 0.141 | 0.005 | 0.0 | 0.0 | 73.5 | 38.0 | 0.707 |
| C_book%10,ddscale,1sig | 1.693 | 0.493 | 0.069 | 0.003 | 0.0 | 59.0 | 14.0 | 0.957 |
| C_book%2.5,ddscale,1sig | 1.455 | 0.423 | 0.05 | 0.003 | 0.0 | 63.0 | 14.0 | 0.957 |
| fixed_2% | 1.09 | 0.0 | 0.0 | 0.0 | 0.0 | None | 14.0 | 0.957 |
| fixed_5% | 1.236 | 0.0 | 0.0 | 0.0 | 0.0 | None | 14.0 | 0.957 |
| fixed_10% | 1.513 | 0.093 | 0.0 | 0.0 | 0.0 | 89.0 | 14.0 | 0.957 |
| fixed_20% | 2.198 | 0.653 | 0.0 | 0.0 | 0.0 | 64.0 | 14.0 | 0.957 |

## Grid 2: halving vs drawdown scaling; vol-normalized starters (David's options)

`volstarter_vX%` means stake = X% x book / sd(return on stake), so every unproven bet risks the same book volatility (QUANTANAMO sd floored at 0.25). `s` is the resulting starter as a share of book.


**bandit, Sharpe 0.0**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 0.924 | 0.049 | 0.001 | 0.113 | 0.0 |
| book5_none | 0.05 | 0.872 | 0.092 | 0.005 | 0.359 | 0.0 |
| book5_ddscale | 0.05 | 0.875 | 0.083 | 0.003 | 0.093 | 0.0 |
| book5_halving+dd | 0.05 | 0.918 | 0.047 | 0.0 | 0.019 | 0.0 |
| volstarter_v2%_dd | 0.0446 | 0.89 | 0.073 | 0.003 | 0.059 | 0.0 |
| volstarter_v3%_dd | 0.0668 | 0.834 | 0.137 | 0.003 | 0.288 | 0.0 |
| volstarter_v4%_dd | 0.0891 | 0.788 | 0.193 | 0.005 | 0.564 | 0.0 |

**bandit, Sharpe 0.1**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 1.736 | 0.525 | 0.069 | 0.125 | 0.0 |
| book5_none | 0.05 | 2.119 | 0.669 | 0.136 | 0.232 | 0.0 |
| book5_ddscale | 0.05 | 1.977 | 0.629 | 0.106 | 0.099 | 0.0 |
| book5_halving+dd | 0.05 | 1.666 | 0.497 | 0.057 | 0.045 | 0.0 |
| volstarter_v2%_dd | 0.0446 | 1.874 | 0.588 | 0.103 | 0.095 | 0.0 |
| volstarter_v3%_dd | 0.0668 | 2.361 | 0.731 | 0.118 | 0.107 | 0.0 |
| volstarter_v4%_dd | 0.0891 | 2.931 | 0.798 | 0.137 | 0.171 | 0.0 |

**bandit, Sharpe 0.2**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 17.838 | 0.969 | 0.653 | 0.327 | 0.0 |
| book5_none | 0.05 | 44.468 | 0.989 | 0.785 | 0.525 | 0.0 |
| book5_ddscale | 0.05 | 28.417 | 0.987 | 0.739 | 0.29 | 0.0 |
| book5_halving+dd | 0.05 | 13.195 | 0.961 | 0.605 | 0.142 | 0.0 |
| volstarter_v2%_dd | 0.0446 | 27.63 | 0.983 | 0.733 | 0.289 | 0.0 |
| volstarter_v3%_dd | 0.0668 | 30.731 | 0.996 | 0.759 | 0.295 | 0.0 |
| volstarter_v4%_dd | 0.0891 | 34.99 | 0.999 | 0.794 | 0.302 | 0.0 |

**oddsborne, Sharpe 0.0**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 1.183 | 0.396 | 0.007 | 0.42 | 0.003 |
| book5_none | 0.05 | 1.23 | 0.547 | 0.05 | 0.821 | 0.074 |
| book5_ddscale | 0.05 | 1.145 | 0.441 | 0.029 | 0.508 | 0.001 |
| book5_halving+dd | 0.05 | 1.095 | 0.334 | 0.007 | 0.119 | 0.0 |
| volstarter_v2%_dd | 0.0102 | 1.101 | 0.087 | 0.003 | 0.001 | 0.0 |
| volstarter_v3%_dd | 0.0153 | 1.151 | 0.13 | 0.004 | 0.001 | 0.0 |
| volstarter_v4%_dd | 0.0204 | 1.171 | 0.2 | 0.005 | 0.011 | 0.0 |

**oddsborne, Sharpe 0.1**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 1.79 | 0.585 | 0.029 | 0.217 | 0.0 |
| book5_none | 0.05 | 2.414 | 0.756 | 0.145 | 0.678 | 0.021 |
| book5_ddscale | 0.05 | 1.966 | 0.665 | 0.099 | 0.315 | 0.0 |
| book5_halving+dd | 0.05 | 1.599 | 0.519 | 0.025 | 0.043 | 0.0 |
| volstarter_v2%_dd | 0.0102 | 1.26 | 0.223 | 0.016 | 0.002 | 0.0 |
| volstarter_v3%_dd | 0.0153 | 1.414 | 0.289 | 0.017 | 0.002 | 0.0 |
| volstarter_v4%_dd | 0.0204 | 1.553 | 0.399 | 0.019 | 0.005 | 0.0 |

**oddsborne, Sharpe 0.2**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 4.254 | 0.889 | 0.199 | 0.015 | 0.0 |
| book5_none | 0.05 | 10.236 | 0.973 | 0.579 | 0.222 | 0.0 |
| book5_ddscale | 0.05 | 8.185 | 0.949 | 0.485 | 0.037 | 0.0 |
| book5_halving+dd | 0.05 | 3.948 | 0.865 | 0.18 | 0.001 | 0.0 |
| volstarter_v2%_dd | 0.0102 | 2.75 | 0.711 | 0.189 | 0.003 | 0.0 |
| volstarter_v3%_dd | 0.0153 | 3.009 | 0.766 | 0.203 | 0.003 | 0.0 |
| volstarter_v4%_dd | 0.0204 | 3.344 | 0.842 | 0.218 | 0.003 | 0.0 |

**quantanamo, Sharpe 0.0**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 0.978 | 0.006 | 0.0 | 0.0 | 0.0 |
| book5_none | 0.05 | 0.969 | 0.013 | 0.0 | 0.003 | 0.0 |
| book5_ddscale | 0.05 | 0.97 | 0.013 | 0.0 | 0.0 | 0.0 |
| book5_halving+dd | 0.05 | 0.979 | 0.006 | 0.0 | 0.0 | 0.0 |
| volstarter_v2%_dd | 0.08 | 0.959 | 0.013 | 0.0 | 0.001 | 0.0 |
| volstarter_v3%_dd | 0.12 | 0.941 | 0.017 | 0.0 | 0.001 | 0.0 |
| volstarter_v4%_dd | 0.16 | 0.916 | 0.029 | 0.0 | 0.003 | 0.0 |

**quantanamo, Sharpe 0.1**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 1.033 | 0.061 | 0.002 | 0.001 | 0.0 |
| book5_none | 0.05 | 1.061 | 0.11 | 0.004 | 0.01 | 0.0 |
| book5_ddscale | 0.05 | 1.06 | 0.107 | 0.003 | 0.001 | 0.0 |
| book5_halving+dd | 0.05 | 1.033 | 0.059 | 0.002 | 0.0 | 0.0 |
| volstarter_v2%_dd | 0.08 | 1.12 | 0.123 | 0.004 | 0.001 | 0.0 |
| volstarter_v3%_dd | 0.12 | 1.204 | 0.148 | 0.004 | 0.001 | 0.0 |
| volstarter_v4%_dd | 0.16 | 1.28 | 0.185 | 0.004 | 0.001 | 0.0 |

**quantanamo, Sharpe 0.2**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 1.32 | 0.33 | 0.019 | 0.002 | 0.0 |
| book5_none | 0.05 | 1.573 | 0.458 | 0.071 | 0.028 | 0.0 |
| book5_ddscale | 0.05 | 1.514 | 0.447 | 0.057 | 0.003 | 0.0 |
| book5_halving+dd | 0.05 | 1.303 | 0.325 | 0.017 | 0.0 | 0.0 |
| volstarter_v2%_dd | 0.08 | 1.621 | 0.469 | 0.063 | 0.003 | 0.0 |
| volstarter_v3%_dd | 0.12 | 1.765 | 0.511 | 0.073 | 0.003 | 0.0 |
| volstarter_v4%_dd | 0.16 | 1.915 | 0.556 | 0.083 | 0.003 | 0.0 |

**quantanamo, Sharpe 0.0 (gap stress: 5% x -40%)**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 0.94 | 0.001 | 0.0 | 0.0 | 0.0 |
| book5_none | 0.05 | 0.894 | 0.003 | 0.0 | 0.002 | 0.0 |
| book5_ddscale | 0.05 | 0.893 | 0.002 | 0.0 | 0.001 | 0.0 |
| book5_halving+dd | 0.05 | 0.94 | 0.001 | 0.0 | 0.0 | 0.0 |
| volstarter_v2%_dd | 0.08 | 0.838 | 0.004 | 0.0 | 0.001 | 0.0 |
| volstarter_v3%_dd | 0.12 | 0.773 | 0.007 | 0.0 | 0.005 | 0.0 |
| volstarter_v4%_dd | 0.16 | 0.722 | 0.007 | 0.0 | 0.067 | 0.0 |

**quantanamo, Sharpe 0.1 (gap stress: 5% x -40%)**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 0.98 | 0.011 | 0.0 | 0.003 | 0.0 |
| book5_none | 0.05 | 0.977 | 0.016 | 0.0 | 0.007 | 0.0 |
| book5_ddscale | 0.05 | 0.978 | 0.014 | 0.0 | 0.002 | 0.0 |
| book5_halving+dd | 0.05 | 0.98 | 0.011 | 0.0 | 0.0 | 0.0 |
| volstarter_v2%_dd | 0.08 | 0.975 | 0.019 | 0.0 | 0.002 | 0.0 |
| volstarter_v3%_dd | 0.12 | 0.956 | 0.025 | 0.001 | 0.003 | 0.0 |
| volstarter_v4%_dd | 0.16 | 0.93 | 0.033 | 0.001 | 0.015 | 0.0 |

**quantanamo, Sharpe 0.2 (gap stress: 5% x -40%)**

| policy | starter share | medX | P2x | P10x | DD50 | ruin |
|---|---|---|---|---|---|---|
| book5_halving | 0.05 | 1.034 | 0.065 | 0.002 | 0.006 | 0.0 |
| book5_none | 0.05 | 1.058 | 0.105 | 0.005 | 0.021 | 0.0 |
| book5_ddscale | 0.05 | 1.059 | 0.101 | 0.003 | 0.005 | 0.0 |
| book5_halving+dd | 0.05 | 1.034 | 0.063 | 0.001 | 0.001 | 0.0 |
| volstarter_v2%_dd | 0.08 | 1.122 | 0.116 | 0.005 | 0.006 | 0.0 |
| volstarter_v3%_dd | 0.12 | 1.204 | 0.147 | 0.007 | 0.006 | 0.0 |
| volstarter_v4%_dd | 0.16 | 1.274 | 0.185 | 0.007 | 0.009 | 0.0 |

## Backtest-evidence credit

| steward | true Sharpe | fake backtest Sharpe bias | policy | medX | P2x | DD50 | trades to proven | P(proven) |
|---|---|---|---|---|---|---|---|---|
| bandit | 0.0 | 0.0 | no_bt | 0.875 | 0.083 | 0.093 | 20.0 | 0.634 |
| bandit | 0.0 | 0.0 | bt30_w.5_h.5 | 0.891 | 0.073 | 0.073 | 24.0 | 0.596 |
| bandit | 0.0 | 0.2 | no_bt | 0.875 | 0.083 | 0.093 | 20.0 | 0.634 |
| bandit | 0.0 | 0.2 | bt30_w.5_h.5 | 0.873 | 0.082 | 0.097 | 6.0 | 0.736 |
| bandit | 0.1 | 0.0 | no_bt | 1.977 | 0.629 | 0.099 | 20.0 | 0.963 |
| bandit | 0.1 | 0.0 | bt30_w.5_h.5 | 2.012 | 0.642 | 0.063 | 19.0 | 0.966 |
| bandit | 0.2 | 0.0 | no_bt | 28.417 | 0.987 | 0.29 | 13.0 | 1.0 |
| bandit | 0.2 | 0.0 | bt30_w.5_h.5 | 25.847 | 0.99 | 0.213 | 7.0 | 1.0 |
| oddsborne | 0.0 | 0.0 | no_bt | 1.145 | 0.441 | 0.508 | 21.0 | 0.693 |
| oddsborne | 0.0 | 0.0 | bt30_w.5_h.5 | 1.174 | 0.439 | 0.515 | 32.0 | 0.639 |
| oddsborne | 0.0 | 0.2 | no_bt | 1.145 | 0.441 | 0.508 | 21.0 | 0.693 |
| oddsborne | 0.0 | 0.2 | bt30_w.5_h.5 | 1.165 | 0.438 | 0.517 | 13.0 | 0.749 |
| oddsborne | 0.1 | 0.0 | no_bt | 1.966 | 0.665 | 0.315 | 21.0 | 0.85 |
| oddsborne | 0.1 | 0.0 | bt30_w.5_h.5 | 2.017 | 0.669 | 0.331 | 23.0 | 0.833 |
| oddsborne | 0.2 | 0.0 | no_bt | 8.185 | 0.949 | 0.037 | 16.0 | 0.987 |
| oddsborne | 0.2 | 0.0 | bt30_w.5_h.5 | 8.225 | 0.955 | 0.035 | 12.0 | 0.991 |
| quantanamo | 0.0 | 0.0 | no_bt | 0.97 | 0.013 | 0.0 | 17.0 | 0.471 |
| quantanamo | 0.0 | 0.0 | bt30_w.5_h.5 | 0.979 | 0.004 | 0.0 | 18.0 | 0.401 |
| quantanamo | 0.0 | 0.2 | no_bt | 0.97 | 0.013 | 0.0 | 17.0 | 0.471 |
| quantanamo | 0.0 | 0.2 | bt30_w.5_h.5 | 0.971 | 0.011 | 0.0 | 7.0 | 0.573 |
| quantanamo | 0.1 | 0.0 | no_bt | 1.06 | 0.107 | 0.001 | 17.0 | 0.775 |
| quantanamo | 0.1 | 0.0 | bt30_w.5_h.5 | 1.074 | 0.083 | 0.0 | 18.0 | 0.759 |
| quantanamo | 0.2 | 0.0 | no_bt | 1.514 | 0.447 | 0.003 | 14.0 | 0.957 |
| quantanamo | 0.2 | 0.0 | bt30_w.5_h.5 | 1.524 | 0.409 | 0.001 | 11.0 | 0.961 |

## Replay of the real sequences

| steward | trades | actual book change | current rules | proposed rules | max DD current | max DD proposed |
|---|---|---|---|---|---|---|
| bandit | 35 | -10.76% | 2.58% | -0.7% | 6.32% | 10.6% |
| oddsborne | 8 | -34.71% | -3.07% | 5.07% | 7.52% | 12.69% |
| quantanamo | 7 | 10.01% | 0.61% | 0.15% | 1.41% | 2.3% |

The actual QUANTANAMO change includes unrealized gains on open lots sized at $1,000-2,500, which the closed-trade replay can't see. On closed trades alone, all rule sets are roughly flat, because the 7 closed trades net about +$13.

## Starter level options (David)

A vol-normalized starter gives the same book risk per unproven bet: stake = v x book / sd(return on stake). The sd values are QUANTANAMO 0.25 (floor; ledger 0.22), BANDIT 0.449 and ODDSBORNE 1.957. Books are as of 2026-09-26.

| Option | QUANTANAMO | BANDIT | ODDSBORNE |
|---|---|---|---|
| Today (flat ~5%) | $250 (4.5%) → 1.1% book vol/bet | 0.10 SOL (5.5%) → 2.5% | $15 (5.4%) → 10.6% |
| v = 2% | $440 (8%) | 0.080 SOL (4.5%) | $2.83 (1.0%) |
| v = 3% | $660 (12%) | 0.12 SOL (6.7%) | $4.24 (1.5%) |
| v = 4% | $880 (16%) | 0.16 SOL (8.9%) | $5.66 (2.0%) |

All values are then x the drawdown scale (ODDSBORNE x0.5 today). See Grid 2 for P(2x) and P(DD50) under each option.

## Backtest evidence both ways (2026-09-27)

`evidence.py`. A steward runs 5 preregistered, out-of-sample, cost-inclusive tests of one thesis (200 trades each; each test's mean is the true mean plus noise sd/sqrt(n)), then trades it live for a year. `credit_only_honest` is the old rule: the first test is logged only if it survives trial deflation. `credit_only_cherry` is the old rule gamed: only the best of the 5 is logged, claiming one trial. `symmetric_all` is the ruling: every test is logged pass or fail, each deflated by E[max of 5] = 1.1926 standard errors, pooled weight capped at 20, mean shrunk 50% either sign. `gate80@0` / `proven@0` are the chances that the 80 gate is open or the thesis is proven before any live trade. `tProven` is the median trades to proven; `Pproven` is P(proven within the year), which at true Sharpe 0 is the false-proof rate.

| steward | true Sharpe | rule | gate80@0 | proven@0 | medX | P2x | DD50 | tProven | Pproven |
|---|---|---|---|---|---|---|---|---|---|
| quantanamo | 0.0 | no_backtest | 0.0 | 0.0 | 0.97 | 0.013 | 0.0 | 17.0 | 0.471 |
| quantanamo | 0.0 | credit_only_honest | 0.0 | 0.0 | 0.972 | 0.018 | 0.0 | 15.0 | 0.431 |
| quantanamo | 0.0 | credit_only_cherry | 0.0 | 0.0 | 0.978 | 0.01 | 0.0 | 18.0 | 0.403 |
| quantanamo | 0.0 | symmetric_all | 0.0 | 0.0 | 0.984 | 0.007 | 0.0 | 28.0 | 0.27 |
| quantanamo | 0.1 | no_backtest | 0.0 | 0.0 | 1.06 | 0.107 | 0.001 | 17.0 | 0.775 |
| quantanamo | 0.1 | credit_only_honest | 0.0 | 0.0 | 1.068 | 0.085 | 0.001 | 19.0 | 0.763 |
| quantanamo | 0.1 | credit_only_cherry | 0.0001 | 0.0 | 1.068 | 0.085 | 0.0 | 16.0 | 0.799 |
| quantanamo | 0.1 | symmetric_all | 0.0 | 0.0 | 1.079 | 0.064 | 0.0 | 30.0 | 0.695 |
| quantanamo | 0.2 | no_backtest | 0.0 | 0.0 | 1.514 | 0.447 | 0.003 | 14.0 | 0.957 |
| quantanamo | 0.2 | credit_only_honest | 0.0004 | 0.0001 | 1.508 | 0.395 | 0.0 | 11.0 | 0.972 |
| quantanamo | 0.2 | credit_only_cherry | 0.0036 | 0.0014 | 1.594 | 0.435 | 0.001 | 4.0 | 0.985 |
| quantanamo | 0.2 | symmetric_all | 0.0 | 0.0 | 1.436 | 0.35 | 0.0 | 18.0 | 0.959 |
| bandit | 0.0 | no_backtest | 0.0 | 0.0 | 0.875 | 0.083 | 0.093 | 20.0 | 0.634 |
| bandit | 0.0 | credit_only_honest | 0.0 | 0.0 | 0.867 | 0.081 | 0.11 | 21.0 | 0.627 |
| bandit | 0.0 | credit_only_cherry | 0.0 | 0.0 | 0.881 | 0.082 | 0.075 | 22.0 | 0.611 |
| bandit | 0.0 | symmetric_all | 0.0 | 0.0 | 0.887 | 0.072 | 0.065 | 48.0 | 0.496 |
| bandit | 0.1 | no_backtest | 0.0 | 0.0 | 1.977 | 0.629 | 0.099 | 20.0 | 0.963 |
| bandit | 0.1 | credit_only_honest | 0.0 | 0.0 | 1.989 | 0.637 | 0.084 | 19.0 | 0.966 |
| bandit | 0.1 | credit_only_cherry | 0.0001 | 0.0 | 1.998 | 0.639 | 0.077 | 11.0 | 0.977 |
| bandit | 0.1 | symmetric_all | 0.0 | 0.0 | 2.002 | 0.641 | 0.049 | 37.0 | 0.956 |
| bandit | 0.2 | no_backtest | 0.0 | 0.0 | 28.417 | 0.987 | 0.29 | 13.0 | 1.0 |
| bandit | 0.2 | credit_only_honest | 0.0062 | 0.0001 | 24.365 | 0.989 | 0.211 | 6.0 | 1.0 |
| bandit | 0.2 | credit_only_cherry | 0.0301 | 0.0014 | 26.357 | 0.985 | 0.233 | 2.0 | 1.0 |
| bandit | 0.2 | symmetric_all | 0.0 | 0.0 | 22.415 | 0.991 | 0.18 | 13.0 | 1.0 |

**Replay: earnings_gap_structure.** Six live returns on stake, in order: -0.03%, +18.42%, +41.47%, -16.43%, -15.10%, -19.40%. Test 31 (trial 17): n 714, mean -0.3457%, sd 6.2007%, survivors only, so weight 10.0 (20 x 0.5); trial deflation 1.8281 x sd/sqrt(n) = 0.4242%, deflated mean -0.7699%.

| after live trade | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| old rule (test 31 can't be logged) | unscored | unscored | 92 | 81 | 69 | 56 |
| ruling (test 31 logged) | 48 | 57 | 73 | 66 | 60 | 52 |

The same test with the sign flipped (+0.7699% deflated) would score 55: the evidence enters the pooled mean with the same coefficient either way (weight x 0.5), so the move is about ±1.5 points around the score of a zero-mean test (54); the asymmetry vs 56 is only the dilution of the live mean. Without the survivors-only discount (weight 20) the score would be 50.

## Live-gated backtest credit (2026-09-27, migration 47)

`evidence_gate.py`. Each thesis has 2 preregistered tests of 200 trades at 17 trials (E[max] = 1.8281), one survivors-only with 35% of events missing; 1500 paths, one year at ledger pace, starter 0.03 x book / max(sd, 0.25), drawdown scaling. `rule_46` is migration 46 (credit from trade 0, weight up to 20, emax-deflated mean shrunk 50%). `rule_47` is this ruling (no credit or score below 3 live trades, weight min(sum 0.5 n, 5, live / 2) x survivor factor, credited mean = deflated Sharpe x spread, live spread). Scenarios: `honest` (test means = true mean + noise), `overfit` (tests carry a fake +0.2 Sharpe at true edge 0), `mismatch` (real live edge, mechanical backtest has none). `gate80<10` = P(the results score reaches 80 before 10 live trades). `score@n` = mean results score after n live trades.

| steward | true Sharpe | scenario | rule | medX | P2x | DD50 | ruin | Pproven | tProven | gate80<10 | score@3/6/10/20 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| quantanamo | 0.0 | honest | no_backtest | 0.956 | 0.025 | 0.002 | 0.0 | 0.475 | 17.0 | 0.312 | 48.2/49.8/49.8/50.1 |
| quantanamo | 0.0 | honest | rule_46 | 0.968 | 0.011 | 0.0 | 0.0 | 0.296 | 33.0 | 0.029 | 41.1/42.1/42.7/44.1 |
| quantanamo | 0.0 | honest | rule_47 | 0.966 | 0.022 | 0.001 | 0.0 | 0.412 | 22.0 | 0.209 | 46.4/46.8/45.9/47.1 |
| quantanamo | 0.1 | honest | no_backtest | 1.225 | 0.179 | 0.004 | 0.0 | 0.796 | 18.5 | 0.426 | 52.7/56.5/58.4/62.2 |
| quantanamo | 0.1 | honest | rule_46 | 1.258 | 0.119 | 0.0 | 0.0 | 0.706 | 31.0 | 0.097 | 49.7/52.2/54.2/58.4 |
| quantanamo | 0.1 | honest | rule_47 | 1.242 | 0.165 | 0.002 | 0.0 | 0.771 | 22.0 | 0.325 | 52.1/55.2/56.7/60.9 |
| quantanamo | 0.2 | honest | no_backtest | 1.871 | 0.55 | 0.005 | 0.0 | 0.976 | 14.0 | 0.506 | 57.3/63.0/66.6/73.1 |
| quantanamo | 0.2 | honest | rule_46 | 1.741 | 0.485 | 0.001 | 0.0 | 0.965 | 20.0 | 0.244 | 58.3/62.2/65.5/71.8 |
| quantanamo | 0.2 | honest | rule_47 | 1.859 | 0.537 | 0.003 | 0.0 | 0.975 | 15.0 | 0.468 | 57.9/63.5/67.1/73.4 |
| bandit | 0.0 | honest | no_backtest | 0.813 | 0.125 | 0.285 | 0.0 | 0.613 | 21.0 | 0.387 | 48.4/47.9/48.1/49.1 |
| bandit | 0.0 | honest | rule_46 | 0.831 | 0.122 | 0.245 | 0.0 | 0.449 | 64.0 | 0.056 | 36.9/38.3/39.6/42.2 |
| bandit | 0.0 | honest | rule_47 | 0.818 | 0.126 | 0.261 | 0.0 | 0.56 | 29.0 | 0.289 | 45.6/44.3/43.5/45.8 |
| bandit | 0.1 | honest | no_backtest | 2.271 | 0.725 | 0.105 | 0.0 | 0.959 | 22.0 | 0.499 | 54.3/55.7/57.8/62.3 |
| bandit | 0.1 | honest | rule_46 | 2.383 | 0.743 | 0.04 | 0.0 | 0.941 | 43.0 | 0.187 | 49.5/51.2/53.5/58.5 |
| bandit | 0.1 | honest | rule_47 | 2.302 | 0.729 | 0.081 | 0.0 | 0.953 | 25.0 | 0.423 | 53.3/54.4/56.1/61.0 |
| bandit | 0.2 | honest | no_backtest | 28.606 | 0.991 | 0.257 | 0.0 | 1.0 | 14.0 | 0.615 | 60.2/63.3/67.0/74.1 |
| bandit | 0.2 | honest | rule_46 | 25.001 | 0.993 | 0.151 | 0.0 | 1.0 | 16.0 | 0.433 | 62.1/63.9/67.0/73.4 |
| bandit | 0.2 | honest | rule_47 | 28.179 | 0.993 | 0.231 | 0.0 | 1.0 | 13.0 | 0.591 | 61.0/64.1/68.0/74.6 |
| quantanamo | 0.0 | overfit | rule_46 | 0.966 | 0.019 | 0.0 | 0.0 | 0.442 | 22.0 | 0.124 | 54.3/54.7/54.2/53.7 |
| quantanamo | 0.0 | overfit | rule_47 | 0.962 | 0.024 | 0.001 | 0.0 | 0.477 | 17.0 | 0.266 | 49.7/51.7/52.2/51.9 |
| bandit | 0.0 | overfit | rule_46 | 0.826 | 0.126 | 0.253 | 0.0 | 0.597 | 23.0 | 0.25 | 56.4/54.5/53.5/53.1 |
| bandit | 0.0 | overfit | rule_47 | 0.81 | 0.126 | 0.282 | 0.0 | 0.623 | 21.0 | 0.359 | 50.1/50.2/50.8/51.0 |
| quantanamo | 0.2 | mismatch | rule_46 | 1.661 | 0.415 | 0.0 | 0.0 | 0.925 | 31.0 | 0.085 | 45.0/49.6/54.2/63.1 |
| quantanamo | 0.2 | mismatch | rule_47 | 1.772 | 0.512 | 0.003 | 0.0 | 0.961 | 20.0 | 0.38 | 54.5/58.7/61.1/69.4 |
| bandit | 0.2 | mismatch | rule_46 | 21.435 | 0.993 | 0.114 | 0.0 | 1.0 | 32.0 | 0.155 | 42.6/47.9/53.5/63.8 |
| bandit | 0.2 | mismatch | rule_47 | 26.147 | 0.993 | 0.197 | 0.0 | 1.0 | 18.0 | 0.493 | 56.6/58.5/61.2/70.2 |

**Replay: earnings_gap_structure** (live returns on stake -0.03%, +18.42%, +41.47%, -16.43%, -15.10%, -19.40%; tests 31 and 30 from their stored rows).

| after live trade | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| no backtest | unscored | unscored | 92 | 81 | 69 | 56 |
| rule 46 (test 31) | 48 | 57 | 73 | 66 | 60 | 52 |
| rule 47 (tests 31 + 30) | unscored | unscored | 88 | 77 | 66 | 54 |
| rule 47 backtest weight | 0.0 | 0.0 | 0.988 | 1.317 | 1.646 | 1.976 |

With both tests' signs flipped the rule-47 score after 6 trades would be 56.
