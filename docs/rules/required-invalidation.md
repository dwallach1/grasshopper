# Required invalidation on entry (guidance + table trigger)

`rule_id: required-invalidation` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review 2027-03-26

## Purpose (failure prevented)
Every lot has a written, priced falsifier before money goes in, so exits aren't improvised.

## Mechanism
Guidance returns missing_invalidation without p_invalidation_price > 0. `private.require_lot_invalidation` rejects a new or re-opened open lot without one.

Code paths:
- `supabase/schemas/22_edge_scaled_stake.sql`

## The court

**GROWTH.** No cost: any trade can state an invalidation. It's also the input a risk-based starter would need.

**RUIN.** Prevents open-ended holds of broken trades. BANDIT's -100% rugs (GTA6, ACAT) show a stop doesn't cap loss in illiquid coins. That's handled by stake size, not by this rule.

**STATISTICS.** n/a (process rule).

**INCENTIVES / GAMING.** A steward could set an absurdly far invalidation. Guidance only checks > 0, and the ODDSBORNE script checks 0 < inval < price. Follow-up: pass the entry price to guidance so it can reject inval >= entry for longs.

## Evidence
All open lots carry one (watchdog v_open_lots_missing_invalidation = 0).

## Ruling
**UPHOLD.** Uphold.

Amendment: Follow-up (not shipped): entry-price sanity check.

| Growth cost | Ruin-risk reduction |
|---|---|
| None. | Moderate (process). |

## Interactions
regular-session-invalidation, starter-stake.
