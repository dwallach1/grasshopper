# Out-of-sample backtest evidence counts toward proven edge

`rule_id: backtest-evidence-credit` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-11-26

## Purpose (failure prevented)
Caps shouldn't wait for 10 live trades when a thesis has real out-of-sample evidence.

## Mechanism
`public.thesis_backtest_evidence` (one active row per thesis; out_of_sample and costs_included required; linked to a `strategy_tests` row with status survived and deflated Sharpe > 0). It adds min(0.5 x n, 20) effective trades, with its mean return haircut 50%, to the thesis's live moments in `private.edge_max_stake`.

Code paths:
- `supabase/schemas/37_court_rulings.sql`
- `supabase/schemas/38_edge_max_stake_null_thesis.sql`

## The court

**GROWTH.** Faster proof when the edge is real: BANDIT at Sharpe 0.2 is proven in 7 trades vs 13; QUANTANAMO 11 vs 14.

**RUIN.** Low. An overfit backtest showing a fake +0.2 Sharpe proves a zero-edge thesis early (6-7 trades), but P(DD50) moves only 9.3% -> 9.7% (BANDIT) because of the haircut, the 20-trade limit, LCB-Kelly and drawdown scaling. Live losses quickly outweigh the credit.

**STATISTICS.** Weight 0.5 and a 50% mean haircut are standard discounts for backtest optimism (selection and overfitting). Only out-of-sample, cost-inclusive results from a surviving strategy test with deflated Sharpe > 0 count.

**INCENTIVES / GAMING.** A steward could cherry-pick a backtest. That's mitigated by requiring out_of_sample = true, a linked surviving strategy_tests row, the haircut and the limit, and the rows are auditable on the desk.

## Evidence
MC grid2 backtest runs (bt30_w.5_h.5).

## Ruling
**AMEND.** Enact with conservative parameters.

Amendment: New rule (migration 37).

| Growth cost | Ruin-risk reduction |
|---|---|
| Negative (speeds proof). | Neutral-slightly negative (quantified above). |

## Interactions
edge-max-stake, outcome-rescore-confidence.
