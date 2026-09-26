# Equity invalidation exits fire only on regular-session prints

`rule_id: regular-session-invalidation` · status: **in_force** · verdict: **uphold** · ruling 2026-09-26 · next review 2027-03-26

## Purpose (failure prevented)
Avoid full-lot exits on thin pre/after-hours prints; those set review_at_open instead.

## Mechanism
Monitor policy autonomous-position-v5, `private.is_us_regular_session` with the NYSE holiday/early-close calendar. Coins and PM are 24/7, with no session filter.

Code paths:
- `workers/research/src/position-decision.ts`
- `supabase/schemas/29_us_market_calendar.sql`
- `packages/contracts/src/market-calendar.ts`

## The court

**GROWTH.** Avoids selling a good lot on a spurious extended-hours print (CODA trades thin).

**RUIN.** Small cost: a real overnight break is acted on at the open, and the review flag makes sure it is. Market orders can't fill after hours anyway (broker is RTH-only).

**STATISTICS.** Extended-hours prints are few, wide-spread trades; a single print isn't a price.

**INCENTIVES / GAMING.** None.

## Evidence
Structural.

## Ruling
**UPHOLD.** Uphold.

Amendment: None.

| Growth cost | Ruin-risk reduction |
|---|---|
| None. | Neutral. |

## Interactions
required-invalidation.
