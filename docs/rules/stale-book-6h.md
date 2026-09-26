# Entries need a book observation <= 6 hours old

`rule_id: stale-book-6h` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review 2027-03-26

## Purpose (failure prevented)
Sizing uses the real book and cash, not a stale snapshot (a stale high book would oversize).

## Mechanism
Guidance returns stale_book when the older of the equity and cash observations is > 360 minutes old.

Code paths:
- `supabase/schemas/22_edge_scaled_stake.sql`

## The court

**GROWTH.** Near zero: the steward records a fresh snapshot before trading (one call).

**RUIN.** Prevents sizing off a book that already fell.

**STATISTICS.** n/a.

**INCENTIVES / GAMING.** None; the fix is one snapshot write.

## Evidence
Structural.

## Ruling
**UPHOLD.** Uphold.

Amendment: None.

| Growth cost | Ruin-risk reduction |
|---|---|
| ~0. | Small-moderate. |

## Interactions
starter-stake, drawdown-scaling (both read the book).
