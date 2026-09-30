# QUANTANAMO autonomous-entry gate: hardening thesis with results score >= 80

`rule_id: quantanamo-80-gate` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-11-30

## Purpose (failure prevented)
David approves anything below 80; autonomy only for strong theses.

## Mechanism
`steward_sizing_guidance`: QUANTANAMO entry_allowed needs status = hardening and `results_basis.gate_score` >= 80 (reason `quantanamo_unscored` when unscored, else `quantanamo_confidence_gate`). gate_score = round(100 x Phi(z x sqrt(n_live / (n_live + 16)))), where z is the results-score z (outcome-rescore-confidence). A neutral prior of 16 zero-mean trades: at 3 live trades the gate needs a raw score near 98, at 40 trades near 84, and it fades toward the raw 80. The shown results_confidence is unchanged, and only the re-score writes either number. Backtests count in z but not in the prior, and still can't open the gate alone: no score below 3 live trades (migration 47).

Code paths:
- `supabase/schemas/22_edge_scaled_stake.sql`
- `supabase/schemas/41_court_decisions.sql`
- `supabase/schemas/48_quantanamo_gate_small_sample.sql`
- `docs/scheduled-run-prompt.md`

## The court

**GROWTH.** The gate does not size the bet, so doubling odds do not move. One year, 1,500 paths, current stake rule, no backtests: Sharpe 0 median 0.952x and P(2x) 3.3%; Sharpe 0.2 median 1.87x and P(2x) 54.1%; Sharpe 0.4 median 53.94x and P(2x) 99.5%. The cost is time to autonomy, not size: median live trades until the gate opens goes from 9 to 21 at Sharpe 0.2 (still open by trade 80 on 89.4% of paths) and from 6 to 12 at Sharpe 0.4 (99.8% open by 80). A lower-bound gate (z - 0.84) would have left a Sharpe-0.2 thesis unautonomous past 80 trades 36% of the time (censored median 53). This prior does not.

**RUIN.** False opens before 10 live trades fall from 31.0% to 8.5% at zero edge. Book ruin stays 0. P(drawdown >= 50%) stays 0.3% at Sharpe 0, 0.4% at Sharpe 0.2, and 0.1% at Sharpe 0.4, because size is unchanged. The size risk was already bounded by max_stake.

**STATISTICS.** The shown score stays P(expected return per trade > 0) >= 0.8 (z >= 0.84). Reading it straight made a small sample look sure: with the spread floored at 0.25, three lucky trades clear z = 0.84 far too often, and the gate is re-checked after every trade, so the chance it has opened at some point before 10 live trades is 31% at zero edge (4,000 paths; earnings_gap_structure itself scored 92 after 3 trades with no backtest). The gate now uses z x sqrt(n_live / (n_live + 16)), the posterior z under a normal prior of 16 zero-mean trades with the same spread. That is not a fixed rail: the bar falls toward 80 as live trades accumulate (about 98 at n = 3, 84 at n = 40, 82 at n = 100). A fixed lower bound (z - 0.84, gate only) also got under 10% false opens but left a Sharpe-0.2 thesis unautonomous past 80 trades 36% of the time. Requiring the raw score to hold for 4 re-scores in a row landed at 10.7%.

**INCENTIVES / GAMING.** Stated confidence still can't open the gate, and neither can the shown score on its own. gate_score is written only by the re-score, into results_basis, which the results guard already protects. Logging backtests can't spend the prior down: the fade uses n_live, while backtest weight only enters z, and a fake +0.2 Sharpe backtest cuts false opens further (26.9% -> 5.8%) rather than reopening the hole. There is no minimum trade count to wait out and no cap to route around.

## Evidence
tools/court/gate80.py (gate80.json; SIMULATION.md, section Small-sample 80 gate). 4,000 paths on the centered QUANTANAMO ledger returns. False opens before 10 live trades: 31.0% raw, 8.5% with prior 16. Median trades until the gate opens, Sharpe 0.2: 9 -> 21 (89% still open within 80 trades); Sharpe 0.4: 6 -> 12 (99.8% within 80). Sizing is untouched, so doubling odds don't move (1,500 paths, one year): Sharpe 0.2 median 1.87x, P(2x) 54.1%; Sharpe 0.4 median 53.9x, P(2x) 99.5%; ruin 0. Ledger replay in the ruling file.

## Ruling
**AMEND.** Amend (2026-09-30, migration 48): the 80 threshold stays, but the gate reads a small-sample-shrunk score, not the shown results score. False opens before 10 live trades 31% -> 8.5%, and a real edge still reaches autonomy near when its expected evidence would have cleared 80 (Sharpe 0.2 median 21 live trades, Sharpe 0.4 median 12). No live score moves and no thesis opens the gate. Was (migration 41): gate on the raw results score, which a zero-edge thesis cleared on luck with 3-9 trades.

Amendment: private.thesis_results_score gains gate_score = round(100 x Phi(z x sqrt(n_live / (n_live + 16)))). The re-score stores it on results_basis (gate_score, gate_prior 16) and still writes results_confidence as the unshrunk score. steward_sizing_guidance opens the QUANTANAMO gate on status = hardening and gate_score >= 80. Shown scores are not rewritten except to add the new basis keys.

| Growth cost | Ruin-risk reduction |
|---|---|
| None on the book: the gate does not size the bet, so P(2x) is unchanged (Sharpe 0.2: 54.1%, median 1.87x; Sharpe 0.4: 99.5%, median 53.9x). Autonomy is later, not smaller: median trades to open 9 -> 21 at Sharpe 0.2 and 6 -> 12 at Sharpe 0.4. | False opens before 10 live trades 31.0% -> 8.5% (inside the 10% target). Book ruin stays 0, since size is unchanged. |

## Interactions
outcome-rescore-confidence, new-thesis-escape, backtest-evidence-credit.
