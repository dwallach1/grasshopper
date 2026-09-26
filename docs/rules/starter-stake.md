# Starter stake for unproven theses

`rule_id: starter-stake` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-10-10 · **needs David**

## Purpose (failure prevented)
Lets an unproven thesis trade (learning comes from trade count, not size) without a big loss before there is evidence.

## Mechanism
Was fixed dollars: QUANTANAMO $250, ODDSBORNE $15, BANDIT 0.10 SOL. Now a share of the current book: 4.545% / 5.418% / 5.546%. That is today's values re-expressed, so nothing changes at today's book.

Code paths:
- `supabase/schemas/22_edge_scaled_stake.sql`
- `supabase/schemas/37_court_rulings.sql`

## The court

**GROWTH.** A fixed-dollar starter never compounds: after a 2x the starter is 2.5% of book, not 5%. A book-share starter keeps pace with the book. The starter LEVEL is the bigger growth question. A flat ~5% of book is a very different risk per steward: book volatility per unproven trade is ~1.25% for QUANTANAMO (stocks with stops, sd of return on stake 0.22-0.25), 2.5% for BANDIT (sd 0.45) and 10.6% for ODDSBORNE (binary, sd 1.96).

**RUIN.** Fixed dollars get riskier as the book shrinks. MC at zero edge: ODDSBORNE ruin 10.1% with the fixed $15, 0.1% with a book share.

**STATISTICS.** The starter should be calibrated to stake volatility, not a flat %. A vol-normalized starter, stake = v x book / sd(return on stake), gives every steward the same book risk per unproven bet.

**INCENTIVES / GAMING.** With a flat %, the steward whose instruments are most volatile gets the most book risk per bet (ODDSBORNE). Vol-normalizing removes that tilt.

## Evidence
MC (grid2.json): QUANTANAMO at Sharpe 0.1/0.2, P(2x in a year) is 10.7%/44.7% at today's starter vs 18.5%/55.6% at v = 4% (16% of book), with P(DD50) <= 0.3% either way (<= 1.5% with a 5% chance of a -40% gap per trade). ODDSBORNE at zero edge: P(DD50) 50.8% at today's 5.4% vs 1.1% at v = 4% (2.0% of book).

## Ruling
**AMEND.** Amend (shipped): book share, not fixed dollars. The starter LEVEL (vol-normalized v) is a risk-budget choice for David, so it is not shipped. See docs/rules/SIMULATION.md for the options.

Amendment: starter = share x current book equity, shares QUANTANAMO 0.04545, ODDSBORNE 0.05418, BANDIT 0.05546 (= the 2026-09-26 dollar starters / that day's book).

| Growth cost | Ruin-risk reduction |
|---|---|
| None today; compounds after gains. | Shrinks with the book: ODDSBORNE MC ruin 10.1% -> 0.1%. |

## Interactions
edge-max-stake, drawdown-scaling.
