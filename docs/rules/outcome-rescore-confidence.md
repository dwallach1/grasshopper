# Results re-score of thesis confidence (expected return per trade)

`rule_id: outcome-rescore-confidence` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-10-26

## Purpose (failure prevented)
Tempers a steward's stated confidence with realized outcomes. Feeds the QUANTANAMO >= 80 gate and hardening/forming status.

## Mechanism
`private.thesis_results_score`: scored only with >= 3 live trades (else null, unscored). n_eff = live trades + the backtest weight (backtest-evidence-credit: verified tests, pass or fail, none below 3 live trades, then min(sum 0.5 x n, 5, live / 2) x survivor factor); mean_eff pools the live mean return on stake with the backtest deflated Sharpe x spread; sd_eff = max(live sd, 0.25); results_confidence = round(100 x Phi(mean_eff / (sd_eff / sqrt(n_eff)))). Demote hardening -> forming only when the live upper bound mean + max(sd, 0.25)/sqrt(n) < 0, or n >= 10 with mean < 0; kill only when n >= 10 and the upper bound < 0 (live only). theses.confidence (display) = results_confidence when scored, else the stated number. Only the re-score writes the results columns (guard trigger). Was: Beta on hit rate, cap 60 and demote at n >= 5 with negative P/L.

Code paths:
- `supabase/schemas/11_outcome_rescore_sizing.sql`
- `supabase/schemas/41_court_decisions.sql`
- `supabase/schemas/47_backtest_credit_live_gated.sql`

## The court

**GROWTH.** Hit rate isn't edge. QUANTANAMO's style wins big and loses small (winners avg +30% of stake, losers -11%; breakeven hit rate 27%). A thesis hitting 35% at that payoff earns ~+3.2% per trade, but its confidence converges to 35 and it can never pass the 80 gate. The 5-trade demotion blocks 41% of genuinely good theses (true Sharpe 0.1/trade) and 33% at Sharpe 0.2.

**RUIN.** Small: bad theses are already small via max_stake, and demotion only affects QUANTANAMO autonomy.

**STATISTICS.** Five trades can't tell a Sharpe-0.1 thesis from zero: P(sum < 0) = Phi(-0.1 sqrt 5) = 41%. A hit-rate Beta prior ignores payoff asymmetry.

**INCENTIVES / GAMING.** Pushes a steward toward high-hit-rate, low-payoff trades (take profits early, let losers run) just to keep confidence high: the opposite of what compounds.

## Evidence
Closed-form above; ledger payoff stats (QUANTANAMO 7 trades: hit 29%, payoff ratio 2.7).

## Ruling
**AMEND.** Amend (shipped in migration 41; decided 2026-09-26 by the parent agent under David's delegation). Status changes on the 2026-09-26 re-run: none (no thesis has a negative upper bound or n >= 10).

Amendment: Score on expected return per trade (above). Stated confidence is display only.

| Growth cost | Ruin-risk reduction |
|---|---|
| Removes the permanent block on asymmetric theses. | Demotion/kill now needs real evidence of negative edge. |

## Interactions
quantanamo-80-gate, edge-max-stake, backtest-evidence-credit.
