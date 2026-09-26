# Portfolio-level exposure / correlation budget

`rule_id: portfolio-exposure` · status: **proposed** · verdict: **amend** · ruling 2026-09-26 · next review David decision · **needs David**

## Purpose (failure prevented)
Per-entry caps don't bound total or correlated exposure across open lots.

## Mechanism
Not in force. Options below.

Code paths:
- (not in force)

## The court

**GROWTH.** Any cap here limits concentration into the best ideas.

**RUIN.** QUANTANAMO holds ~82% of book in 3 lots (NBIS, CIFR, CODA; neocloud_compute alone is ~36%). Risk to the written invalidations is ~$170 (3.1% of book), but a correlated gap through the stops (the neocloud names move together) is the real tail. The sequential MC can't see it.

**STATISTICS.** Needs a correlation estimate by theme; with n this small, use theme membership as the proxy.

**INCENTIVES / GAMING.** Without it, a steward can stack correlated starters across several theses.

## Evidence
Open position_episodes 2026-09-26.

## Ruling
**AMEND.** Proposed; David decision. Options: (a) none (today); (b) open risk-to-invalidation budget <= R% of book (R = 6% or 10%; today 3.1% passes); (c) per-theme open cost <= X% of book (X = 40% would block adds to earnings_gap_structure, at 46% via CODA).

Amendment: None shipped.

| Growth cost | Ruin-risk reduction |
|---|---|
| Depends on option. | Depends on option. |

## Interactions
cash-only-no-margin, new-thesis-escape.
