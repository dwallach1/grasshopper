# Outcome re-score of thesis confidence (Beta on hit rate; cap 60 / demote at n >= 5 with negative P/L)

`rule_id: outcome-rescore-confidence` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review David decision · **needs David**

## Purpose (failure prevented)
Tempers a steward's stated confidence with realized outcomes. Feeds the QUANTANAMO >= 80 gate and hardening/forming status.

## Mechanism
confidence = (10 x stated + wins) / (10 + n). If n >= 5 and summed P/L < 0: cap at 60 and demote hardening -> forming. `private.outcome_posterior_confidence`.

Code paths:
- `supabase/schemas/11_outcome_rescore_sizing.sql`

## The court

**GROWTH.** Hit rate isn't edge. QUANTANAMO's style wins big and loses small (winners avg +30% of stake, losers -11%; breakeven hit rate 27%). A thesis hitting 35% at that payoff earns ~+3.2% per trade, but its confidence converges to 35 and it can never pass the 80 gate. The 5-trade demotion blocks 41% of genuinely good theses (true Sharpe 0.1/trade) and 33% at Sharpe 0.2.

**RUIN.** Small: bad theses are already small via max_stake, and demotion only affects QUANTANAMO autonomy.

**STATISTICS.** Five trades can't tell a Sharpe-0.1 thesis from zero: P(sum < 0) = Phi(-0.1 sqrt 5) = 41%. A hit-rate Beta prior ignores payoff asymmetry.

**INCENTIVES / GAMING.** Pushes a steward toward high-hit-rate, low-payoff trades (take profits early, let losers run) just to keep confidence high: the opposite of what compounds.

## Evidence
Closed-form above; ledger payoff stats (QUANTANAMO 7 trades: hit 29%, payoff ratio 2.7).

## Ruling
**AMEND.** Amend (recommended), but it changes which theses pass David's 80 gate, so it isn't shipped.

Amendment: Proposed: confidence = stated tempered by P(mean return > 0) from the same shrunken moments as edge-max-stake (including backtest credit). Demote only when the upper bound is below zero (mean + sd/sqrt(n) < 0) or n >= 10 with mean < 0.

| Growth cost | Ruin-risk reduction |
|---|---|
| Current rule: large (blocks asymmetric theses permanently). | Current rule: small. |

## Interactions
quantanamo-80-gate, edge-max-stake, backtest-evidence-credit.
