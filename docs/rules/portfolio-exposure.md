# Portfolio exposure: open risk to invalidation <= 10% of book

`rule_id: portfolio-exposure` · status: **in_force** · verdict: **amend** · ruling 2026-09-26 · next review 2026-10-26

## Purpose (failure prevented)
Per-entry caps don't bound total or correlated exposure across open lots.

## Mechanism
`private.steward_open_risk`: open risk = sum over open lots of qty x max(mark - invalidation_price, 0) in the book unit (no invalidation: full qty x mark; unmarked: 0, flagged). Budget 10% of book. Guidance (6th arg p_entry_price) sizes a new entry to fit: min(requested, max_stake, cash, headroom / ((entry - invalidation) / entry)); without an entry price the whole notional counts as risk; no headroom -> `exposure_cap`. `public.v_exposure_usage` and v_ledger_watchdog (`exposure_over_budget`, `exposure`) report usage.

Code paths:
- `supabase/schemas/41_court_decisions.sql`

## The court

**GROWTH.** Any cap here limits concentration into the best ideas.

**RUIN.** QUANTANAMO holds ~91% of book in 3 lots at the 9/25 marks (NBIS $1,107, CIFR $1,122, CODA $2,780). Risk to the written invalidations is $654 (11.9% of book: NBIS $161, CIFR $186, CODA $308), already over a 10% budget. (The earlier ~$170 / 3.1% figure was wrong.) A correlated gap through the stops is the real tail; the sequential MC can't see it.

**STATISTICS.** Needs a correlation estimate by theme; with n this small, use theme membership as the proxy.

**INCENTIVES / GAMING.** Without it, a steward can stack correlated starters across several theses.

## Evidence
Open position_episodes 2026-09-26.

## Ruling
**AMEND.** Enact option (b) at R = 10% (migration 41; decided 2026-09-26 by the parent agent under David's delegation). On enactment QUANTANAMO is at 11.9% and new entries are blocked (`exposure_cap`) until risk falls (exits, or raising invalidations toward marks); ODDSBORNE and BANDIT have no open lots (0%).

Amendment: Open risk to invalidation <= 10% of book per steward; guidance sizes down or blocks.

| Growth cost | Ruin-risk reduction |
|---|---|
| Caps stacking; at a 10% invalidation distance it still allows ~100% of book in positions. | Bounds the loss if every open lot hits its invalidation at once to 10% of book (gaps excepted). |

## Interactions
cash-only-no-margin, required-invalidation, edge-max-stake.
