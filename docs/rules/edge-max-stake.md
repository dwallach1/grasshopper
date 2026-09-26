# Edge-scaled max stake (proven-edge growth)

`rule_id: edge-max-stake` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-10-26

## Purpose (failure prevented)
Stops an unbounded requested size (the $200 Miami bet on a $490 book) while letting a proven edge compound.

## Mechanism
`private.edge_max_stake`: unproven (n < 10 or LCB <= 0) gets the starter; proven gets max(starter, min(book x 0.5 x LCB / sd^2, starter x 2^(1 + (n - 10) / 5))). LCB = mean - sd/sqrt(n) of return on stake. `sized_notional = min(requested, max_stake, cash)`.

Code paths:
- `supabase/schemas/22_edge_scaled_stake.sql`
- `supabase/schemas/23_edge_stake_reason.sql`
- `supabase/schemas/37_court_rulings.sql`
- `supabase/schemas/38_edge_max_stake_null_thesis.sql`

## The court

**GROWTH.** Once proven, the cap is half-Kelly on the lower bound, which is the growth-optimal size under parameter uncertainty (full Kelly on a noisy mean overbets). The doubling-per-5-trades brake lets a real edge reach ~40% of book by n = 20. At Sharpe 0.2/trade the proposed rules reach a median 28x (BANDIT) and 8x (ODDSBORNE) in a year.

**RUIN.** Without it, size is whatever the steward requests. ODDSBORNE's 40%-of-book loss on 2026-09-20 is the case it prevents. Half-Kelly on LCB never bets more than half the edge-optimal fraction.

**STATISTICS.** The 1-sigma LCB with continuous monitoring falsely marks a zero-edge thesis proven in 47-69% of MC paths within a year. A 2-sigma bound cuts that to 9-23%, but it delays real proof (QUANTANAMO at Sharpe 0.2: 14 -> 38 trades) and cuts BANDIT's median growth at Sharpe 0.2 from 28.4x to 9.8x. With drawdown scaling as the backstop, false proofs cost little: P(DD50) at zero edge is 9.3% at 1 sigma vs 4.7% at 2 sigma.

**INCENTIVES / GAMING.** A steward could inflate `requested` to get more size. That no longer helps: the cap binds, and the multiplier that rewarded inflation is struck (see confidence-multiplier). Only closed, priced, non-paper trades count, so the n gate can't be padded with paper trades.

## Evidence
MC grid (tools/court/grid.json, grid2.json). Live: every thesis is unproven today (max n = 6 per thesis; BANDIT has 35 at steward level with LCB -7.4%).

## Ruling
**AMEND.** Uphold the proven-edge formula at 1 sigma. Amend so n and the moments include discounted backtest evidence (backtest-evidence-credit) and so the cap is multiplied by the steward drawdown scale instead of per-thesis loss halving.

Amendment: n_eff = n_live + min(0.5 x n_backtest, 20), with the backtest mean haircut 50%. The cap is multiplied by the scale from `private.steward_drawdown`. The starter is a share of current book.

| Growth cost | Ruin-risk reduction |
|---|---|
| None vs current; raises growth (loss halving removed). | Bounds every entry; half-Kelly on LCB. |

## Interactions
starter-stake, drawdown-scaling, backtest-evidence-credit, confidence-multiplier, entry-cap-snapshot.
