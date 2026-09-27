# Out-of-sample backtest evidence counts both ways (pass or fail)

`rule_id: backtest-evidence-credit` · status: **in_force** · verdict: **amend** · ruling 2026-09-27 · next review 2026-11-27

## Purpose (failure prevented)
Lets real out-of-sample evidence speed up (or slow down) proof of an edge, without rewarding a steward for running many tests and logging only the winners.

## Mechanism
`public.thesis_backtest_evidence`, append-only for stewards (no update; no inactive insert; one row per thesis and test). A row counts when it is out_of_sample, costs_included, rules_locked_at < results_at, has a trial count, and its `strategy_tests` row completed (survived or killed): pass or fail. Per row: weight = min(0.5 x n, 20), x0.5 when survivors_only; mean_ret_deflated = mean_ret - E[max of `trials` standard normals] x sd / sqrt(n) (the deflated-Sharpe benchmark; 0 for one trial). `private.thesis_edge_evidence` pools every counted row (weight capped at 20, weight-pooled deflated mean and sd); `private.edge_max_stake` and `private.thesis_results_score` add that weight to the live trades and shrink its mean 50% toward zero, the same for a negative mean as a positive one. `public.v_thesis_backtest_evidence` lists every row (weight, deflated mean, counted, for/against); `public.v_backtest_tests_unlogged` lists completed preregistered thesis tests with no row; `v_thesis_scorecard` carries the pooled backtest columns.

Code paths:
- `supabase/schemas/37_court_rulings.sql`
- `supabase/schemas/38_edge_max_stake_null_thesis.sql`
- `supabase/schemas/41_court_decisions.sql`
- `supabase/schemas/46_backtest_evidence_symmetric.sql`

## The court

**GROWTH.** Cost, measured. With every test logged and each deflated by its trial count, a real edge is proven later than under credit-only: QUANTANAMO at Sharpe 0.2 median trades to proven 11 (honest credit-only) -> 18 (no backtest: 14), P(2x in a year) 39.5% -> 35.0% (no backtest: 44.7%); BANDIT at Sharpe 0.2 median terminal 24.4x -> 22.4x (no backtest 28.4x). Part of that is the trial deflation applied to every pooled test, which overcorrects when all trials are logged (the selection it corrects for didn't happen); the next review should deflate only by trials that were not logged. At Sharpe 0.1 the growth difference is inside noise (BANDIT median 1.99x vs 2.00x).

**RUIN.** Helps. False proofs of a zero-edge thesis within a year fall from 43.1% (QUANTANAMO, honest credit-only) and 40.3% (cherry-picked) to 27.0%; BANDIT 62.7% / 61.1% -> 49.6%. BANDIT P(DD50) at zero edge 11.0% (honest credit-only) / 7.5% (cherry) -> 6.5%. With cherry-picking, BANDIT at Sharpe 0.2 opened the 80 gate before any live trade in 3.0% of paths; with every test logged, 0%. Replay: had test 31 been logged when earnings_gap_structure had 3 live trades, its score would have been 73 instead of 92 (above the QUANTANAMO 80 gate).

**STATISTICS.** Logging only survivors is selection on the outcome: the logged mean is biased up by about E[max of M] standard errors (1.19 SE for M = 5, 1.83 SE for 17 trials). Counting failures removes the selection; deflating by trials removes what remains of it for tests chosen from many variants. Weight min(0.5 x n, 20) and the 50% shrink are unchanged and apply to either sign, so a negative mean moves the score exactly as much as the same positive mean (earnings_gap_structure: 52 with test 31 as logged vs 55 with the sign flipped, around 54 for a zero-mean test). Survivors-only tests count at half weight because the missing names are not missing at random (test 31: 35% of events had no bars; booking them at -50% gives deflated Sharpe -0.77), but the sign is kept. The 0.25 sd floor in the results score (outcome-rescore-confidence) still caps how much any backtest can move a score: 714 trades at sd 6.2% count like 10 live trades at sd 25%.

**INCENTIVES / GAMING.** The old rule only added credit: run many tests, log the winner, and a failure costs nothing. Now a completed preregistered test is evidence either way, rows are append-only for stewards (no update, no inactive insert, one row per test), and `v_backtest_tests_unlogged` shows any completed preregistered thesis test without a row. The rules-lock time, results time and trial count are copied from the linked `strategy_tests` row by the insert trigger (preregistered_at, tested_at, trial_number), so a steward can't back-date a lock; a test can only be logged against its own thesis and only once it has finished. Remaining lever: a steward can skip preregistration (then the test doesn't count either way, and the steward loses the credit too). Deflation by trials means an honest steward who logs a long search is not rewarded for its best trial.

## Evidence
tools/court/evidence.py (evidence.json; SIMULATION.md, section Backtest evidence both ways): 5 preregistered 200-trade tests per thesis, 1,500 paths, QUANTANAMO and BANDIT at Sharpe 0, 0.1 and 0.2, plus the replay of earnings_gap_structure. Test 31 (cycle 52, trial 17, run 243, artifacts 88-94, scenarios 153-156, lesson 79): earnings_gap_structure as traded, buy the regular close before the print and sell the day-0 open, $9.82-$320, 20-day dollar volume $0.5M-$1.3B, 30 bps costs, 2022-2024: 714 trades, hit 49.0%, mean -0.35%, sd 6.2%, deflated Sharpe -0.12 (60 bps: -0.17), survivors only (35% of events missing; -0.77 under a hypothetical -50% on the missing events). Logged as negative evidence: weight 10, deflated mean -0.77%; results score 56 -> 52. Before this ruling the test couldn't be logged at all.

## Ruling
**AMEND.** Amend (2026-09-27): every completed, preregistered, out-of-sample, cost-inclusive test is logged and counts, pass or fail, with the same weighting either way; rules must be locked before results; means are deflated by trials; survivors-only tests count at half weight; rows are append-only for stewards. Enacted in migration 46, which logs test 31 against earnings_gap_structure and re-scores it (56 -> 52). Was (migration 37): one active row per thesis, only a surviving test with deflated Sharpe > 0.

Amendment: thesis_backtest_evidence gains rules_locked_at, results_at (check rules_locked_at < results_at), trials (>= 1), survivors_only, missing_share, hit_rate, deflated_sharpe, passed and trigger-derived weight, trial_deflation, mean_ret_deflated; the one-active index becomes one row per (thesis, test); stewards lose update and can't insert inactive rows. private.thesis_edge_evidence pools all counted rows (weight capped at 20) with no pass requirement.

| Growth cost | Ruin-risk reduction |
|---|---|
| Positive but bounded: a real Sharpe-0.2 edge is proven 4-7 trades later than with honest credit-only (P(2x) QUANTANAMO 39.5% -> 35.0%), mostly from trial deflation of every pooled test. | False proofs of a zero-edge thesis within a year 43% -> 27% (QUANTANAMO) and 63% -> 50% (BANDIT); no path opens the 80 gate from backtests alone. |

## Interactions
edge-max-stake, outcome-rescore-confidence, quantanamo-80-gate.
