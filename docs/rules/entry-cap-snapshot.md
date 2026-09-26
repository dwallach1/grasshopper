# Cap-at-entry snapshot and ledger watchdog

`rule_id: entry-cap-snapshot` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review 2027-03-26

## Purpose (failure prevented)
Every entry is audited against the cap in force when it was made. Breaches and missing invalidations surface twice a day.

## Mechanism
`max_stake_at_entry` trigger; `v_ledger_integrity` (entry_over_max_stake at > 1.10x); `v_invalidation_breaches`; `v_open_lots_missing_invalidation`; `v_ledger_watchdog`.

Code paths:
- `supabase/schemas/24_ledger_watchdog.sql`
- `supabase/schemas/30_max_stake_at_entry.sql`

## The court

**GROWTH.** None (measurement).

**RUIN.** Catches rule bypasses.

**STATISTICS.** n/a.

**INCENTIVES / GAMING.** Makes bypass visible.

## Evidence
Live counts in the health routine.

## Ruling
**UPHOLD.** Uphold.

Amendment: None.

| Growth cost | Ruin-risk reduction |
|---|---|
| None. | Detective. |

## Interactions
edge-max-stake.
