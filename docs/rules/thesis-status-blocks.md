# Killed, rejected or unknown thesis blocks new entries

`rule_id: thesis-status-blocks` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review 2027-03-26

## Purpose (failure prevented)
A falsified or rejected idea (or a typo'd id) can't size an entry.

## Mechanism
Guidance: unknown_thesis, thesis_rejected, thesis_killed; sized_notional = 0. A retired thesis blocks the same way (entry_blocked_reason thesis_killed, sized_notional 0). Retired is its own status. It is not a kill.

Code paths:
- `supabase/schemas/21_unknown_thesis_gate.sql`
- `supabase/schemas/22_edge_scaled_stake.sql`
- `supabase/schemas/85_retired_strategy_tests_theses.sql`

## The court

**GROWTH.** None: a killed thesis has no edge by definition.

**RUIN.** Stops trading a falsified idea.

**STATISTICS.** n/a.

**INCENTIVES / GAMING.** Can't be escaped by tagging with a non-existent id.

## Evidence
Structural.

## Ruling
**UPHOLD.** Uphold.

Amendment: None.

| Growth cost | Ruin-risk reduction |
|---|---|
| None. | Moderate. |

## Interactions
new-thesis-escape.
