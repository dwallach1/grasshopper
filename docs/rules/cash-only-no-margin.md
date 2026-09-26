# Cash only: no margin, no leverage

`rule_id: cash-only-no-margin` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review 2027-03-26

## Purpose (failure prevented)
Worst case is losing the stakes. The book can't go negative or be force-liquidated.

## Mechanism
sized_notional <= spendable cash (min(cash, buying power)); the broker rejects buys needing margin.

Code paths:
- `supabase/schemas/14_no_position_cap.sql`
- `workers/broker/src/robinhood-broker-agent.ts`

## The court

**GROWTH.** Caps total exposure at 1x book. For a proven edge, half-Kelly on LCB rarely asks for more than 1x in these books.

**RUIN.** Removes the one path to losing more than the book.

**STATISTICS.** n/a.

**INCENTIVES / GAMING.** None.

## Evidence
Standing preference (David).

## Ruling
**UPHOLD.** Uphold.

Amendment: None.

| Growth cost | Ruin-risk reduction |
|---|---|
| Small. | Large (eliminates negative-equity paths). |

## Interactions
portfolio-exposure.
