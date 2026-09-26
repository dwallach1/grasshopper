# Per-thesis consecutive-loss halving (x0.5 per loss, floor x0.25)

`rule_id: loss-streak-halving` · status: **repealed** · verdict: **strike** · ruling 2026-09-26 · next review 2026-12-26

## Purpose (failure prevented)
Meant to cut size when a thesis is failing.

## Mechanism
`private.edge_max_stake` multiplied the cap by 0.5^min(loss_streak, 2).

Code paths:
- `supabase/schemas/23_edge_stake_reason.sql`
- `supabase/schemas/37_court_rulings.sql`

## The court

**GROWTH.** It cuts size right after losses, regardless of edge. Under the same starter, MC growth with halving vs drawdown scaling: BANDIT at Sharpe 0.1 median 1.74x vs 1.98x, P(2x) 52.5% vs 62.9%; at Sharpe 0.2 17.8x vs 28.4x. QUANTANAMO at Sharpe 0.2: P(2x) 33% vs 44.7%.

**RUIN.** Drawdown scaling gives the same or better ruin protection: BANDIT P(DD50) 12.5% (halving) vs 9.9% (drawdown) at Sharpe 0.1, and 11.3% vs 9.3% at zero edge. For ODDSBORNE at a 5.4% starter, halving has the lower P(DD50) (42% vs 51% at zero edge), but only because it shrinks an oversized starter. A correctly sized ODDSBORNE starter makes both ~0%.

**STATISTICS.** Loss streaks carry no information: BANDIT P(loss | previous loss) 0.53 vs P(loss) 0.51, lag-1 autocorrelation 0.004 over 35 trades. The edge estimate (LCB) already absorbs the losses. Halving punishes the same evidence twice.

**INCENTIVES / GAMING.** It's per thesis, so a steward escapes it by registering a new thesis (the new-thesis escape). It also rewards cutting a loser early to reset the streak, whatever the thesis's real invalidation says.

## Evidence
Ledger autocorrelation (tools/court). MC grid2 book5_halving vs book5_ddscale. Replay of real sequences (replay.json): BANDIT +2.6% with halving vs -0.7% with the proposed rules, on one 35-trade path. That's inside noise; the MC is the evidence.

## Ruling
**STRIKE.** Strike. Replace with steward-level drawdown scaling (drawdown-scaling).

Amendment: Removed from `private.edge_max_stake`. `loss_streak` stays in the stats for information.

| Growth cost | Ruin-risk reduction |
|---|---|
| Removing it raises growth (BANDIT median +14% at Sharpe 0.1). | Replaced by drawdown scaling, which has equal or lower P(DD50) at the same starter. |

## Interactions
drawdown-scaling, new-thesis-escape.
