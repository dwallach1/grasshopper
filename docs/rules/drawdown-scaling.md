# Steward-level drawdown scaling

`rule_id: drawdown-scaling` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-10-26

## Purpose (failure prevented)
Cuts risk when the BOOK is in trouble (the thing that can actually be ruined), not when one thesis label had a streak.

## Mechanism
scale = 1.0 at <= 10% below the steward's closing high-water mark, falling linearly to 0.5 at >= 40%. The HWM is the max of each UTC day's last book observation, used because intraday entry-time snapshots include double-count artifacts. It multiplies every thesis's cap, proven or not. `private.steward_drawdown`.

Code paths:
- `supabase/schemas/37_court_rulings.sql`

## The court

**GROWTH.** No cost in normal noise (<= 10%). The floor of 0.5 keeps a recovering book trading at half size, so recovery isn't choked. MC growth equals or beats halving everywhere at the same starter.

**RUIN.** Anti-martingale at the book level: sizes shrink as the book approaches ruin. BANDIT MC at zero edge: P(DD50) 35.9% with no control vs 9.3% with drawdown scaling; ODDSBORNE ruin 7.4% vs 0.1%.

**STATISTICS.** Uses the book path, which is the actual ruin variable. No thesis-level noise. The 10% dead band sits above normal noise (QUANTANAMO's worst close-to-close drawdown is 16%; BANDIT's intraday swings reach 30%).

**INCENTIVES / GAMING.** Steward-wide, so it can't be escaped with a new thesis. Deposits would reset the HWM mechanics; none have happened. A deposit should be recorded as a flow before this rule reads it.

## Evidence
Live on 2026-09-26: QUANTANAMO HWM $6,098.56 -> 9.8% below -> x1.00; ODDSBORNE HWM $524.76 -> 47.2% below -> x0.50; BANDIT HWM 2.0207 SOL -> 10.8% below -> x0.987.

## Ruling
**AMEND.** Enact.

Amendment: New rule (migration 37).

| Growth cost | Ruin-risk reduction |
|---|---|
| 0 inside a 10% drawdown; x0.5 at worst. | BANDIT P(DD50) 35.9% -> 9.3%; ODDSBORNE ruin 7.4% -> 0.1% (zero edge). |

## Interactions
Replaces loss-streak-halving; closes new-thesis-escape; multiplies edge-max-stake.
