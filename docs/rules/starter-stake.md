# Starter stake for unproven theses (equal 3% book risk per bet)

`rule_id: starter-stake` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-10-10

## Purpose (failure prevented)
Lets an unproven thesis trade (learning comes from trade count, not size) without a big loss before there is evidence.

## Mechanism
starter = 0.03 x current book / steward bet volatility (`private.steward_bet_vol`: sd of return on stake over the steward's closed priced non-paper trades, floored at 0.25; 1.0 while n < 5), x the steward drawdown scale. On 2026-09-26: QUANTANAMO sd 0.222 -> floor 0.25 -> 12% of book = $660; BANDIT sd 0.449 -> 6.68% = 0.1205 SOL (x0.987 = 0.119); ODDSBORNE sd 1.957 -> 1.53% = $4.24 (x0.5 = $2.12). History: fixed dollars ($250 / $15 / 0.10 SOL) until migration 37, then the same as a book share until migration 41.

Code paths:
- `supabase/schemas/22_edge_scaled_stake.sql`
- `supabase/schemas/37_court_rulings.sql`
- `supabase/schemas/41_court_decisions.sql`

## The court

**GROWTH.** A fixed-dollar starter never compounds: after a 2x the starter is 2.5% of book, not 5%. A book-share starter keeps pace with the book. The starter LEVEL is the bigger growth question. A flat ~5% of book is a very different risk per steward: book volatility per unproven trade is ~1.25% for QUANTANAMO (stocks with stops, sd of return on stake 0.22-0.25), 2.5% for BANDIT (sd 0.45) and 10.6% for ODDSBORNE (binary, sd 1.96).

**RUIN.** Fixed dollars get riskier as the book shrinks. MC at zero edge: ODDSBORNE ruin 10.1% with the fixed $15, 0.1% with a book share.

**STATISTICS.** The starter should be calibrated to stake volatility, not a flat %. A vol-normalized starter, stake = v x book / sd(return on stake), gives every steward the same book risk per unproven bet.

**INCENTIVES / GAMING.** With a flat %, the steward whose instruments are most volatile gets the most book risk per bet (ODDSBORNE). Vol-normalizing removes that tilt.

## Evidence
MC (grid2.json): QUANTANAMO at Sharpe 0.1/0.2, P(2x in a year) is 10.7%/44.7% at today's starter vs 18.5%/55.6% at v = 4% (16% of book), with P(DD50) <= 0.3% either way (<= 1.5% with a 5% chance of a -40% gap per trade). ODDSBORNE at zero edge: P(DD50) 50.8% at today's 5.4% vs 1.1% at v = 4% (2.0% of book).

## Ruling
**AMEND.** Amend (shipped in two steps): book share, not fixed dollars (37); level set to equal risk per bet at v = 3% (41, decided 2026-09-26 by the parent agent under David's delegation). The 0.25 sd floor stops a lucky low-variance sample from inflating the starter (max starter 12% of book).

Amendment: starter = 0.03 x book / max(steward sd of return on stake, 0.25) (1.0 while the steward has < 5 trades), x drawdown scale. Proven theses keep half-Kelly on the LCB, never below the starter.

| Growth cost | Ruin-risk reduction |
|---|---|
| Negative for QUANTANAMO ($250 -> $660: MC P(2x) at Sharpe 0.2 rises from 44.7% toward the v = 3-4% range); ODDSBORNE smaller ($15 -> $4.24 before scale). | ODDSBORNE zero-edge P(DD50) 50.8% at 5.4% of book vs ~1-2% at v = 3-4%; QUANTANAMO P(DD50) stays <= 1.5% with gap stress. |

## Interactions
edge-max-stake, drawdown-scaling.
